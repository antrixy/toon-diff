/**
 * probe/selftest-spec-rules.ts — proves the spec-rule registry.
 *
 * Part 1: the shipped registry is valid, the 002 rule is complete and citable,
 *         the 013 rule is a tracked-but-not-citable stub, and the verdict
 *         function reproduces the 002 episode mechanically (rust-at-3.0 is
 *         BEHIND, python-claiming-nothing VIOLATES CURRENT, an impl claiming
 *         a version at/after the rule VIOLATES ITS CLAIM).
 * Part 2: the version comparator is numeric, not lexicographic (3.10 > 3.9),
 *         and refuses malformed versions.
 * Part 3: against synthetic registries, validation REJECTS every class of
 *         malformation — duplicate id, non-kebab id, empty title, empty
 *         section entries, malformed introducedIn, and the changelog <->
 *         introducedIn coupling broken in either direction — and the
 *         all-or-nothing accessor refuses the whole registry.
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types probe/selftest-spec-rules.ts
 */

import {
  SPEC_RULES,
  SPEC_CURRENT,
  specRulesById,
  validateSpecRules,
  specVerdict,
  verdictText,
  compareSpecVersions,
  parseSpecVersion,
  isCitable,
  type SpecRule,
} from "./spec-rules.ts";

let pass = 0;
let fail = 0;
function ok(label: string, got: unknown, want: unknown) {
  const good = Object.is(got, want);
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// ---------- Part 1: the shipped registry ----------
console.log("Part 1: shipped registry");
ok("shipped registry validates clean", validateSpecRules().length, 0);
const rules = specRulesById();
ok("accessor returns every rule", rules.size, SPEC_RULES.length);
ok("SPEC_CURRENT is well-formed", parseSpecVersion(SPEC_CURRENT) !== null, true);

const ea = rules.get("empty-array-canonical-literal")!;
ok("002 rule present", ea !== undefined, true);
ok("002 rule is citable", isCitable(ea), true);
ok("002 rule cites four sections", ea.sections.length, 4);
ok("002 rule cites its CHANGELOG entry", ea.changelog, "[3.1] 2026-05-18");
ok("002 rule carries upstream refs", (ea.refs ?? []).length >= 2, true);
ok("002 rule constrains the decoder", ea.appliesTo, "decoder");

const ip = rules.get("integer-precision-lossless")!;
ok("013 rule present", ip !== undefined, true);
ok("013 rule is citable (promoted 2026-07-16)", isCitable(ip), true);
ok("013 rule refs its upstream filing toon#329", (ip.refs ?? []).some((r) => r.includes("issues/329")), true);
ok("013 rule cites three sections (2, 3, 4)", (ip.sections ?? []).length, 3);
ok("013 rule constrains the round trip", ip.appliesTo, "round-trip");

// The 002 episode as a truth table. Verdicts are CONDITIONAL on an observed
// divergence — explain-layer code only asks about the failing side.
console.log("Part 1b: verdict truth table (002 rule, introducedIn 3.1)");
ok("claims 3.0 (predates rule) -> behind", specVerdict("3.0", ea), "behind");
ok("claims null -> violates-current", specVerdict(null, ea), "violates-current");
ok("claims 3.1 (rule's own version) -> violates-claimed", specVerdict("3.1", ea), "violates-claimed");
ok("claims 3.3 (after rule) -> violates-claimed", specVerdict("3.3", ea), "violates-claimed");
ok("rule with introducedIn null binds any claimed version", specVerdict("3.0", ip), "violates-claimed");
ok("rule with introducedIn null, claim null -> violates-current", specVerdict(null, ip), "violates-current");

ok("behind text names the claimed version", verdictText("behind", "3.0").includes("3.0"), true);
ok("behind text says not violating", verdictText("behind", "3.0").includes("not violating"), true);
ok("violates-current text names current spec", verdictText("violates-current", null).includes(SPEC_CURRENT), true);
ok("violates-claimed text names the claim", verdictText("violates-claimed", "3.3").includes("3.3"), true);

// ---------- Part 2: version comparator ----------
console.log("Part 2: version comparator");
ok("3.0 < 3.1", compareSpecVersions("3.0", "3.1"), -1);
ok("3.3 == 3.3", compareSpecVersions("3.3", "3.3"), 0);
ok("3.10 > 3.9 (numeric, not lexicographic)", compareSpecVersions("3.10", "3.9"), 1);
ok("4.0 > 3.9 (major dominates)", compareSpecVersions("4.0", "3.9"), 1);
ok("parse rejects 3", parseSpecVersion("3"), null);
ok("parse rejects 3.1.2", parseSpecVersion("3.1.2"), null);
ok("parse rejects v3.1", parseSpecVersion("v3.1"), null);
ok("parse rejects empty", parseSpecVersion(""), null);
{
  let threw = "";
  try {
    compareSpecVersions("3.x", "3.1");
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("compare throws on malformed input", threw.includes("malformed spec version"), true);
  ok("compare names the offender", threw.includes("3.x"), true);
}

// ---------- Part 3: rejection of malformed registries ----------
console.log("Part 3: malformed registries are rejected (all-or-nothing)");

const good = (over: Partial<SpecRule> = {}): SpecRule => ({
  id: "good-rule",
  title: "a valid rule",
  sections: ["1"],
  introducedIn: "3.1",
  changelog: "[3.1] 2026-05-18",
  appliesTo: "decoder",
  ...over,
});

function expectProblem(label: string, needle: string, bad: SpecRule[]) {
  const problems = validateSpecRules(bad);
  ok(`${label}: flagged`, problems.length > 0, true);
  ok(`${label}: message names the problem`, problems.some((p) => p.includes(needle)), true);
  let threw = false;
  try {
    specRulesById(bad);
  } catch {
    threw = true;
  }
  ok(`${label}: accessor refuses whole registry`, threw, true);
}

expectProblem("duplicate id", "duplicate id", [good(), good()]);
expectProblem("non-kebab id", "kebab-case", [good({ id: "Bad_ID" })]);
expectProblem("empty title", "title must be non-empty", [good({ title: "   " })]);
expectProblem("empty section entry", "sections must not contain empty entries", [good({ sections: ["4", " "] })]);
expectProblem("malformed introducedIn", "MAJOR.MINOR", [good({ introducedIn: "3.1.0" })]);
expectProblem("versioned rule without changelog", "CHANGELOG entry must be cited", [good({ changelog: null })]);
expectProblem("changelog without introducedIn", "cite both or neither", [
  good({ introducedIn: null, changelog: "[3.1] 2026-05-18" }),
]);
expectProblem("invalid appliesTo", `must be "encoder", "decoder", or "round-trip"`, [
  good({ appliesTo: "parser" as SpecRule["appliesTo"] }),
]);

// One bad rule poisons an otherwise-good registry.
{
  let threw = false;
  try {
    specRulesById([good(), good({ id: "another-good-rule" }), good({ id: "Bad_ID" })]);
  } catch {
    threw = true;
  }
  ok("all-or-nothing: 2 good + 1 bad loads nothing", threw, true);
}

// Stubs are legal: an empty-sections rule passes validation but is not citable.
{
  const stub = good({ id: "stub-rule", sections: [], introducedIn: null, changelog: null });
  ok("stub passes validation", validateSpecRules([stub]).length, 0);
  ok("stub is not citable", isCitable(stub), false);
}

console.log();
if (fail === 0) {
  console.log(`SPEC-RULE REGISTRY PROVEN: ${pass} checks pass. Verdicts encode behind/violates-claimed/violates-current; stubs are fenced; malformed registries are refused whole.`);
} else {
  console.log(`SPEC-RULE REGISTRY FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
