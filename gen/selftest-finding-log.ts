// gen/selftest-finding-log.ts
//
// Proves gen/finding-log.ts. The module is pure, so all of this runs in the
// sandbox with no adapters, no venv and no network -- which is the entire reason
// the parser was moved out of shrink-cli.ts.
//
// Run: node --experimental-strip-types gen/selftest-finding-log.ts
//
// The total is computed at RUNTIME rather than written by hand. A hand-written
// count drifted from the printed checks three times during the property layer's
// development, and a wrong count is worse than no count when the number is a
// promotion tripwire.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dedupeFindings, parseFindingLog, refusalReport, splitByVersion,
} from "./finding-log.ts";
import type { Finding, PropertyFinding } from "./finding-log.ts";
import { PROPERTY_GEN_VERSION } from "./property.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean): void => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(` FAIL  ${name}`); }
};

// Exact bytes fuzz.ts printFinding emits. Retyped from the source, not invented:
// mutation findings carry seed=/rngSeed=/maxOps= in the LABEL, property findings
// carry the recipe there instead.
const MUTATION_LOG = [
  `ts → python   ✗   seed=seeds/004-uniform-table.json rngSeed=7029941 maxOps=3`,
  `  recipe:   BumpNumber(2^53+1) -> LookalikeInject(#3)`,
  `  expected: {"a":1}`,
  `  actual:   {"a":2}`,
  `  replay:   node --experimental-strip-types gen/replay-case.ts seeds/004-uniform-table.json 7029941 3`,
  ``,
].join("\n");

const PROPERTY_LOG = [
  `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059844/40`,
  `  recipe:   general, 37 nodes`,
  `  expected: {"a":1}`,
  `  actual:   {"a":2}`,
  `  replay:   node --experimental-strip-types gen/replay-case.ts "prop:v${PROPERTY_GEN_VERSION}/general@1059844/40"`,
  ``,
].join("\n");

// ---- 1. the defect, made executable ---------------------------------------
// The pre-fix parser required seed=/rngSeed=/maxOps= and so returned NOTHING for a
// property-only log. This is that behaviour written down as a check, so the fix
// cannot regress silently.

{
  const legacyRe = /^(ts|python|rust) → (ts|python|rust)\s+✗\s+seed=(\S+) rngSeed=(\d+) maxOps=(\d+)/;
  const legacyHits = PROPERTY_LOG.split("\n").filter((l) => legacyRe.test(l)).length;
  check("the pre-fix regex matches ZERO lines of a property log (the defect)",
    legacyHits === 0);

  const found = parseFindingLog(PROPERTY_LOG);
  check("the new parser finds the property finding the old one could not",
    found.length === 1 && found[0].kind === "property");
}

// ---- 2. both kinds, and the mixed log -------------------------------------

{
  const mut = parseFindingLog(MUTATION_LOG);
  check("a mutation finding still parses", mut.length === 1 && mut[0].kind === "mutation");
  const m = mut[0] as Extract<Finding, { kind: "mutation" }>;
  check("mutation coordinates survive exactly",
    m.from === "ts" && m.to === "python" &&
    m.seed === "seeds/004-uniform-table.json" && m.rng === 7029941 && m.maxOps === 3);
  check("the operator chain is stripped of per-op detail for keying",
    m.ops === "BumpNumber -> LookalikeInject");

  const prop = parseFindingLog(PROPERTY_LOG)[0] as PropertyFinding;
  check("property coordinates survive exactly",
    prop.from === "ts" && prop.to === "python" &&
    prop.identity.channel === "general" && prop.identity.rngSeed === 1059844 &&
    prop.identity.size === 40 && prop.identity.version === PROPERTY_GEN_VERSION);
  check("the recipe round-trips as printed",
    prop.recipe === `prop:v${PROPERTY_GEN_VERSION}/general@1059844/40`);

  // THE SKEW NOTE. printFinding appends "[claimed-spec skew X vs Y]" after the
  // label when a pair's claimed spec versions differ. An end-of-line anchor here
  // dropped 29 of 124 findings in the first real run -- every ts<->rust finding.
  // Retyping printFinding's output is what hid it: the note only appears when two
  // adapters disagree, so a hand-built fixture never has one.
  const SKEWED = `ts → rust   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1000003/40   [claimed-spec skew 3.3 vs 3.0]`;
  const skewed = parseFindingLog(SKEWED);
  check("a finding carrying a skew note still parses", skewed.length === 1);
  check("the skew note is not captured into the recipe",
    (skewed[0] as PropertyFinding).recipe === `prop:v${PROPERTY_GEN_VERSION}/general@1000003/40`);
  check("a skewed and an unskewed finding of the same case dedup together",
    dedupeFindings(parseFindingLog(
      SKEWED + "\n" + `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1000003/40`)).length === 1);

  const mixed = parseFindingLog(MUTATION_LOG + "\n" + PROPERTY_LOG);
  check("a mixed log yields both kinds", mixed.length === 2 &&
    mixed.filter((f) => f.kind === "mutation").length === 1 &&
    mixed.filter((f) => f.kind === "property").length === 1);
  check("the two kinds are distinguishable without re-parsing the line",
    mixed.every((f) => f.kind === "mutation" || f.kind === "property"));
}

