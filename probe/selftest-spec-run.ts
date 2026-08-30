/**
 * probe/selftest-spec-run.ts — proves the one-sided spec run path.
 *
 * Part 1: the real spec cases are shaped to run (wire present, body ingests).
 * Part 2: against FAKE decoders whose behavior is chosen, not observed, the
 *         run path records exactly the divergences it should — including the
 *         cases that matter most:
 *           * a decoder returning the NEAREST DOUBLE for 2^64+1 must be caught,
 *             not rounded into agreement (the whole point of the lossless
 *             oracle on this path);
 *           * a decoder returning a re-keyed or re-ordered object must still
 *             agree, because the oracle normalizes key order;
 *           * a throwing decoder is a divergence with an error, not a crash.
 * Part 3: harness-bug tripwires — a non-spec case or a wireless case throws.
 *
 * FAKE DECODERS ARE THE POINT. A selftest that ran the real adapters could
 * only assert what those adapters happen to do today, which is the thing under
 * test. Fakes let the run path be judged against behavior we CHOSE, so a check
 * here fails when the PATH is wrong rather than when an implementation moves.
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types probe/selftest-spec-run.ts
 */

import { loadCorpus } from "./corpus.ts";
import { runSpecCases, SPEC_SIDE, type SpecDecoder } from "./spec-run.ts";
import type { CorpusCase } from "./corpus.ts";
import { SPEC_VERSION_CLAIMS } from "../adapters/contract.ts";

