/**
 * adapters/selftest-claims.ts — proves the implementation-claims record.
 *
 * IMPL_CLAIMS is the single source of truth for what spec version each
 * upstream implementation CLAIMS, with evidence and a browser-verification
 * date. This selftest pins:
 *   - shape: versions null-or-MAJOR.MINOR, evidence and dates well-formed
 *   - derivation: SPEC_VERSION_CLAIMS (the shape adapters consume) can never
 *     disagree with IMPL_CLAIMS
 *   - content: the rust 3.2 -> 3.0 correction, and the #71 promotion tripwire
 *     (rust's pending README bump must be updated HERE, deliberately, with the
 *     merge commit — this test will fail until that edit is made consciously)
 *
 * It also pins the NUMERIC axis, which SPEC.md splits by domain membership:
 *   - domains: the exact-value model each adapter ingests (f64 / i64u64 /
 *     bignum), evidenced in-repo, plus the NUMERIC_DOMAINS derivation
 *   - policies: encoder (§3+§2) and decoder (§4) documented out-of-range
 *     behavior recorded SEPARATELY, because they are independent obligations
 *   - the #329 promotion tripwire: ts's decoder policy is null while the docs
 *     PR is unmerged, and its notes must say so. On merge, decoderPolicy moves
 *     to "approximate" and this check MUST be updated in the same commit
 *   - the ts self-contradiction pin: null policy WHILE claiming losslessness,
 *     which is the finding — distinct from rust/python's mere silence
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types adapters/selftest-claims.ts
 */

import { IMPL_CLAIMS, SPEC_VERSION_CLAIMS, NUMERIC_DOMAINS } from "./contract.ts";
import { parseSpecVersion, SPEC_CURRENT, compareSpecVersions } from "../probe/spec-rules.ts";

