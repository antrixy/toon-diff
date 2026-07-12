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
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types adapters/selftest-claims.ts
 */

import { IMPL_CLAIMS, SPEC_VERSION_CLAIMS } from "./contract.ts";
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
}

console.log("Part 2: derivation (adapters can never drift from claims)");
for (const id of ids) {
  ok(`SPEC_VERSION_CLAIMS.${id} matches IMPL_CLAIMS.${id}.version`, SPEC_VERSION_CLAIMS[id], IMPL_CLAIMS[id].version);
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

console.log();
if (fail === 0) {
  console.log(`IMPL CLAIMS PROVEN: ${pass} checks pass. Claims carry evidence and dates; the adapter-facing shape derives from the single source; the rust correction is pinned.`);
} else {
  console.log(`IMPL CLAIMS FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
