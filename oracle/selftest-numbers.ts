// oracle/selftest-numbers.ts
//
// Proves the v2 oracle (ingest.ts) correct, independent of any TOON impl.
// Re-establishes EVERY v1 invariant under the new serializer, then proves the
// exact-value number semantics that let 010 and 013 leave quarantine.
// Run: node --experimental-strip-types oracle/selftest-numbers.ts

import { ingest, canonical, equal, equalRaw, canonicalNumber } from "./ingest.ts";

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}  (got ${got}, want ${want})`);
}
function eq(a: string, b: string) {
  return equalRaw(a, b);
}

console.log("— v1 invariants, re-proven under the v2 serializer —");
check("key order ignored", eq('{"a":1,"b":2}', '{"b":2,"a":1}'), true);
check("nested key order ignored", eq('{"x":{"p":1,"q":2}}', '{"x":{"q":2,"p":1}}'), true);
check("delimiter-laden string preserved", eq('{"t":"a,b|c\\td"}', '{"t":"a,b|c\\td"}'), true);
check("string '123' != number 123 (type strict)", eq('{"x":"123"}', '{"x":123}'), false);
check("string 'true' != boolean true", eq('{"x":"true"}', '{"x":true}'), false);
check("missing key != explicit null (almost-uniform trap)", eq('{"a":3}', '{"a":3,"b":null}'), false);
check("array order is significant", eq("[1,2]", "[2,1]"), false);
check("empty object != empty array", eq("{}", "[]"), false);
check("combining e+U+0301 != precomposed U+00E9 (no NFC)", eq('{"s":"e\\u0301"}', '{"s":"\\u00e9"}'), false);

console.log("\n— exact-value number semantics (the v2 payload) —");
// Value-equal: representation differs, value identical -> MUST be equal.
check("1.0 == 1  (value semantics)", eq('{"f":1.0}', '{"f":1}'), true);
check("-0 == 0   (no signed zero in JSON value model)", eq('{"z":-0}', '{"z":0}'), true);
check("1.50 == 1.5", eq('{"f":1.50}', '{"f":1.5}'), true);
check("1e2 == 100  (exponent expanded, no float)", eq('{"n":1e2}', '{"n":100}'), true);
check("1e-2 == 0.01", eq('{"n":1e-2}', '{"n":0.01}'), true);

// THE differential payload: precision must NOT be laundered away.
check("2^53+1 != 2^53  (precision loss is a real divergence)",
  eq('{"u":9007199254740993}', '{"u":9007199254740992}'), false);
check("2^53+1 preserved exactly (== itself, not rounded)",
  eq('{"u":9007199254740993}', '{"u":9007199254740993}'), true);
check("huge int preserved (10^30 != 10^30 + 1)",
  eq('{"b":1000000000000000000000000000000}', '{"b":1000000000000000000000000000001}'), false);

console.log("\n— canonicalNumber unit checks (arbitrary precision, no float) —");
function cn(lex: string, want: string) {
  const got = canonicalNumber(lex);
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} canonicalNumber("${lex}") = "${got}"  (want "${want}")`);
}
cn("0", "0"); cn("-0", "0"); cn("0.0", "0"); cn("0.000", "0");
cn("1", "1"); cn("1.0", "1"); cn("1.00", "1"); cn("1e0", "1");
cn("1.5", "1.5"); cn("1.50", "1.5"); cn("10.50", "10.5"); cn("0.5", "0.5");
cn("1e2", "100"); cn("1.23e2", "123"); cn("1e-2", "0.01"); cn("-1.50", "-1.5");
cn("9007199254740992", "9007199254740992");
cn("9007199254740993", "9007199254740993"); // exact, distinct from above

console.log("\n— case 010 graduates: representable & internally consistent —");
// The whole of 010 must ingest without throwing and round-trip-compare to itself.
const c010 = '{"zero":0,"negZero":-0,"float":1.0,"int":1}';
check("010 ingests and self-compares", eq(c010, c010), true);
check("010: negZero value-equals zero (value policy)",
  equal(ingest('-0'), ingest('0')), true);

console.log(failures === 0
  ? "\nV2 ORACLE PROVEN: all checks pass. 010 and 013 are now testable losslessly."
  : `\nV2 ORACLE BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
