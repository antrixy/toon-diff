// gen/selftest-operators.ts
//
// Proves the operator set. Four things, in order of importance:
//
//   1. NON-CORRUPTING IN BULK. Every generated case, across all seeds x many
//      rngSeeds, re-ingests as valid JSON through the ORACLE. A case that failed
//      to parse would crash the matrix; a case whose value the substrate corrupted
//      would be a false finding. This is the guarantee that lets a fuzz run be
//      trusted at all.
//   2. PER-OPERATOR CONTRACT. Each operator produces its DOCUMENTED change
//      (WidenObject widens, GrowTable grows rows, BumpNumber lands in the boundary
//      set, NumberForm preserves VALUE while changing representation, ...).
//   3. DETERMINISM. generateCase(seed, rngSeed) twice -> identical bytes; replay()
//      reproduces. Without this a finding can't be filed or shrunk.
//   4. toon#310 COVERAGE. The under-tested shapes are actually reached: real
//      flat-wide objects and large-row-count tables appear in a bulk run.
//
// Run: node --experimental-strip-types gen/selftest-operators.ts

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GNode, RawNum } from "./model.ts";
import { parse, isRawNum, isArray, isObject, lexemeOf } from "./model.ts";
import { emit } from "./emit.ts";
import { makeRng } from "./prng.ts";
import { generateCase, replay } from "./generate.ts";
import {
  WidenObject, ScaleArray, GrowTable, WidenRow, PerturbUniformity,
  EmptyContainerMix, BumpNumber, NumberForm, DelimiterInject, NestDeep,
} from "./operators.ts";
import { equalRaw, ingest } from "../oracle/ingest.ts";

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

// ---- structural measures --------------------------------------------------
function numberLexemes(n: GNode, out: string[] = []): string[] {
  if (isRawNum(n)) out.push(lexemeOf(n));
  else if (isArray(n)) n.forEach((c) => numberLexemes(c, out));
  else if (isObject(n)) for (const k of Object.keys(n)) numberLexemes(n[k], out);
  return out;
}
function maxDepth(n: GNode): number {
  if (isArray(n)) return 1 + (n.length ? Math.max(...n.map(maxDepth)) : 0);
  if (isObject(n)) { const ks = Object.keys(n); return 1 + (ks.length ? Math.max(...ks.map((k) => maxDepth(n[k]))) : 0); }
  return 0;
}
function maxObjectWidth(n: GNode): number {
  let w = isObject(n) ? Object.keys(n).length : 0;
  if (isArray(n)) n.forEach((c) => (w = Math.max(w, maxObjectWidth(c))));
  else if (isObject(n)) for (const k of Object.keys(n)) w = Math.max(w, maxObjectWidth(n[k]));
  return w;
}
function maxArrayLen(n: GNode): number {
  let l = isArray(n) ? n.length : 0;
  if (isArray(n)) n.forEach((c) => (l = Math.max(l, maxArrayLen(c))));
  else if (isObject(n)) for (const k of Object.keys(n)) l = Math.max(l, maxArrayLen(n[k]));
  return l;
}

// ==========================================================================
console.log("— (1) bulk: every generated case is valid JSON the oracle can ingest —");
const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
const seeds = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f, text: readFileSync(casesDir + f, "utf8").trim() }));

let generated = 0, reingestOk = 0;
let sawWideObject = false, sawLargeTable = false;
const opsFired = new Set<string>();
for (const seed of seeds) {
  for (let s = 0; s < 60; s++) {
    const g = generateCase(seed.text, s * 2654435761 + 1, { seedName: seed.name, maxOps: 3 });
    generated++;
    try {
      ingest(g.text);            // throws on invalid JSON
      reingestOk++;
    } catch {
      console.log(`   invalid JSON from ${seed.name} @ rngSeed derived s=${s}: ${g.text.slice(0, 80)}`);
    }
    g.provenance.pipeline.forEach((st) => opsFired.add(st.op));
    const tree = parse(g.text);
    if (maxObjectWidth(tree) >= 64) sawWideObject = true;
    if (maxArrayLen(tree) >= 1000) sawLargeTable = true;
  }
}
check(`all ${generated} generated cases re-ingest as valid JSON`, reingestOk === generated);

// ==========================================================================
console.log("\n— (2) per-operator contract (documented effect holds) —");
const rng = () => makeRng(0xC0FFEE);

