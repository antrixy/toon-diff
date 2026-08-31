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
  f64Approximation,
  relayLandsInDomain,
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

console.log("Part 3: domain membership — MEASURED, not modelled");
// EVERY ROW BELOW WAS OBSERVED through the built bridge on 2026-08-30 (14-value
// ladder, crate 0.5.0 / rustc 1.96.1), then written here. The previous version
// of this block asserted a union with the exactly-representable doubles that
// was read off serde_json's model and never checked against the binary.
const TWO_100 = (2n ** 100n).toString();
const U64_MAX = (2n ** 64n - 1n).toString();
const I64_MIN = (-(2n ** 63n)).toString();

ok("2^53+1 is out-of-domain for f64", inDomain("f64", V), false);
ok("2^53+1 is in-domain for i64u64", inDomain("i64u64", V), true);
ok("2^53+1 is in-domain for bignum", inDomain("bignum", V), true);
ok("the safe boundary is in-domain everywhere", inDomain("f64", SAFE) && inDomain("i64u64", SAFE), true);
// The window's own edges, both observed as exact numbers.
ok("u64 max is in-domain for i64u64", inDomain("i64u64", U64_MAX), true);
ok("i64 min is in-domain for i64u64", inDomain("i64u64", I64_MIN), true);
ok("i64 min - 1 is OUT (observed: stringifies)", inDomain("i64u64", (-(2n ** 63n) - 1n).toString()), false);
// The rust/python fault line: real, but ABOVE 013.
ok("2^64 is out-of-domain for i64u64", inDomain("i64u64", (2n ** 64n + 1n).toString()), false);
ok("2^64+1 is still in-domain for bignum", inDomain("bignum", (2n ** 64n + 1n).toString()), true);
// M5: the edge ITSELF, not just past it. Checking only 2^64+1 left "v <= TWO_64"
// alive, because that mutant is wrong at exactly one value.
ok("2^64 EXACTLY is out-of-domain for i64u64 (the edge is exclusive)",
  inDomain("i64u64", (2n ** 64n).toString()), false);
// THE ROW THAT SETTLED IT. 2^100 IS an exact double, so the old model called it
// in-domain "via the f64 fallback". The bridge returns it as a lossless STRING,
// so there is no fallback and the domain is the window alone.
ok("2^100 is OUT for i64u64 — there is no f64 fallback (measured)", inDomain("i64u64", TWO_100), false);
ok("2^100 IS an exact double, which is why the old model got this wrong", isExactF64Integer(2n ** 100n), true);

console.log("Part 3b: the domains do NOT nest, and both directions are pinned");
// Nesting was the stated basis for the decoder's faithful-relay credit. It is
// gone, so it is asserted FALSE here rather than quietly dropped — a removed
// check leaves no trace, an inverted one does.
ok("nesting HOLDS at 2^53+1 (f64 out, window in)", domainsNest(V), true);
ok("nesting FAILS at 2^100 (exact double, outside the window)", domainsNest(TWO_100), false);
ok("f64 is not a subset of i64u64 (2^100 is in f64, not the window)",
  inDomain("f64", TWO_100) && !inDomain("i64u64", TWO_100), true);
ok("i64u64 is not a subset of f64 (u64 max is in the window, not an exact double)",
  inDomain("i64u64", U64_MAX) && !inDomain("f64", U64_MAX), true);
ok("bignum still contains both", inDomain("bignum", TWO_100) && inDomain("bignum", U64_MAX), true);

console.log("Part 3c: the relay credit is now COMPUTED, not assumed");
// f64 encoder out-of-domain at 2^53+1 emits 2^53, which the window holds — so
// the 013 verdicts are unchanged by any of the above. That is the check that
// proves this correction did not silently move an existing finding.
ok("f64's approximation of 2^53+1 is 2^53", String(f64Approximation(V)), (2n ** 53n).toString());
ok("relay is sound ts->rust at 2^53+1", relayLandsInDomain(V, "f64", "i64u64"), true);
ok("relay is sound ts->python at 2^53+1", relayLandsInDomain(V, "f64", "bignum"), true);
const TWO_100_P1 = (2n ** 100n + 1n).toString();
ok("f64's approximation of 2^100+1 is 2^100", String(f64Approximation(TWO_100_P1)), TWO_100);

