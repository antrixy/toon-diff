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

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "./model.ts";
import { emit } from "./emit.ts";
import { equalRaw } from "../oracle/ingest.ts";

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
let failures = 0;

function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

console.log("— parse->emit is VALUE-faithful on every seed (oracle is the judge) —");
const files = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort();
for (const f of files) {
  const raw = readFileSync(casesDir + f, "utf8").trim();
  const out = emit(parse(raw));
  check(`${f}: equalRaw(emit(parse(s)), s)`, equalRaw(out, raw));
  // And the emitted text must itself be valid JSON the oracle can ingest.
  let reingestable = true;
  try { equalRaw(out, out); } catch { reingestable = false; }
  check(`${f}: emitted text re-ingests as valid JSON`, reingestable);
}

console.log("\n— BYTE-exact preservation of the differential-critical lexemes —");
// 013: the integer that a JS f64 rounds to ...992. Must survive to the digit.
const c013 = readFileSync(casesDir + "013-precision-loss-2pow53plus1.json", "utf8").trim();
check("013: emitted text contains literal 9007199254740993",
  emit(parse(c013)).includes("9007199254740993"));
check("013: emitted text does NOT contain the rounded 9007199254740992",
  !emit(parse(c013)).includes("9007199254740992"));

// 010: signed zero and trailing-zero float form must survive byte-exact.
const c010 = readFileSync(casesDir + "010-numbers.json", "utf8").trim();
const out010 = emit(parse(c010));
check("010: emitted text preserves -0 literally", out010.includes("-0"));
check("010: emitted text preserves 1.0 literally", out010.includes("1.0"));

// A huge integer well beyond any float's exact range survives digit-for-digit.
const huge = '{"b":1000000000000000000000000000001}';
check("huge 10^30+1 survives byte-exact",
  emit(parse(huge)) === huge && emit(parse(huge)).includes("1000000000000000000000000000001"));

console.log(failures === 0
  ? "\nEMIT SUBSTRATE PROVEN: parse->emit never corrupts a case. Safe to mutate on top of it."
  : `\nEMIT SUBSTRATE BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
