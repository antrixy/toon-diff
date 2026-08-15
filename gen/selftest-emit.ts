// gen/selftest-emit.ts
//
// Proves the generator's substrate (model.parse + emit) does not corrupt input.
// The independent judge is the ORACLE (oracle/ingest.ts, equalRaw) -- the same
// proven judge the matrix uses. If parse->emit ever changed a case's VALUE, the
// oracle would catch it here, before a single mutation is applied.
//
// Two levels of guarantee:
//   * VALUE-faithful on every seed:  equalRaw(emit(parse(s)), s) === true.
//     (Representation may legitimately shift within a value -- e.g. a \uXXXX
//      escape vs the raw code point -- so value-equality is the right lens.)
//   * BYTE-exact on the numbers that carry the differential payload: the digits
//     of 9007199254740993 must survive literally, and 010's -0 / 1.0 must survive
//     literally, because those are precisely the lexemes a naive f64 path destroys.
//
// Run: node --experimental-strip-types gen/selftest-emit.ts

import { loadCorpus } from "../probe/corpus.ts";
import { parse } from "./model.ts";
import { emit } from "./emit.ts";
import { equalRaw } from "../oracle/ingest.ts";

const corpusSeeds = loadCorpus().byBucket.seeds;
let failures = 0;
let total = 0;

function check(label: string, ok: boolean) {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

console.log("— parse->emit is VALUE-faithful on every seed (oracle is the judge) —");
for (const c of corpusSeeds) {
  const f = c.key;
  const raw = c.text;
  const out = emit(parse(raw));
  check(`${f}: equalRaw(emit(parse(s)), s)`, equalRaw(out, raw));
  // And the emitted text must itself be valid JSON the oracle can ingest.
  let reingestable = true;
  try { equalRaw(out, out); } catch { reingestable = false; }
  check(`${f}: emitted text re-ingests as valid JSON`, reingestable);
}

console.log("\n— BYTE-exact preservation of the differential-critical lexemes —");
// 013: the integer that a JS f64 rounds to ...992. Must survive to the digit.
const c013 = corpusSeeds.find((c) => c.id === "013")!.text;
check("013: emitted text contains literal 9007199254740993",
  emit(parse(c013)).includes("9007199254740993"));
check("013: emitted text does NOT contain the rounded 9007199254740992",
  !emit(parse(c013)).includes("9007199254740992"));

// 010: signed zero and trailing-zero float form must survive byte-exact.
const c010 = corpusSeeds.find((c) => c.id === "010")!.text;
const out010 = emit(parse(c010));
check("010: emitted text preserves -0 literally", out010.includes("-0"));
check("010: emitted text preserves 1.0 literally", out010.includes("1.0"));

// A huge integer well beyond any float's exact range survives digit-for-digit.
const huge = '{"b":1000000000000000000000000000001}';
check("huge 10^30+1 survives byte-exact",
  emit(parse(huge)) === huge && emit(parse(huge)).includes("1000000000000000000000000000001"));

console.log("\n— BYTE-exact on canonical input (the oracle structurally cannot see this) —");
// WHY THIS SECTION EXISTS. Every check above is judged by the ORACLE, and the
// oracle's equality deliberately ignores object key order and JSON whitespace --
// two implementations that differ only there are value-equal, which is correct
// for a comparison engine and useless for proving a REPRESENTATION guarantee.
// So no oracle-judged check can ever see emit's second invariant break. Sorting
// emit's keys, reversing them, or padding the separators all passed the suite.
//
// These compare BYTES against a hand-built canonical case: compact separators,
// plain-ASCII strings, already in the form JSON.stringify produces, so byte
// equality is the right lens here even though it would be the wrong lens on an
// arbitrary seed (a \uXXXX escape vs its raw code point is a legitimate shift).
{
  const roundTrips = (s: string) => emit(parse(s)) === s;

  // KEY ORDER. Three keys, deliberately neither sorted nor reverse-sorted, so
  // the case distinguishes "sorted" from "reversed" rather than catching only one.
  const keyed = '{"b":1,"c":2,"a":3}';
  check("key order survives emit byte-for-byte (not sorted, not reversed)",
    roundTrips(keyed));
  check("emit does NOT sort keys", emit(parse(keyed)) !== '{"a":3,"b":1,"c":2}');

  // ALL FIVE JSON VALUE TYPES. The seed corpus contains no real boolean and no
  // real null anywhere -- 007 holds the STRINGS "true" and "null", which is the
  // lookalike case, not the thing itself -- so emit's handling of two of the five
  // types was never exercised. Inverting every boolean passed the suite.
  check("true emits as true", emit(parse("true")) === "true");
  check("false emits as false", emit(parse("false")) === "false");
  check("booleans are not swapped", emit(parse('{"t":true,"f":false}')) === '{"t":true,"f":false}');
  check("null emits as null", emit(parse("null")) === "null");
  check("null survives inside a structure", roundTrips('{"a":null,"b":[null]}'));

  // SEPARATORS. Whitespace is legal JSON and value-equal, so the oracle cannot
  // see it -- but it inflates every byte count the shrinker and the manifest report.
  check("array separators stay compact", roundTrips("[1,2,3]"));
  check("object separators stay compact", roundTrips('{"a":1,"b":2}'));
  check("nested separators stay compact", roundTrips('{"r":[{"a":1,"b":2},{"a":3,"b":4}]}'));

  // The whole shape at once, including the differential-critical lexeme.
  const everything = '{"z":true,"y":false,"x":null,"w":[1,2],"v":"s","u":9007199254740993}';
  check("a case covering all five value types round-trips byte-exact",
    roundTrips(everything));
}

console.log(failures === 0
  ? `\nEMIT SUBSTRATE PROVEN: ${total} checks pass. parse->emit is value-faithful on every seed and byte-exact on key order, separators, and all five value types. Safe to mutate on top of it.`
  : `\nEMIT SUBSTRATE BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
