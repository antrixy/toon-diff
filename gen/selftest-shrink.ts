// gen/selftest-shrink.ts
//
// Proves the shrinker. No Python needed: a synthetic predicate plus MOCK adapters
// carrying planted bugs stand in for the real matrix, so every property is checked
// here, deterministically.
//
// Proven:
//   1. FAILURE PRESERVED + MINIMAL  -- a needle buried in a huge structure reduces
//      to just the needle; the result still satisfies the predicate; one more
//      reduction step finds nothing (1-minimal).
//   2. REAL-SHAPED PREDICATE        -- via captureSignatures/makeInteresting over a
//      mock f64 adapter, a bloated case reduces to the minimal number reproducer.
//   3. DDMIN                        -- a 500-element array collapses to the minimal
//      length that still triggers the bug.
//   4. NO SLIPPAGE                  -- a case carrying TWO bugs, shrunk against ONE
//      signature, keeps that bug and never switches to the other.
//
// Run: node --experimental-strip-types gen/selftest-shrink.ts

import type { GNode } from "./model.ts";
import { parse, isArray, isObject, isRawNum, lexemeOf, rawNum } from "./model.ts";
import { emit } from "./emit.ts";
import { shrink } from "./shrink.ts";
import { captureSignatures, makeInteresting } from "./failure-signature.ts";
import type { Adapter } from "../adapters/contract.ts";
import { ingest } from "../oracle/ingest.ts";