// ---- 3. noise tolerance ---------------------------------------------------
// A real fuzz-out.txt carries the run manifest, prose and progress lines. The
// parser runs over the whole file, so anything it does NOT recognise must be
// ignored rather than guessed at.

{
  const noisy = [
    `RUN MANIFEST`,
    `  plan:      mode=prop cases=20 per=20 size=40`,
    `  findings:  178 divergences, 31 errors`,
    `    118x  number-changed`,
    PROPERTY_LOG,
    `  verdict:   RAN-FOUND (exit 1)`,
  ].join("\n");
  check("manifest and prose lines are ignored", parseFindingLog(noisy).length === 1);

  check("an empty log yields no findings", parseFindingLog("").length === 0);
  check("a clean run's output yields no findings",
    parseFindingLog("NO DIVERGENCES | cases: 20/20 | pair-checks: 180").length === 0);

  // A malformed recipe must be DROPPED, never guessed at: parseIdentity rejects
  // unknown channels, so a typo cannot silently become a replay target.
  const bogus = `ts → python   ✗   prop:v1/notachannel@5/40`;
  check("a recipe with an unknown channel is dropped, not guessed",
    parseFindingLog(bogus).length === 0);
  const truncated = `ts → python   ✗   prop:v1/general@5`;
  check("a structurally malformed recipe is dropped", parseFindingLog(truncated).length === 0);

  // A ✓ line is not a finding.
  check("a passing line is not a finding",
    parseFindingLog(`ts → python   ✓   prop:v1/general@1059844/40`).length === 0);
}

// ---- 4. dedup: one shrink per distinct CASE, not per pair ------------------
// The point of the asymmetry. captureSignatures already captures every failing
// pair from one case, so a nine-pair property case is ONE shrink target.

{
  const ninePairs = ["ts", "python", "rust"].flatMap((a) =>
    ["ts", "python", "rust"].map((b) =>
      `${a} → ${b}   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059844/40`)).join("\n");
  const parsed = parseFindingLog(ninePairs);
  check("nine pairs of one property case parse as nine records", parsed.length === 9);
  check("...and dedup to ONE shrink target", dedupeFindings(parsed).length === 1);

  const twoCases = parseFindingLog([
    `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059844/40`,
    `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059845/40`,
  ].join("\n"));
  check("two distinct property cases stay apart", dedupeFindings(twoCases).length === 2);

  check("the same case at a different SIZE is a different case",
    dedupeFindings(parseFindingLog([
      `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059844/40`,
      `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059844/20`,
    ].join("\n"))).length === 2);

  check("the same case on a different CHANNEL is a different case",
    dedupeFindings(parseFindingLog([
      `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1059844/40`,
      `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/shape-deep-nest@1059844/40`,
    ].join("\n"))).length === 2);

  // Mutation keying is UNCHANGED by this commit, including its from/to component.
  const mutTwoPairs = parseFindingLog([
    MUTATION_LOG,
    MUTATION_LOG.replace("ts → python", "ts → rust"),
  ].join("\n"));
  check("mutation dedup still keys on the pair, as before this change",
    dedupeFindings(mutTwoPairs).length === 2);
  check("an identical mutation finding still collapses",
    dedupeFindings(parseFindingLog(MUTATION_LOG + "\n" + MUTATION_LOG)).length === 1);
}