let pass = 0;
let fail = 0;
function ok(label: string, got: unknown, want: unknown) {
  const good = Object.is(got, want);
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const ids = Object.keys(IMPL_CLAIMS) as (keyof typeof IMPL_CLAIMS)[];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DOMAIN_TAGS: readonly unknown[] = ["f64", "i64u64", "bignum"];
const POLICIES: readonly unknown[] = ["approximate", "quoted-lossless", "reject", null];

console.log("Part 1: shape");
ok("three implementations", ids.length, 3);
ok("ids are the matrix adapter names", ids.slice().sort().join(","), "python,rust,ts");
for (const id of ids) {
  const c = IMPL_CLAIMS[id];
  ok(`${id}: version is null or MAJOR.MINOR`, c.version === null || parseSpecVersion(c.version) !== null, true);
  ok(`${id}: evidence is non-empty`, c.evidence.trim().length > 0, true);
  ok(`${id}: verified is YYYY-MM-DD`, DATE_RE.test(c.verified), true);
  if (c.version !== null) {
    ok(`${id}: claim does not exceed current spec ${SPEC_CURRENT}`, compareSpecVersions(c.version, SPEC_CURRENT) <= 0, true);
  }
  const n = c.numeric;
  ok(`${id}: numeric domain is a known tag`, DOMAIN_TAGS.includes(n.domain), true);
  ok(`${id}: domain evidence is non-empty`, n.domainEvidence.trim().length > 0, true);
  ok(`${id}: decoder policy is a known value or null`, POLICIES.includes(n.decoderPolicy), true);
  ok(`${id}: encoder policy is a known value or null`, POLICIES.includes(n.encoderPolicy), true);
  ok(`${id}: policy evidence is non-empty (null is a FINDING, so it needs a source)`, n.policyEvidence.trim().length > 0, true);
  ok(`${id}: numeric verified is YYYY-MM-DD`, DATE_RE.test(n.verified), true);
}

console.log("Part 2: derivation (adapters can never drift from claims)");
for (const id of ids) {
  ok(`SPEC_VERSION_CLAIMS.${id} matches IMPL_CLAIMS.${id}.version`, SPEC_VERSION_CLAIMS[id], IMPL_CLAIMS[id].version);
  ok(`NUMERIC_DOMAINS.${id} matches IMPL_CLAIMS.${id}.numeric.domain`, NUMERIC_DOMAINS[id], IMPL_CLAIMS[id].numeric.domain);
}

console.log("Part 3: content pins");
ok("ts claims 3.3", IMPL_CLAIMS.ts.version, "3.3");
ok("python claims nothing", IMPL_CLAIMS.python.version, null);
ok("python identity note names the install mechanism", (IMPL_CLAIMS.python.notes ?? "").includes("git commit"), true);
ok("rust claims 3.0 (the corrected value, NOT 3.2)", IMPL_CLAIMS.rust.version, "3.0");
ok("rust notes record the 3.2 correction", (IMPL_CLAIMS.rust.notes ?? "").includes("CORRECTION"), true);
// Promotion tripwire: while rust claims 3.0, its notes must carry the pending
// #71 bump. When #71 merges and version moves to 3.3, this check MUST be
// updated in the same commit — that is the point.
ok("rust notes carry the pending #71 bump", (IMPL_CLAIMS.rust.notes ?? "").includes("#71"), true);

console.log("Part 4: numeric domains (three DISTINCT models, nested for integers)");
ok("ts domain is f64", IMPL_CLAIMS.ts.numeric.domain, "f64");
// MEASURED 2026-08-30, not read off serde_json's model: the tag was "i64u64f64"
// and the f64 half was fiction — 2^100 is an exact double and rust stringifies
// it. The domain is the i64/u64 window alone. See domainEvidence for the ladder.
ok("rust domain is i64u64 (the window ALONE — no f64 fallback, measured)", IMPL_CLAIMS.rust.numeric.domain, "i64u64");
// The falsified claim must not creep back in a later edit.
ok("rust domainEvidence records the measurement, not the serde_json reading",
  IMPL_CLAIMS.rust.numeric.domainEvidence.includes("MEASURED 2026-08-30"), true);
ok("rust domainEvidence states there is no f64 fallback",
  IMPL_CLAIMS.rust.numeric.domainEvidence.includes("NO f64 FALLBACK"), true);
// The lossless-string observation is what turns the filing from "loses data"
// into "undocumented"; losing it would make the report unfair upstream.
ok("rust notes record the caveat as discharged by measurement",
  IMPL_CLAIMS.rust.numeric.notes!.includes("CAVEAT LARGELY DISCHARGED"), true);
ok("rust decoderPolicy is STILL null — behaviour observed, documentation absent",
  IMPL_CLAIMS.rust.numeric.decoderPolicy, null);
ok("python domain is bignum", IMPL_CLAIMS.python.numeric.domain, "bignum");
// The domains must be distinct, or the matrix has no numeric fault line to
// find: 2^53+1 separates ts from the other two, and the u64 boundary
// separates rust from python.
ok(
  "the three domains are pairwise distinct",
  new Set(ids.map((id) => IMPL_CLAIMS[id].numeric.domain)).size,
  3,
);
// Domains are evidenced IN-REPO (adapter ingestion), not from upstream
// marketing — each must name the file that proves it.
ok("ts domain evidence names its ingestion path", IMPL_CLAIMS.ts.numeric.domainEvidence.includes("JSON.parse"), true);
ok("rust domain evidence names the serde_json feature choice", IMPL_CLAIMS.rust.numeric.domainEvidence.includes("arbitrary_precision"), true);
ok("python domain evidence names its ingestion path", IMPL_CLAIMS.python.numeric.domainEvidence.includes("json.loads"), true);

console.log("Part 5: out-of-range policies (encoder §3+§2 and decoder §4 are INDEPENDENT)");
// ts WAS the self-contradiction on both sides. PR #331 closed the decoder
// half only, so the finding did not go away — it sharpened: one file now
// documents silent rounding AND promises lossless round-trips.
ok("ts documents an approximate decoder policy (#331)", IMPL_CLAIMS.ts.numeric.decoderPolicy, "approximate");
ok("ts documents no encoder policy", IMPL_CLAIMS.ts.numeric.encoderPolicy, null);
ok("ts still affirmatively claims losslessness (the sharpened contradiction)", IMPL_CLAIMS.ts.numeric.claimsLossless, true);
ok("rust is silent, not self-contradicting", IMPL_CLAIMS.rust.numeric.claimsLossless, false);
ok("python is silent, not self-contradicting", IMPL_CLAIMS.python.numeric.claimsLossless, false);
// The asymmetry IS the v0.4 thesis in one line: a documented decoder next to
// an undocumented encoder. The old both-or-neither model could not state it,
// so it gets its own named check rather than being inferred from the two
// field checks above.
ok(
  "ts decoder is documented while its encoder is not (the per-side split)",
  IMPL_CLAIMS.ts.numeric.decoderPolicy !== null && IMPL_CLAIMS.ts.numeric.encoderPolicy === null,
  true,
);
// Evidence rule, same discipline the null policies carry: a claim sourced
// from an upstream MERGE must name the merge commit, in both the notes and
// the policy evidence. A future reader must not have to trust the date.
ok("ts notes cite the #331 merge commit", (IMPL_CLAIMS.ts.numeric.notes ?? "").includes("52653ce"), true);
ok("ts policy evidence cites the #331 merge commit", IMPL_CLAIMS.ts.numeric.policyEvidence.includes("52653ce"), true);
// #331 is DECODER-ONLY: the encoder gap must be recorded as surviving it, or
// a merge would silently look like a full fix.
ok("ts notes record that #331 leaves the encoder gap open", (IMPL_CLAIMS.ts.numeric.notes ?? "").includes("DECODER-ONLY"), true);
// upstream's documented policy is three-way; OutOfRangePolicy holds one value.
// The gap must be recorded where the claim lives, not left to memory.
ok("ts notes record the single-valued policy model limit", (IMPL_CLAIMS.ts.numeric.notes ?? "").includes("MODEL LIMIT"), true);
// The rust u64 boundary is OUR harness model, not upstream policy — the
// caveat must travel with the claim so it is never filed as a bug.
ok("rust notes flag the boundary as an adapter artifact", (IMPL_CLAIMS.rust.numeric.notes ?? "").includes("ADAPTER"), true);
// python's null means "no boundary exists", not "undocumented".
ok("python notes distinguish not-applicable from a docs gap", (IMPL_CLAIMS.python.numeric.notes ?? "").includes("NOT-APPLICABLE"), true);

console.log();
if (fail === 0) {
  console.log(`IMPL CLAIMS PROVEN: ${pass} checks pass. Claims carry evidence and dates; the adapter-facing shapes derive from the single source; the rust correction is pinned; the three numeric domains are distinct and in-repo evidenced; encoder and decoder policies are recorded independently; the #329 tripwire has FIRED and is recorded post-merge as #331, and the #71 tripwire stays armed.`);
} else {
  console.log(`IMPL CLAIMS FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