// THE TOKEN FORM DECIDES, NOT THE VALUE. This block replaces an assertion that
// was WRONG and had to be measured out: it claimed the relay was unsound at
// 2^100+1 because 2^100 is outside rust's window. But ts emits 2^100 in
// EXPONENT form (|n| >= 1e21), and rust parses exponent tokens numerically —
// measured, along with the plain rows above, on 2026-08-30. So there are two
// bands, and only the lower one breaks the relay.
//
// BAND 1 — [2^64, 1e21): ts emits PLAIN decimal, rust stringifies it.
// 2^65 is the real case: ts's wire is literally "n: 36893488147419103000".
// 2^65+1, not 2^65: the relay branch is only REACHED when the encoder is
// out-of-domain, and 2^65 is an exact double that ts holds fine. The +1 makes
// it inexact while leaving the approximation (2^65 ~ 3.7e19) in the band.
const TWO_65_P1 = (2n ** 65n + 1n).toString();
ok("2^65+1 is out-of-domain for f64 (so the relay branch is reached)",
  inDomain("f64", TWO_65_P1), false);
ok("its approximation is 2^65, which is plain-decimal territory (below 1e21)",
  BigInt(String(f64Approximation(TWO_65_P1))) < 10n ** 21n, true);
ok("relay is NOT sound ts->rust at 2^65+1 (plain token, rust stringifies)",
  relayLandsInDomain(TWO_65_P1, "f64", "i64u64"), false);
// BAND 2 — >= 1e21: ts emits EXPONENT form, every measured decoder parses it
// numerically, so the relay holds after all.
ok("2^100+1's approximation is exponent territory (>= 1e21)",
  BigInt(TWO_100) >= 10n ** 21n, true);
ok("relay IS sound ts->rust at 2^100+1 (exponent token takes the numeric path)",
  relayLandsInDomain(TWO_100_P1, "f64", "i64u64"), true);
ok("relay is still sound ts->bignum at 2^100+1", relayLandsInDomain(TWO_100_P1, "f64", "bignum"), true);
// The threshold itself, from both sides — a constant nothing tests is a
// constant that can drift.
ok("just below 1e21 the plain path applies", relayLandsInDomain("999999999999999900000", "f64", "i64u64"), false);
ok("at 1e21 the exponent path applies", relayLandsInDomain("1000000000000000000000", "f64", "i64u64"), true);
// NEGATIVES TAKE THE SAME BRANCH. Found by mutation M28: dropping the absolute
// value left every check green, because the whole threshold block was positive.
// A sign error here would silently move every large negative into the plain
// band and re-open the band-1 misattribution on the other side of zero.
ok("-2^100+1 is out-of-domain for f64 (relay branch reached)",
  inDomain("f64", (-(2n ** 100n) - 1n).toString()), false);
ok("relay IS sound ts->rust at -(2^100+1) (magnitude, not sign, picks the branch)",
  relayLandsInDomain((-(2n ** 100n) - 1n).toString(), "f64", "i64u64"), true);
ok("and just below -1e21 the plain path still applies",
  relayLandsInDomain("-999999999999999900000", "f64", "i64u64"), false);
// An i64u64 encoder out-of-domain emits a lossless string, so nothing numeric
// is lost for the decoder to be blamed for.
ok("relay is sound rust->ts at 2^64+1 (lossless string on the wire)",
  relayLandsInDomain((2n ** 64n + 1n).toString(), "i64u64", "f64"), true);

// M15: the credit must test what the encoder EMITS, not the input value.
// u64 max is INSIDE rust's window, but ts's nearest double for it is 2^64,
// which is not — so a check written against the original value would wrongly
// call this relay sound. This is the one value in the ladder that separates
// the two formulations.
ok("u64 max is in rust's window", inDomain("i64u64", U64_MAX), true);
ok("but ts's approximation of it is 2^64", String(f64Approximation(U64_MAX)), (2n ** 64n).toString());
ok("so relay ts->rust at u64 max is NOT sound", relayLandsInDomain(U64_MAX, "f64", "i64u64"), false);

console.log("Part 3d: decoderVerdict actually CONSULTS the relay check");
// M12: testing relayLandsInDomain() in isolation left "if (true)" alive in
// decoderVerdict — the guard existed and nothing proved it was wired in.
const tsF = NUMERIC_FACTS.ts, rustF = NUMERIC_FACTS.rust, pyF = NUMERIC_FACTS.python;
ok("ts->rust at 2^53+1 is still a faithful relay (013 verdict unmoved)",
  decoderVerdict(V, tsF, rustF).verdict, "conformant");
ok("ts->rust at 2^65+1 is UNATTRIBUTED, not credited (the plain-token band)",
  decoderVerdict(TWO_65_P1, tsF, rustF).verdict, "unattributed");