let pass = 0;
let fail = 0;
function ok(label: string, got: unknown, want: unknown) {
  const good = Object.is(got, want);
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// A decoder built from a wire -> json map; anything unmapped throws, so a case
// the fake was not told about surfaces as an error rather than a silent pass.
function fake(name: string, table: Record<string, string>): SpecDecoder {
  return {
    name,
    decode: async (wire: string) => {
      if (!(wire in table)) throw new Error(`fake ${name}: no mapping for ${JSON.stringify(wire)}`);
      return table[wire];
    },
  };
}

const U64_WIRE = "n: 18446744073709551617";
const U64_JSON = `{"n":18446744073709551617}`;
const NEAREST_DOUBLE = `{"n":18446744073709551616}`; // what an f64 decoder returns
const LEGACY_WIRE = "[0]:";

// ---------- Part 1: the real spec cases are runnable ----------
console.log("Part 1: the real spec corpus is shaped to run");
const corpus = loadCorpus();
const specCases = corpus.byBucket.spec;
ok("2 spec cases", specCases.length, 2);
ok("every spec case has wire text", specCases.every((c) => typeof c.wire === "string"), true);
ok("the u64 case is present", specCases.some((c) => c.wire === U64_WIRE), true);
ok("the legacy-root case is present", specCases.some((c) => c.wire === LEGACY_WIRE), true);

// ---------- Part 2: run-path behavior against chosen decoders ----------
console.log("Part 2: the one-sided run path");

const faithful = fake("faithful", { [U64_WIRE]: U64_JSON, [LEGACY_WIRE]: "[]" });
const rounds = fake("rounds", { [U64_WIRE]: NEAREST_DOUBLE, [LEGACY_WIRE]: "[]" });
const rejects: SpecDecoder = {
  name: "rejects",
  decode: async (wire: string) => {
    if (wire === LEGACY_WIRE) throw new Error("legacy empty-array form not supported");
    return U64_JSON;
  },
};

const all = await runSpecCases(specCases, [faithful, rounds, rejects]);
// 2 cases x 3 decoders = 6. If this ever reads 18, the pairwise arithmetic has
// leaked into the one-sided lane.
ok("6 checks (cases x decoders, N not N\u00d7N)", all.specChecks, 6);
ok("2 divergences", all.records.length, 2);
// Asserted as a LITERAL, not against SPEC_SIDE itself: `r.from === SPEC_SIDE`
// is true no matter what SPEC_SIDE is renamed to, so it inherits the blind
// spot of the code under test. A mutation pass caught exactly that.
ok("the synthetic side is literally \"spec\"", SPEC_SIDE, "spec");
ok("every record names the spec as encoder", all.records.every((r) => r.from === "spec"), true);
ok("no record names spec as decoder", all.records.some((r) => r.to === "spec"), false);
// The synthetic name must not collide with any adapter name, or a spec result
// would render as a real implementation's encoder row in the N×N lane.
ok("the synthetic side is not an adapter name",
  Object.keys(SPEC_VERSION_CLAIMS).includes(SPEC_SIDE), false);

const roundRec = all.records.find((r) => r.to === "rounds")!;
// THE CHECK THIS FILE EXISTS FOR: 2^64+1 and 2^64 are the same f64 and differ
// by one in mathematical value. §2 compares by mathematical value, so an
// oracle that went through a double would call this agreement.
ok("the nearest-double answer is caught, not rounded into agreement", roundRec !== undefined, true);
ok("its expected side is the spec-mandated value", roundRec.expected, U64_JSON);
ok("its actual side is what the decoder returned", roundRec.actual, NEAREST_DOUBLE);
ok("it is a value-mismatch, not an error", roundRec.error, undefined);
ok("it names the u64 case", roundRec.file, "spec/001-u64-boundary.json");

const rejectRec = all.records.find((r) => r.to === "rejects")!;
ok("a throwing decoder records an error", typeof rejectRec.error, "string");
ok("the error text is preserved", rejectRec.error!.includes("legacy empty-array form"), true);
ok("the error record names the legacy case", rejectRec.file, "spec/002-legacy-empty-array-root.json");
ok("a faithful decoder produces no record", all.records.some((r) => r.to === "faithful"), false);

// Key order is not a divergence — the oracle normalizes it, and a spec case
// must not manufacture a finding out of object ordering.
{
  const c: CorpusCase = {
    id: "900", name: "order", key: "spec/900-order.json", bucket: "spec",
    text: `{"a":1,"b":2}`, wire: "w", meta: { origin: "t", invariant: "t" },
  };
  const reordered = fake("reordered", { w: `{"b":2,"a":1}` });
  const r = await runSpecCases([c], [reordered]);
  ok("key reordering is not a divergence", r.records.length, 0);
  ok("but it still counted as a check", r.specChecks, 1);
}

// An empty spec bucket runs cleanly and counts zero — not a silent skip.
{
  const r = await runSpecCases([], [faithful]);
  ok("no spec cases: no records", r.records.length, 0);
  ok("no spec cases: zero checks", r.specChecks, 0);
}

// ---------- Part 3: harness-bug tripwires ----------
console.log("Part 3: harness bugs throw");
{
  const seedCase = corpus.byBucket.seeds[0];
  let threw = "";
  try {
    await runSpecCases([seedCase], [faithful]);
  } catch (e) { threw = (e as Error).message; }
  ok("a non-spec case throws", threw.includes("not spec"), true);
}
{
  // The loader forbids this shape, so reaching the run path means the loader
  // guarantee broke — which must be loud, not a skipped case.
  const wireless: CorpusCase = {
    id: "901", name: "wireless", key: "spec/901-wireless.json", bucket: "spec",
    text: "{}", meta: { origin: "t", invariant: "t" },
  };
  let threw = "";
  try {
    await runSpecCases([wireless], [faithful]);
  } catch (e) { threw = (e as Error).message; }
  ok("a spec case with no wire throws", threw.includes("no wire text"), true);
}

console.log();
if (fail === 0) {
  console.log(`SPEC RUN PATH PROVEN: ${pass} checks pass. Wire-in cases are judged against the spec at N checks per case, a nearest-double answer cannot pass as agreement, key order is not a finding, and a wireless or non-spec case throws.`);
} else {
  console.log(`SPEC RUN PATH FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