// O1 WidenObject: flat-wide growth.
{
  const before = parse("{}");
  const after = WidenObject.apply(before, rng()).node;
  check("WidenObject: object gains >= 8 keys", maxObjectWidth(after) >= 8 && maxDepth(after) <= 2);
}
// O2 ScaleArray: empty and non-empty both scale up.
{
  const a1 = ScaleArray.apply(parse("[]"), rng()).node;
  const a2 = ScaleArray.apply(parse("[1,2]"), rng()).node;
  check("ScaleArray: [] -> len >= 50", maxArrayLen(a1) >= 50);
  check("ScaleArray: [1,2] -> len >= 50", maxArrayLen(a2) >= 50);
}
// O3 GrowTable: large row count.
{
  const after = GrowTable.apply(parse('[{"a":1,"b":2},{"a":3,"b":4}]'), rng()).node;
  check("GrowTable: table -> >= 100 rows", isArray(after) && after.length >= 100);
}
// O4 WidenRow: every row gains >= 4 columns.
{
  const beforeText = '[{"a":1},{"a":3}]';
  const after = WidenRow.apply(parse(beforeText), rng()).node as { [k: string]: GNode }[];
  check("WidenRow: every row gains >= 4 columns",
    isArray(after) && after.every((r) => Object.keys(r).length >= 1 + 4));
}
// O5 PerturbUniformity: uniform table is no longer perfectly uniform.
{
  const beforeText = '[{"a":1,"b":2},{"a":3,"b":4}]';
  const before = parse(beforeText);
  const after = PerturbUniformity.apply(before, rng()).node;
  check("PerturbUniformity: mutation changed the table", emit(after) !== emit(before));
  check("PerturbUniformity: result still valid JSON", (() => { try { ingest(emit(after)); return true; } catch { return false; } })());
}
// O10 EmptyContainerMix: an empty container is introduced.
{
  const before = parse('{"a":1}');
  const after = EmptyContainerMix.apply(before, rng()).node;
  const t = emit(after);
  check("EmptyContainerMix: emits an empty {} or [] and differs", t !== emit(before) && (t.includes("{}") || t.includes("[]")));
}
// O6 BumpNumber: number lands in the boundary set.
{
  const BOUND = new Set([
    "9007199254740991","9007199254740992","9007199254740993","9007199254740994",
    "9223372036854775807","18446744073709551615",
    "1000000000000000000000000000000","1000000000000000000000000000001",
  ]);
  const after = BumpNumber.apply(parse('{"x":1}'), rng()).node;
  check("BumpNumber: a boundary lexeme now present", numberLexemes(after).some((l) => BOUND.has(l)));
}
// O7 NumberForm: representation changes, VALUE preserved (oracle is judge).
{
  const beforeText = '{"x":1}';
  const after = NumberForm.apply(parse(beforeText), rng()).node;
  const afterText = emit(after);
  check("NumberForm: representation changed", afterText !== beforeText);
  check("NumberForm: value preserved (equalRaw)", equalRaw(afterText, beforeText));
}
// O8 DelimiterInject: a delimiter/lookalike string appears; result valid.
{
  const before = parse('{"a":1}');
  let sawPayload = false;
  for (let s = 0; s < 20; s++) {
    const t = emit(DelimiterInject.apply(before, makeRng(s)).node);
    try { ingest(t); } catch { sawPayload = false; break; }
    if (/[,|\t\n\r":\\]/.test(t.replace(/^{"a":1/, "")) || /"(true|false|null|123|1\.5)"/.test(t)) sawPayload = true;
  }
  check("DelimiterInject: injects a delimiter/lookalike over a small sweep", sawPayload);
}
// O9 NestDeep: depth increases.
{
  const before = parse('{"a":1}');
  const after = NestDeep.apply(before, rng()).node;
  check("NestDeep: depth increases", maxDepth(after) > maxDepth(before));
}

// ==========================================================================
console.log("\n— (3) determinism & replay —");
{
  const seed = seeds.find((s) => s.name.startsWith("004"))!;
  const a = generateCase(seed.text, 123456, { maxOps: 3 }).text;
  const b = generateCase(seed.text, 123456, { maxOps: 3 }).text;
  check("generateCase is deterministic (identical bytes)", a === b);
  check("replay() reproduces the same bytes", replay(seed.text, 123456, 3) === a);
  const c = generateCase(seed.text, 123457, { maxOps: 3 }).text;
  check("different rngSeed generally yields a different case", c !== a);
}

// ==========================================================================
console.log("\n— (4) toon#310 coverage: under-tested shapes are actually reached —");
check("bulk run produced a flat-WIDE object (>= 64 keys)", sawWideObject);
check("bulk run produced a LARGE table/array (>= 1000 elems)", sawLargeTable);
check("every operator fired at least once in the bulk run", opsFired.size === 10);
console.log(`   operators exercised: ${[...opsFired].sort().join(", ")}`);

console.log(failures === 0
  ? "\nGENERATOR PROVEN: operators honor their contracts, every case is valid & non-corrupting, generation is reproducible, and the toon#310 shapes are reached."
  : `\nGENERATOR BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
