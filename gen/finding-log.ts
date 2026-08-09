// gen/finding-log.ts
//
// Parse a fuzz-out.txt back into finding coordinates. PURE: no fs, no adapters,
// no I/O -- it takes the text and returns records.
//
// WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE shrink-cli.ts. shrink-cli.ts
// imports the three adapters, so it cannot run in the sandbox at all, so nothing
// proved its parsing. That is the same argument that pulled the run accounting out
// of fuzz.ts, applied to the same file's other half: if a thing cannot be tested
// where testing is cheap, move the thing.
//
// THE DEFECT THIS CLOSES. The batch shrinker matched ONE line shape, the mutation
// one:
//
//   ts → python   ✗   seed=seeds/004-uniform-table.json rngSeed=7029941 maxOps=3
//     recipe:   BumpNumber(...) -> LookalikeInject(...)
//
// A property finding prints its recipe as the LABEL instead:
//
//   ts → python   ✗   prop:v1/general@1059844/40
//     recipe:   general, 37 nodes
//
// which matched nothing, so every property finding in a run was invisible to
// --batch. That is why toon-rust#78 took eight hand-written probe scripts, and why
// a property finding could not mechanically produce the minimal witness the
// proof-carrying template requires.

import { parseIdentity } from "./property.ts";
import type { PropertyIdentity } from "./property.ts";

export interface MutationFinding {
  kind: "mutation";
  from: string;
  to: string;
  seed: string;
  rng: number;
  maxOps: number;
  /** Operator chain with per-op detail stripped, used as the dedup key. */
  ops: string;
}

export interface PropertyFinding {
  kind: "property";
  from: string;
  to: string;
  /** The recipe exactly as printed, e.g. "prop:v1/general@1059844/40". */
  recipe: string;
  identity: PropertyIdentity;
}

export type Finding = MutationFinding | PropertyFinding;

const PAIR = String.raw`^(ts|python|rust) → (ts|python|rust)\s+✗\s+`;
const MUTATION_RE = new RegExp(PAIR + String.raw`seed=(\S+) rngSeed=(\d+) maxOps=(\d+)`);
// The property label is the recipe itself. Two things about this pattern are
// load-bearing and neither is obvious:
//
// 1. ANCHORED ON THE "prop:" PREFIX, not on the full recipe grammar, so a recipe
//    from a FUTURE generator version still parses into a record. It has to, or
//    the version refusal below could never report it and a post-bump log would
//    look like a run with no property findings at all.
//
// 2. NOT ANCHORED AT END OF LINE. printFinding appends a skew note after the
//    label -- "prop:v1/general@1000003/40   [claimed-spec skew 3.3 vs 3.0]" --
//    whenever the pair's claimed spec versions differ. An end anchor silently
//    dropped EVERY finding on a skewed pair: 29 of 124 in the first real run this
//    was tried against, all of them ts<->rust. It was invisible to a selftest
//    built from retyped printFinding output, because the note only appears when
//    two adapters disagree about their claimed spec version.
const PROPERTY_RE = new RegExp(PAIR + String.raw`(prop:\S+)`);

/**
 * Parse fuzz output into finding records. Unrecognised lines are ignored, which is
 * what lets this run over a whole fuzz-out.txt including its manifest and prose.
 */
export function parseFindingLog(text: string): Finding[] {
  const lines = text.split("\n");
  const out: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const p = PROPERTY_RE.exec(line);
    if (p) {
      const identity = parseIdentity(p[3]);
      // A malformed recipe is DROPPED, not guessed at. parseIdentity already
      // rejects unknown channels, so a typo cannot become a replay target.
      if (identity) out.push({ kind: "property", from: p[1], to: p[2], recipe: p[3], identity });
      continue;
    }

    const m = MUTATION_RE.exec(line);
    if (m) {
      let ops = "";
      const rm = /^\s*recipe:\s*(.*)$/.exec(lines[i + 1] ?? "");
      if (rm) ops = rm[1].replace(/\([^)]*\)/g, "").trim();
      out.push({
        kind: "mutation",
        from: m[1], to: m[2],
        seed: m[3], rng: parseInt(m[4], 10), maxOps: parseInt(m[5], 10),
        ops,
      });
      continue;
    }
  }
  return out;
}

/**
 * Collapse findings to the set of distinct cases worth shrinking.
 *
 * THE TWO KINDS DEDUP DIFFERENTLY, AND THE ASYMMETRY IS DELIBERATE.
 *
 * A PROPERTY finding is keyed on its recipe ALONE, ignoring from/to. One property
 * case that diverges on nine pairs prints nine lines carrying identical bytes, and
 * captureSignatures already captures every failing pair from a single case -- so
 * shrinking once per DISTINCT CASE is both sufficient and correct, and shrinking
 * nine times is nine times the cost for the same minimal witness.
 *
 * A MUTATION finding keeps the pre-existing key, which includes from/to. It has
 * the same redundancy, but changing untouched behaviour in the commit that adds
 * the property path would make the diff unreviewable. Recorded as an observation;
 * see the handoff.
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = f.kind === "property"
      ? `prop|${f.recipe}`
      : `mut|${f.from}->${f.to}|${f.seed}|${f.ops}`;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()];
}

export interface VersionSplit {
  /** Recipes this build can replay. */
  current: PropertyFinding[];
  /** Recipes from another generator version, grouped by the version they name. */
  refused: Map<number, PropertyFinding[]>;
}

/**
 * Split property findings by generator version.
 *
 * A recipe from another version is REFUSED AND REPORTED, never silently skipped and
 * never replayed. The grammar is part of a case's identity, so replaying a v1
 * recipe under v2 produces DIFFERENT BYTES under the same name -- which is the
 * refuse-unrecognised-artifact-versions rule in decisions.md, and is already what
 * replayProperty does for a single case.
 *
 * The reporting half is the part that is easy to lose. After a
 * PROPERTY_GEN_VERSION bump, an old fuzz-out.txt is ENTIRELY stale recipes; a
 * silent skip would render that as "0 findings" and look exactly like a clean run.
 * That is the did-not-run/found-nothing collapse again, one layer down.
 */
export function splitByVersion(
  findings: readonly Finding[],
  currentVersion: number,
): VersionSplit {
  const current: PropertyFinding[] = [];
  const refused = new Map<number, PropertyFinding[]>();
  for (const f of findings) {
    if (f.kind !== "property") continue;
    if (f.identity.version === currentVersion) { current.push(f); continue; }
    const list = refused.get(f.identity.version) ?? [];
    list.push(f);
    refused.set(f.identity.version, list);
  }
  return { current, refused };
}

/** Human-readable refusal lines. Empty when nothing was refused. */
export function refusalReport(split: VersionSplit, currentVersion: number): string[] {
  if (split.refused.size === 0) return [];
  const lines = [
    `REFUSED: ${[...split.refused.values()].reduce((n, l) => n + l.length, 0)} property recipe(s) ` +
    `from another generator version; this build is v${currentVersion}.`,
  ];
  for (const [version, list] of [...split.refused.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`  v${version}: ${list.length} recipe(s), e.g. ${list[0].recipe}`);
  }
  lines.push(`  The grammar is part of a case's identity, so these bytes would not match.`);
  lines.push(`  Use the stored case files, which are authoritative.`);
  return lines;
}
