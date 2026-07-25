/**
 * probe/selftest-numeric-domain.ts — proves the numeric-domain verdicts.
 *
 * Part 1: probes are read from CASE TEXT losslessly (2^53+1 survives; no
 *         value is restated in a sidecar where it could drift).
 * Part 2: f64 exactness is the ODD-PART test, not a flat 2^53 cutoff, so a
 *         large power of two is not mislabelled out-of-domain.
 * Part 3: domain membership per tag, and the NESTING property the decoder
 *         "faithful relay" rule depends on for soundness.
 * Part 4: the per-side verdict table, including the asymmetry that is the
 *         whole point — on 2^53+1 only the f64 side owes anything.
 * Part 5: the post-#329 world (decoder documented) and the encoder gap that
 *         SURVIVES it, proving the two obligations are independent.
 * Part 6: governing-probe selection, including the honest null when a case
 *         holds no out-of-domain value.
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types probe/selftest-numeric-domain.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  integerProbes,
  isExactF64Integer,
  inDomain,
  domainsNest,
  encoderVerdict,
  decoderVerdict,
  bothVerdict,
  governingProbe,
  NUMERIC_FACTS,
  type NumericImplFacts,
} from "./numeric-domain.ts";
import { defaultCorpusRoot } from "./corpus.ts";

let pass = 0;
let fail = 0;
function ok(label: string, got: unknown, want: unknown) {
  const good = Object.is(got, want);
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const seeds = join(defaultCorpusRoot(), "seeds");
const caseText = (f: string) => readFileSync(join(seeds, f), "utf8").trim();

const V = "9007199254740993"; // 2^53+1
const SAFE = "9007199254740991"; // 2^53-1

console.log("Part 1: probes come from the case text, losslessly");
ok("013 yields exactly one integer probe", integerProbes(caseText("013-precision-loss-2pow53plus1.json")).length, 1);
ok("013 probe is 2^53+1 (survives ingestion)", integerProbes(caseText("013-precision-loss-2pow53plus1.json"))[0], V);
ok("011 probe is the safe boundary", integerProbes(caseText("011-safe-integer-boundary.json"))[0], SAFE);
ok("010 yields its integers in encounter order", integerProbes(caseText("010-numbers.json")).join(","), "0,1");
ok("a case with no numbers yields none", integerProbes(`{"a":"1"}`).length, 0);
ok("duplicate integers collapse", integerProbes(`{"a":7,"b":7}`).length, 1);
ok("fractional values are not integer probes", integerProbes(`{"a":0.5}`).length, 0);
// 1.0 denotes the integer 1 by mathematical value (§2 compares by value), and
// the oracle canonicalizes it as such.
ok("1.0 canonicalizes to the integer 1", integerProbes(`{"a":1.0}`)[0], "1");

console.log("Part 2: f64 exactness is the odd-part test");
ok("0 is exact", isExactF64Integer(0n), true);
ok("2^53 is exact", isExactF64Integer(2n ** 53n), true);
ok("2^53+1 is NOT exact", isExactF64Integer(2n ** 53n + 1n), false);
ok("-(2^53+1) is NOT exact (sign-independent)", isExactF64Integer(-(2n ** 53n + 1n)), false);
// The flat-cutoff bug this guards against: 2^54 is far past the safe range
// yet perfectly representable, because its odd part is 1.
ok("2^54 IS exact despite exceeding the safe range", isExactF64Integer(2n ** 54n), true);
ok("2^54+1 is not exact", isExactF64Integer(2n ** 54n + 1n), false);
ok("beyond the double's exponent range nothing is exact", isExactF64Integer(2n ** 1024n), false);

console.log("Part 3: domain membership and nesting");
ok("2^53+1 is out-of-domain for f64", inDomain("f64", V), false);
ok("2^53+1 is in-domain for i64u64f64", inDomain("i64u64f64", V), true);
ok("2^53+1 is in-domain for bignum", inDomain("bignum", V), true);
ok("the safe boundary is in-domain everywhere", inDomain("f64", SAFE) && inDomain("i64u64f64", SAFE), true);
// The rust/python fault line: real, but ABOVE 013.
ok("2^64 is out-of-domain for i64u64f64", inDomain("i64u64f64", (2n ** 64n + 1n).toString()), false);
ok("2^64+1 is still in-domain for bignum", inDomain("bignum", (2n ** 64n + 1n).toString()), true);
// serde_json falls back to f64 past the integer window, so a huge power of
// two is still exact — the union, not just the i64/u64 range.
ok("2^100 is in-domain for i64u64f64 via the f64 fallback", inDomain("i64u64f64", (2n ** 100n).toString()), true);
// Soundness of the decoder "faithful relay" rule.
for (const v of ["0", "-1", SAFE, V, (2n ** 63n).toString(), (2n ** 64n + 1n).toString(), (2n ** 100n).toString()]) {
  ok(`domains nest at ${v}`, domainsNest(v), true);
}

console.log("Part 4: per-side verdicts — only the f64 side owes anything");
const { ts, rust, python } = NUMERIC_FACTS;
ok("rust encoding 2^53+1 is conformant", encoderVerdict(V, rust).verdict, "conformant");
ok("python encoding 2^53+1 is conformant", encoderVerdict(V, python).verdict, "conformant");
ok("ts encoding 2^53+1 violates", encoderVerdict(V, ts).verdict, "violates");
ok("ts encoder is judged under §3 + §2", encoderVerdict(V, ts).clause, "§3 + §2");
ok("ts encoder text names the lossless claim it contradicts", encoderVerdict(V, ts).text.includes("claim lossless"), true);
ok("ts decoding from rust violates §4", decoderVerdict(V, rust, ts).verdict, "violates");
ok("ts decoder is judged under §4", decoderVerdict(V, rust, ts).clause, "§4");
ok("rust decoding from ts is a faithful relay", decoderVerdict(V, ts, rust).verdict, "conformant");
ok("faithful-relay text puts the loss upstream", decoderVerdict(V, ts, rust).text.includes("upstream"), true);
ok("python decoding from rust is conformant", decoderVerdict(V, rust, python).verdict, "conformant");
ok("ts->ts self-pair reports the encoder obligation first", bothVerdict(V, ts).clause, "§3 + §2");
ok("rust->rust self-pair is conformant on 2^53+1", bothVerdict(V, rust).verdict, "conformant");
// Nobody owes anything on an in-domain value.
ok("no side is faulted on the safe boundary", encoderVerdict(SAFE, ts).verdict, "conformant");

console.log("Part 5: post-#329 — decoder documented, encoder gap survives");
const tsDocumented: NumericImplFacts = { ...ts, decoderPolicy: "approximate" };
ok("documented decoder policy satisfies §4", decoderVerdict(V, rust, tsDocumented).verdict, "documented-policy");
ok("its text names the documented policy", decoderVerdict(V, rust, tsDocumented).text.includes("documented \u00a74"), true);
// THE finding the old both-or-neither model could not express: #329 is a
// DECODER docs PR, so the §3 host-type mapping gap is untouched by it.
ok("ts-as-encoder still violates after #329", encoderVerdict(V, tsDocumented).verdict, "violates");
// And the encoder-side fix is a different edit again.
const tsFullyDocumented: NumericImplFacts = { ...tsDocumented, encoderPolicy: "approximate", claimsLossless: false };
ok("documenting the host-type mapping clears the encoder", encoderVerdict(V, tsFullyDocumented).verdict, "documented-lossy");
const tsQuoting: NumericImplFacts = { ...ts, encoderPolicy: "quoted-lossless" };
ok("a documented quoted-lossless path reads as lossless", encoderVerdict(V, tsQuoting).verdict, "documented-lossless");

console.log("Part 6: governing probe selection");
const t013 = caseText("013-precision-loss-2pow53plus1.json");
ok("013 governs on 2^53+1 for rust->ts", governingProbe(t013, rust, ts), V);
ok("013 governs identically in the other direction", governingProbe(t013, ts, rust), V);
// The honest null: rust and python both hold 2^53+1, so no side is
// out-of-domain and the model declines to explain a divergence there.
ok("013 has no governing probe for the rust/python pair", governingProbe(t013, rust, python), null);
ok("an all-in-domain case has no governing probe", governingProbe(caseText("011-safe-integer-boundary.json"), rust, ts), null);
ok("a case with no numbers has no governing probe", governingProbe(`{"a":"x"}`, rust, ts), null);
// The u64 boundary DOES govern for rust/python — the future spec/ case.
ok("2^64+1 governs the rust/python pair", governingProbe(`{"n":${2n ** 64n + 1n}}`, rust, python), (2n ** 64n + 1n).toString());

console.log();
if (fail === 0) {
  console.log(`NUMERIC DOMAIN PROVEN: ${pass} checks pass. Probes come from case text; f64 exactness is the odd-part test; domains nest; fault is attributed per side, and the §3 encoder gap survives a §4 decoder fix.`);
} else {
  console.log(`NUMERIC DOMAIN FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