let fails = 0;
const check = (label: string, ok: boolean, extra = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${extra ? "  " + extra : ""}`);
};

// ---- pure GNode transforms for mock adapters ------------------------------
function mapTree(n: GNode, f: (m: GNode) => GNode): GNode {
  const mapped = f(n);
  if (isArray(mapped)) return mapped.map((c) => mapTree(c, f));
  if (isObject(mapped)) {
    const o: Record<string, GNode> = {};
    for (const k of Object.keys(mapped)) o[k] = mapTree(mapped[k], f);
    return o;
  }
  return mapped;
}
const TWO_53 = 9007199254740992n;
// Mock "f64" bug: any integer beyond 2^53 loses its low bit (odd -> even), as an
// f64 round would. Value-changing => a "number-changed" mismatch.
function roundBigInts(t: string): string {
  const tree = parse(t);
  const out = mapTree(tree, (n) => {
    if (isRawNum(n)) {
      const lex = lexemeOf(n);
      if (/^-?\d+$/.test(lex)) {
        const v = BigInt(lex);
        if (v > TWO_53 || v < -TWO_53) return rawNum((v - (v % 2n)).toString());
      }
    }
    return n;
  });
  return emit(out);
}
// Mock "empty-array" bug: [] becomes the string "[]". => "container->string".
function stringifyEmptyArrays(t: string): string {
  const out = mapTree(parse(t), (n) => (isArray(n) && n.length === 0 ? "[]" : n));
  return emit(out);
}

const idAdapter = (name: string, decode: (t: string) => string): Adapter => ({
  name,
  encode: async (j) => j,              // toon == json for the mock
  decode: async (toon) => decode(toon),
});

const main = async () => {
  // ======================================================================
  console.log("— (1) needle in a haystack: synthetic predicate, pure reduction —");
  {
    // Build a big nested structure with 9007199254740993 buried inside.
    const NEEDLE = "9007199254740993";
    const rows = Array.from({ length: 200 }, (_v, i) => `{"a":${i},"b":"pad","c":[1,2,3]}`).join(",");
    const haystack = `{"junk":[${rows}],"deep":{"x":{"y":{"z":{"needle":${NEEDLE}}}}},"more":"padding"}`;
    const interesting = (txt: string) => txt.includes(NEEDLE);
    const r = await shrink(haystack, interesting, { maxChecks: 100_000 });
    check("needle case shrinks dramatically", r.endBytes < r.startBytes / 10, `${r.startBytes}B -> ${r.endBytes}B`);
    check("result still satisfies the predicate", interesting(r.text));
    check("result is exactly the needle", r.text === NEEDLE, `got ${r.text}`);
    // 1-minimal: one more shrink pass finds nothing further.
    const again = await shrink(r.text, interesting, { maxChecks: 100_000 });
    check("result is 1-minimal (no further reduction)", again.text === r.text && again.steps === 0);
  }

  // ======================================================================
  console.log("\n— (2) real-shaped predicate: mock f64 adapter via signatures —");
  {
    const adapters = [idAdapter("f64", roundBigInts)];
    const bloated =
      `{"unsafe":9007199254740993,"pad0":"x","pad1":"y","nest":{"a":{"b":{"c":1}}},"arr":[1,2,3,4,5]}`;
    const targets = await captureSignatures(bloated, adapters);
    check("original case has a mismatch signature", targets.some((s) => s.kind === "mismatch" && s.fp === "number-changed"),
      targets.map((s) => `${s.from}->${s.to}/${s.fp}`).join(", "));
    const interesting = makeInteresting(targets, adapters);
    const r = await shrink(bloated, interesting, { maxChecks: 100_000 });
    check("reduces to the bare number reproducer", r.text === "9007199254740993", `got ${r.text}`);
    check("reduced case still reproduces the signature", await interesting(r.text));
    console.log(`       ${r.startBytes}B -> ${r.endBytes}B in ${r.steps} steps, ${r.checks} checks`);
  }

  // ======================================================================
  console.log("\n— (3) ddmin: a 500-element array collapses to minimal length —");
  {
    // Mock bug: decode drops the last element of a root array of length >= 2, so
    // any array of length >= 2 mismatches (length differs); length 1 does not.
    const dropLast = (t: string): string => {
      const tree = parse(t);
      if (isArray(tree) && tree.length >= 2) return emit(tree.slice(0, -1));
      return emit(tree);
    };
    const adapters = [idAdapter("droplast", dropLast)];
    const big = "[" + Array.from({ length: 500 }, () => "true").join(",") + "]";
    const targets = await captureSignatures(big, adapters);
    const interesting = makeInteresting(targets, adapters);
    const r = await shrink(big, interesting, { maxChecks: 100_000 });
    const arr = JSON.parse(r.text);
    check("500-element array reduced to length 2", Array.isArray(arr) && arr.length === 2, `len ${arr.length}`);
    check("reduced case still reproduces the bug", await interesting(r.text));
    console.log(`       ${r.startBytes}B -> ${r.endBytes}B in ${r.steps} steps, ${r.checks} checks`);
  }

  // ======================================================================
  console.log("\n— (4) NO SLIPPAGE: two bugs present, shrink against one —");
  {
    // One adapter carries BOTH planted bugs. A case has a big int (number-changed)
    // AND an empty array (container->string). Target ONLY the number bug.
    const bothBugs = (t: string): string => stringifyEmptyArrays(roundBigInts(t));
    const adapters = [idAdapter("both", bothBugs)];
    const caseText = `{"num":9007199254740993,"empty":[],"pad":"z"}`;
    const allSigs = await captureSignatures(caseText, adapters);
    // Pick the number-changed signature as the sole target.
    const numberTarget = allSigs.filter((s) => s.fp === "number-changed");
    check("case exposes the number bug as a signature", numberTarget.length === 1,
      allSigs.map((s) => s.fp).join(", "));
    const interesting = makeInteresting(numberTarget, adapters);
    const r = await shrink(caseText, interesting, { maxChecks: 100_000 });
    // The result MUST still carry the big integer (the targeted bug)...
    check("reduced case keeps the targeted big integer", r.text.includes("9007199254740993"), `got ${r.text}`);
    // ...and must NOT have slipped to a case whose only failure is the empty-array bug.
    const finalSigs = await captureSignatures(r.text, adapters);
    check("reduced case still reproduces number-changed", finalSigs.some((s) => s.fp === "number-changed"));
    check("reduced case did not become an empty-array-only reproducer",
      !(finalSigs.length === 1 && finalSigs[0].fp === "container->string"));
    console.log(`       ${r.startBytes}B -> ${r.endBytes}B, final sigs: ${finalSigs.map((s) => s.fp).join(", ") || "none"}`);
  }

  console.log(fails === 0
    ? "\nSHRINKER PROVEN: reduces to minimal, preserves the failure, and never slips between bugs."
    : `\nSHRINKER BROKEN: ${fails} check(s) failed.`);
  process.exit(fails === 0 ? 0 : 1);
};

main();