// ---- 5. version refusal, and its REPORTING half ---------------------------
// decisions.md: a tool that reads its own artifact format refuses a version it
// does not recognise. The half that is easy to lose is saying so out loud.

{
  const older = PROPERTY_GEN_VERSION - 1;
  const newer = PROPERTY_GEN_VERSION + 1;
  const mixed = parseFindingLog([
    `ts → python   ✗   prop:v${PROPERTY_GEN_VERSION}/general@1/40`,
    `ts → python   ✗   prop:v${older}/general@2/40`,
    `ts → python   ✗   prop:v${newer}/general@3/40`,
  ].join("\n"));

  check("a recipe from another version still PARSES, so it can be reported",
    mixed.length === 3);

  const split = splitByVersion(mixed, PROPERTY_GEN_VERSION);
  check("only current-version recipes are replayable", split.current.length === 1);
  check("older and newer versions are both refused", split.refused.size === 2);
  check("refusal groups by the version named", split.refused.get(older)!.length === 1);

  const report = refusalReport(split, PROPERTY_GEN_VERSION);
  check("a refusal is REPORTED, not silently skipped", report.length > 0);
  check("the report states how many were refused",
    report[0].includes("2 property recipe(s)"));
  check("the report names the current build version",
    report[0].includes(`v${PROPERTY_GEN_VERSION}`));
  check("the report gives an example recipe so the reader can check it",
    report.some((l) => l.includes("prop:v")));
  check("the report points at stored case bytes as authoritative",
    report.some((l) => l.includes("authoritative")));

  check("nothing is refused when every recipe is current",
    refusalReport(splitByVersion(parseFindingLog(PROPERTY_LOG), PROPERTY_GEN_VERSION),
      PROPERTY_GEN_VERSION).length === 0);

  // The failure this guards: after a bump, an old log is ENTIRELY stale recipes.
  // Silently skipping would render that as "no findings" -- indistinguishable from
  // a clean run, which is the did-not-run collapse one layer down.
  const allStale = parseFindingLog(
    `ts → python   ✗   prop:v${older}/general@2/40`);
  const staleSplit = splitByVersion(allStale, PROPERTY_GEN_VERSION);
  check("an all-stale log yields zero replayable targets", staleSplit.current.length === 0);
  check("...and does NOT look like a clean run",
    refusalReport(staleSplit, PROPERTY_GEN_VERSION).length > 0);

  check("mutation findings are unaffected by a property version bump",
    splitByVersion(parseFindingLog(MUTATION_LOG), PROPERTY_GEN_VERSION + 99).current.length === 0 &&
    parseFindingLog(MUTATION_LOG).length === 1);
}

// ---- 6. purity ------------------------------------------------------------
// The reason this module exists. Checked by IMPORT GRAPH, not by source grep.

{
  const src = readFileSync(fileURLToPath(new URL("./finding-log.ts", import.meta.url)), "utf8");
  const imports = [...new Set(
    [...src.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]),
  )];
  check(`finding-log.ts imports only ./property.ts (${imports.join(", ") || "none"})`,
    imports.every((i) => i === "./property.ts"));
  check("finding-log.ts imports no adapter", imports.every((i) => !i.includes("adapters")));
  check("finding-log.ts imports no node builtin (no fs, no url)",
    imports.every((i) => !i.startsWith("node:")));
}

console.log(
  fail === 0
    ? `\nFINDING LOG PROVEN: ${pass} checks pass. Every property finding in a run is now reachable by the batch shrinker, and a stale recipe is refused out loud.`
    : `\nFINDING LOG BROKEN: ${fail} of ${pass + fail} check(s) failed.`,
);
if (fail > 0) process.exitCode = 1;
