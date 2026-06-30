// oracle/selftest.ts
//
// Proves the ORACLE is correct, independent of any TOON implementation.
// This is the afternoon's real objective: if the comparison engine is wrong,
// every later PASS/FAIL is meaningless. Run: node --experimental-strip-types oracle/selftest.ts

import { equal } from "./compare.ts";
import { ingestionFidelity } from "./compare.ts";
import type { Json } from "./canonicalize.ts";

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}  (got ${got}, want ${want})`);
}

// ---- equality semantics --------------------------------------------------
// Things that MUST be equal: only key order and serialization whitespace differ.
check("key order ignored",
  equal({ a: 1, b: 2 } as Json, { b: 2, a: 1 } as Json), true);
check("nested key order ignored",
  equal({ x: { p: 1, q: 2 } } as Json, { x: { q: 2, p: 1 } } as Json), true);
check("delimiter-laden string preserved exactly",
  equal({ t: "a,b|c\td" } as Json, { t: "a,b|c\td" } as Json), true);

// Things that MUST NOT be equal: real semantic differences the oracle must catch.
check("string '123' != number 123 (type strict)",
  equal({ x: "123" } as Json, { x: 123 } as Json), false);
check("string 'true' != boolean true",
  equal({ x: "true" } as Json, { x: true } as Json), false);
check("missing key != explicit null  (almost-uniform table trap)",
  equal({ a: 3 } as Json, { a: 3, b: null } as Json), false);
check("array order is significant",
  equal([1, 2] as Json, [2, 1] as Json), false);
check("empty object != empty array",
  equal({} as Json, [] as Json), false);
check("combining e+U+0301 != precomposed U+00E9 (NO Unicode normalization)",
  equal({ s: "e\u0301" } as Json, { s: "\u00e9" } as Json), false);

// ---- ingestion fidelity guard -------------------------------------------
// These three CANNOT be faithfully ingested by native JSON -> must be quarantined.
check("quarantine: -0",            ingestionFidelity("-0").faithful, false);
check("quarantine: 1.0",           ingestionFidelity('{"f":1.0}').faithful, false);
check("quarantine: 2^53+1 (9007199254740993)",
  ingestionFidelity("9007199254740993").faithful, false);
// These survive native ingestion -> testable in v1.
check("faithful: 123",             ingestionFidelity("123").faithful, true);
check("faithful: 0",              ingestionFidelity("0").faithful, true);
check("faithful: 1.5 (real fraction)", ingestionFidelity('{"f":1.5}').faithful, true);
check("faithful: MAX_SAFE 9007199254740991",
  ingestionFidelity("9007199254740991").faithful, true);
check("faithful: 2^53 = 9007199254740992 (Ash's #12, exactly representable)",
  ingestionFidelity("9007199254740992").faithful, true);
// The guard must NOT be fooled by digits inside a string value.
check("no false positive: digits inside string \"e\\u0301\"",
  ingestionFidelity('{"s":"e\\u0301"}').faithful, true);

console.log(failures === 0
  ? "\nORACLE PROVEN: all checks pass."
  : `\nORACLE BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