ok("the unattributed text says the model cannot say whose loss it is",
  decoderVerdict(TWO_65_P1, tsF, rustF).text.includes("cannot say whose loss"), true);
ok("ts->rust at 2^100+1 IS credited (the exponent band)",
  decoderVerdict(TWO_100_P1, tsF, rustF).verdict, "conformant");
ok("ts->python at 2^100+1 is still a faithful relay (bignum holds anything)",
  decoderVerdict(TWO_100_P1, tsF, pyF).verdict, "conformant");

// M20: the wording that keeps the report from reading as an accusation of data
// loss. rust returns the exact digits as a lossless string and STILL lands on
// "violates" for want of documentation; dropping this sentence would make the
// filing unfair, and prose that carries meaning has to be pinned like anything else.
const rustOOR = decoderVerdict((2n ** 64n + 1n).toString(), pyF, rustF);
ok("an undocumented decoder is judged violates", rustOOR.verdict, "violates");
ok("and the text names it a DOCUMENTATION fault, not data loss",
  rustOOR.text.includes("DOCUMENTATION fault"), true);
ok("and states §4 permits several behaviours",
  rustOOR.text.includes("RECOMMENDED lossless-first"), true);

console.log("Part 4: per-side verdicts — only the f64 side owes anything");
const { ts, rust, python } = NUMERIC_FACTS;
ok("rust encoding 2^53+1 is conformant", encoderVerdict(V, rust).verdict, "conformant");
ok("python encoding 2^53+1 is conformant", encoderVerdict(V, python).verdict, "conformant");
ok("ts encoding 2^53+1 violates", encoderVerdict(V, ts).verdict, "violates");
ok("ts encoder is judged under §3 + §2", encoderVerdict(V, ts).clause, "§3 + §2");
ok("ts encoder text names the lossless claim it contradicts", encoderVerdict(V, ts).text.includes("claim lossless"), true);
ok("ts decoding from rust satisfies its documented §4 policy (post-#331)", decoderVerdict(V, rust, ts).verdict, "documented-policy");
ok("ts decoder is judged under §4", decoderVerdict(V, rust, ts).clause, "§4");
ok("rust decoding from ts is a faithful relay", decoderVerdict(V, ts, rust).verdict, "conformant");
ok("faithful-relay text puts the loss upstream", decoderVerdict(V, ts, rust).text.includes("upstream"), true);
ok("python decoding from rust is conformant", decoderVerdict(V, rust, python).verdict, "conformant");
ok("ts->ts self-pair reports the encoder obligation first", bothVerdict(V, ts).clause, "§3 + §2");
ok("rust->rust self-pair is conformant on 2^53+1", bothVerdict(V, rust).verdict, "conformant");
// Nobody owes anything on an in-domain value.
ok("no side is faulted on the safe boundary", encoderVerdict(SAFE, ts).verdict, "conformant");

console.log("Part 5: pre-#331 past and the encoder gap that outlived it");
// #331 merged 2026-07-26, so the documented-decoder verdict is now the live
// baseline above. Parameterizing the policy back to null recovers the world
// before it — the engine must still be able to state both.
const tsUndocumented: NumericImplFacts = { ...ts, decoderPolicy: null };
ok("pre-#331: an undocumented decoder policy violated §4", decoderVerdict(V, rust, tsUndocumented).verdict, "violates");
ok("post-#331 text names the documented policy", decoderVerdict(V, rust, ts).text.includes("documented \u00a74"), true);
// THE finding the old both-or-neither model could not express: #329 is a
// DECODER docs PR, so the §3 host-type mapping gap is untouched by it.
ok("ts-as-encoder violates in BOTH worlds (#331 is decoder-only)", encoderVerdict(V, ts).verdict === encoderVerdict(V, tsUndocumented).verdict, true);
// And the encoder-side fix is a different edit again.
const tsFullyDocumented: NumericImplFacts = { ...ts, encoderPolicy: "approximate", claimsLossless: false };
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
  console.log(`NUMERIC DOMAIN PROVEN: ${pass} checks pass. Probes come from case text; f64 exactness is the odd-part test; the domains do NOT nest and both directions are pinned; fault is attributed per side, the §3 encoder gap survives a §4 decoder fix, and the relay credit is COMPUTED from the measured TOKEN FORM the encoder emits, not from domain nesting that no longer holds.`);
} else {
  console.log(`NUMERIC DOMAIN FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
