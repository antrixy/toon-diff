// gen/run-manifest.ts
//
// Run accounting for gen/fuzz.ts. PURE: no adapters, no child processes, no I/O.
// That is the point of the file existing at all -- fuzz.ts cannot be self-tested
// in the sandbox because it imports the three adapters, so the accounting it was
// carrying was the one part of the harness nothing proved.
//
// THE DEFECT THIS CLOSES. fuzz.ts reported one number (findings) and one adjective
// (NO DIVERGENCES / DIVERGENCES). Three different run states rendered as those two:
//
//   1. DID NOT GENERATE. `--size 0`, `--per 0`, or a non-numeric argument yields an
//      empty channel set or an empty inner loop, and the run prints
//      "NO DIVERGENCES | cases: 0/0" and exits 0 -- byte-identical to a clean sweep.
//   2. RAN DEAD. A dead worker fails every call; each failure increments the same
//      counter a real divergence does, so a fully broken harness reports its
//      pair-check count as a divergence haul and exits 1.
//   3. RAN DEGENERATE. Cases generated, harness alive, but the findings are one
//      known class repeated. Reported identically to useful evidence.
//
// A generator that silently fails to generate must not look like one that found
// nothing. That is the whole obligation, and it is why the exit codes are split:
// exit 0 now means "the run happened and was clean", never "the run did not happen".
//
// WHAT IS NOT HERE, DELIBERATELY. No rate heuristic, no "too many findings looks
// suspicious" threshold. A share-of-findings cutoff would be exactly the
// interpretation-dependent claim the PROMISE filter rejects. Deadness is decided by
// a CANARY -- a fixed trivial case an adapter either round-trips or does not -- and
// nothing else. See AdapterHealth below for why the consecutive-error count cannot
// quarantine anything on its own.

/**
 * Exit taxonomy. 2 was already in use by fuzz.ts for usage errors; 3 is the new
 * one and carries the whole argument: a run that did not happen, did not finish,
 * or ran against a dead harness is NOT a result, and must not share an exit code
 * with "ran and found nothing".
 */
export const EXIT = {
  CLEAN: 0,
  FOUND: 1,
  USAGE: 2,
  UNTRUSTWORTHY: 3,
} as const;

export type Verdict =
  | "DID-NOT-RUN"
  | "HARNESS-DEAD"
  | "INCOMPLETE"
  | "RAN-FOUND"
  | "RAN-CLEAN";

export const EXIT_FOR: Record<Verdict, number> = {
  "DID-NOT-RUN": EXIT.UNTRUSTWORTHY,
  "HARNESS-DEAD": EXIT.UNTRUSTWORTHY,
  "INCOMPLETE": EXIT.UNTRUSTWORTHY,
  "RAN-FOUND": EXIT.FOUND,
  "RAN-CLEAN": EXIT.CLEAN,
};

// ---- plan -----------------------------------------------------------------

/**
 * What the run INTENDED to do, fixed before the first case. Kept separate from
 * the tally so that "planned" can never be back-filled from "happened" -- the
 * comparison between the two is the liveness check, and it is worthless if one
 * side is derived from the other.
 */
export interface Plan {
  mode: string;
  casesPlanned: number;
  adapters: string[];
  /** Free-form run parameters, rendered and digested in sorted-key order. */
  params: Record<string, string | number>;
}

/**
 * Reasons a plan cannot produce a trustworthy run. Non-empty means the run must
 * refuse to start -- BEFORE the loop, not after it, so that a misconfigured
 * invocation never reports a sweep it did not perform.
 *
 * parseInt yields NaN on a non-numeric argument, and NaN fails every comparison
 * silently, which is how `--size abc` reached a clean-looking exit 0. It is
 * caught here by Number.isInteger, not by a comparison.
 */
export function planProblems(p: Plan): string[] {
  const out: string[] = [];
  if (!Number.isInteger(p.casesPlanned)) {
    out.push(`casesPlanned is not an integer (${String(p.casesPlanned)}) -- check numeric arguments`);
  } else if (p.casesPlanned < 1) {
    out.push(`casesPlanned is ${p.casesPlanned}: this run would generate no cases`);
  }
  if (p.adapters.length === 0) out.push("no adapters in the pair set");
  return out;
}

/** Deterministic serialisation of the plan, sorted-key, for logs and comparison. */
export function planDigest(p: Plan): string {
  const params = Object.fromEntries(Object.keys(p.params).sort().map((k) => [k, p.params[k]]));
  return JSON.stringify({
    adapters: [...p.adapters].sort(),
    casesPlanned: p.casesPlanned,
    mode: p.mode,
    params,
  });
}

// ---- tally ----------------------------------------------------------------

/**
 * What the run ACTUALLY did. Divergences and errors are counted apart because
 * they are different claims: a divergence says two implementations disagree; an
 * error says a call did not complete, which may be a real finding or may be the
 * harness. Collapsing them is what let one dead worker read as a divergence haul.
 */
export interface Tally {
  casesGenerated: number;
  casesIngested: number;
  generatorMalformed: number;
  checksAttempted: number;
  checksCompleted: number;
  divergences: number;
  errors: number;
  selfPairDivergences: number;
  selfPairErrors: number;
  /** True when the run stopped early because --max-findings was reached. */
  capped: boolean;
  /** Adapters proven dead by a failed canary, in quarantine order. */
  quarantined: string[];
  /** Normalised error signature -> count. Insertion-ordered for stable rendering. */
  errorSignatures: Map<string, number>;
  /**
   * Normalised divergence fingerprint -> count. Insertion-ordered, same as above.
   *
   * WHY THIS EXISTS. Errors were grouped from the first version of this module and
   * divergences were not, so a run reporting "124 findings" could not say how many
   * were one input-side cause. The claim "most of it is the out-of-domain numeric
   * class" was an INFERENCE from uniform hit counts across nine pairs -- exactly the
   * shape of assumption-standing-in-for-measurement this project rejects elsewhere.
   * Grouping makes it a count.
   *
   * THE FINGERPRINT IS PASSED IN, NOT COMPUTED HERE. Classifying a divergence needs
   * the oracle; importing it would drag this module back toward the untestability
   * that pulled it out of fuzz.ts in the first place. This module owns the
   * ACCOUNTING and knows nothing about how a difference is categorised.
   */
  divergenceSignatures: Map<string, number>;
  /**
   * Divergences whose fingerprint came back "none": the caller reported a
   * divergence the oracle judges EQUAL. Counted apart rather than bucketed, because
   * it is not a divergence class -- it is the caller and the oracle disagreeing,
   * which is a defect in the harness and must not be filed as a finding.
   */
  oracleDisagreements: number;
}

export function emptyTally(): Tally {
  return {
    casesGenerated: 0,
    casesIngested: 0,
    generatorMalformed: 0,
    checksAttempted: 0,
    checksCompleted: 0,
    divergences: 0,
    errors: 0,
    selfPairDivergences: 0,
    selfPairErrors: 0,
    capped: false,
    quarantined: [],
    errorSignatures: new Map(),
    divergenceSignatures: new Map(),
    oracleDisagreements: 0,
  };
}

/**
 * The pre-split finding count, preserved so run figures recorded before this
 * module exists stay comparable. Every historical "124 findings" is
 * divergences + errors under the new accounting, not a different measurement.
 */
export function legacyFindings(t: Tally): number {
  return t.divergences + t.errors;
}

/**
 * Lines that carry no information about WHICH failure this is: python traceback
 * frames ("  File \"...\", line N"), Node/V8 frames ("    at fn (...)"), and the
 * "..." elision. Matched conservatively -- a line only counts as a frame if it
 * looks like one, so an ordinary message is never discarded.
 */
const FRAME_RE = /^\s*(at\s|File\s+"|\.{3}\s*$)/;

/**
 * Collapse an error message to a grouping key: whitespace collapsed, digit runs
 * replaced, so one dead worker's repeated failure groups into a single signature
 * with a count instead of N separate "findings". Quoted content is KEPT: in
 * "No module named 'toon_format'" the quoted name is the informative part.
 *
 * WHICH LINE. Not the first, and NOT simply the last.
 *
 * First-line-only was the original rule and it fails on python: the first line of
 * a traceback is "Traceback (most recent call last):", identical for every
 * exception, so three genuinely different python failures grouped under one
 * useless key in the live run. That is the recorded defect.
 *
 * Last-non-empty-line is the fix both handoff files propose, and it is WRONG in
 * the other direction. A Node error ends in a STACK FRAME, so last-non-empty would
 * discard the informative message line and split one error into as many signatures
 * as it has distinct frames -- over-splitting, the exact inverse of the defect, and
 * ts is the Node adapter so it would have been the common case.
 *
 * The rule that serves both: take the last non-empty line that is NOT a frame, and
 * fall back to the first line when every line is a frame. Python yields its final
 * "ValueError: ..." line; Node yields its message line; a single-line message is
 * unaffected. Both failure modes are pinned by mutations, not by this comment.
 */
export function errorSignature(message: string): string {
  const lines = message.split("\n");
  let pick = lines[0] ?? "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.trim() === "" || FRAME_RE.test(l)) continue;
    pick = l;
    break;
  }
  return pick
    .replace(/\s+/g, " ")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, 120);
}

/**
 * Collapse a divergence fingerprint to a grouping key.
 *
 * Deliberately thinner than errorSignature. Fingerprints arrive already
 * categorised by the caller ("number-changed", "container->string", ...), so there
 * is nothing to normalise except whitespace and length. Digits are NOT replaced
 * here: a fingerprint has no free-text numbers to normalise away, and blanking
 * them would collapse categories that legitimately carry an index.
 */
export function divergenceSignature(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function recordOk(t: Tally): void {
  t.checksAttempted++;
  t.checksCompleted++;
}

/**
 * A divergence, with its fingerprint REQUIRED rather than optional-with-a-default.
 *
 * There is exactly one call site and it can always classify, so a default would buy
 * nothing and cost the invariant: an optional parameter lets a future call site
 * silently record an unclassified divergence, which is the bare-counter defect
 * wearing a parameter. A caller that genuinely cannot classify must say so with an
 * explicit fingerprint, not by omission.
 *
 * A fingerprint of "none" means the oracle judges the two trees EQUAL, so the
 * caller and the oracle disagree about whether this is a divergence at all. That is
 * a harness defect, not a finding: it is counted apart and kept out of the
 * signature histogram so it can never be filed upstream as a divergence class.
 */
export function recordDivergence(t: Tally, from: string, to: string, fingerprint: string): void {
  t.checksAttempted++;
  t.checksCompleted++;
  t.divergences++;
  if (from === to) t.selfPairDivergences++;
  if (fingerprint === "none") {
    t.oracleDisagreements++;
    return;
  }
  const sig = divergenceSignature(fingerprint);
  t.divergenceSignatures.set(sig, (t.divergenceSignatures.get(sig) ?? 0) + 1);
}

export function recordError(t: Tally, from: string, to: string, message: string): void {
  t.checksAttempted++;
  t.errors++;
  if (from === to) t.selfPairErrors++;
  const sig = errorSignature(message);
  t.errorSignatures.set(sig, (t.errorSignatures.get(sig) ?? 0) + 1);
}

// ---- adapter health -------------------------------------------------------

/**
 * A canary is a fixed trivial case an adapter either round-trips or does not.
 * It is deliberately NOT a seed and NOT a property case: its job is to prove the
 * pipe is open, not to test TOON. If this value ever becomes interesting, the
 * canary has stopped being a canary.
 */
export const CANARY_JSON = '{"a":1}';

export interface CanaryResult {
  adapter: string;
  ok: boolean;
  error?: string;
}

/** Adapters that failed the preflight canary. Non-empty means do not sweep. */
export function failedCanaries(results: readonly CanaryResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => r.adapter);
}

/**
 * Mid-run death detection.
 *
 * THE THRESHOLD DOES NOT DECIDE ANYTHING. A run of consecutive errors from one
 * adapter is not evidence of death -- a genuine fault class can fail many cases
 * in a row, and quarantining on a count alone would hide real findings. The
 * count only decides WHEN TO SPEND A CANARY CALL. The canary decides deadness.
 *
 * Consequence, and it is the property worth checking: a passing re-canary can
 * never quarantine an adapter, no matter how high the consecutive count goes.
 */
export const RECANARY_AFTER = 3;

export class AdapterHealth {
  private consecutive = new Map<string, number>();
  private dead = new Set<string>();
  // Declared as a field rather than a constructor parameter property: the
  // repo runs under --experimental-strip-types, which rejects the shorthand.
  private readonly recanaryAfter: number;

  constructor(recanaryAfter: number = RECANARY_AFTER) {
    this.recanaryAfter = recanaryAfter;
  }

  noteOk(adapter: string): void {
    this.consecutive.set(adapter, 0);
  }

  noteError(adapter: string): void {
    this.consecutive.set(adapter, (this.consecutive.get(adapter) ?? 0) + 1);
  }

  /** True when enough consecutive errors have accrued to be worth a canary call. */
  shouldRecanary(adapter: string): boolean {
    return !this.dead.has(adapter) && (this.consecutive.get(adapter) ?? 0) >= this.recanaryAfter;
  }

  /** Record a canary outcome. Only a FAILED canary quarantines. */
  noteCanary(adapter: string, ok: boolean): void {
    if (ok) this.consecutive.set(adapter, 0);
    else this.dead.add(adapter);
  }

  isDead(adapter: string): boolean {
    return this.dead.has(adapter);
  }

  deadAdapters(): string[] {
    return [...this.dead];
  }

  consecutiveErrors(adapter: string): number {
    return this.consecutive.get(adapter) ?? 0;
  }
}

// ---- verdict --------------------------------------------------------------

export interface RunState {
  plan: Plan;
  tally: Tally;
}

/**
 * Ordered rules, first match wins. Written as data rather than an if-chain so
 * that two properties can be CHECKED rather than asserted: that the list is
 * total (the final predicate is unconditional) and that no rule is dead (each is
 * the first match for at least one reachable state). A default branch in an
 * if-chain would satisfy neither.
 *
 * Order carries the argument. Plan validity precedes everything, because a run
 * that could not have generated anything has no findings to report. Deadness
 * precedes incompleteness, because a dead harness is why a run is short.
 * Capping precedes incompleteness, because a capped run stopped on purpose.
 *
 * DID-NOT-RUN IS SPLIT IN TWO, AND THE SPLIT IS LOAD-BEARING. A failed canary
 * preflight aborts before the first case, so casesGenerated is 0 -- but the
 * plan was fine and the environment was not. Collapsing the two clauses reported
 * a dead python worker as a bad invocation, which points the reader at their
 * command line instead of their venv. Found by running the driver, not by
 * reading it.
 */
export const VERDICT_RULES: readonly { verdict: Verdict; when: (s: RunState) => boolean }[] = [
  {
    verdict: "DID-NOT-RUN",
    when: (s) => planProblems(s.plan).length > 0,
  },
  {
    verdict: "HARNESS-DEAD",
    when: (s) =>
      s.tally.quarantined.length > 0 ||
      (s.tally.checksAttempted > 0 && s.tally.checksCompleted === 0),
  },
  {
    verdict: "DID-NOT-RUN",
    when: (s) => s.tally.casesGenerated < 1,
  },
  {
    verdict: "INCOMPLETE",
    when: (s) => !s.tally.capped && s.tally.casesGenerated !== s.plan.casesPlanned,
  },
  {
    verdict: "RAN-FOUND",
    when: (s) => s.tally.divergences > 0 || s.tally.errors > 0,
  },
  {
    verdict: "RAN-CLEAN",
    when: () => true,
  },
];

export function classify(s: RunState): Verdict {
  for (const r of VERDICT_RULES) if (r.when(s)) return r.verdict;
  // Unreachable while the final rule is unconditional, which is checked in
  // gen/selftest-run-manifest.ts obligation 7.
  throw new Error("verdict rules are not total");
}

export function exitCodeFor(s: RunState): number {
  return EXIT_FOR[classify(s)];
}

// ---- rendering ------------------------------------------------------------

const NONE = "(none)";

/**
 * The legacy summary line, byte-shape unchanged, so a run recorded before this
 * module is comparable with one recorded after. It is no longer the verdict --
 * the manifest below is -- but it stays because deleting it would silently
 * invalidate every figure in the handoff history.
 */
export function legacyLine(s: RunState): string {
  const f = legacyFindings(s.tally);
  return `${f === 0 ? "NO DIVERGENCES" : `DIVERGENCES: ${f}`}` +
    ` | cases: ${s.tally.casesGenerated}/${s.plan.casesPlanned}` +
    ` | pair-checks: ${s.tally.checksAttempted}` +
    ` | generator-malformed: ${s.tally.generatorMalformed}` +
    (s.tally.capped ? " | (capped)" : "");
}

/** Deterministic over (plan, tally): same inputs, same bytes. */
export function renderManifest(s: RunState): string {
  const { plan, tally } = s;
  const verdict = classify(s);
  const problems = planProblems(plan);

  const params = Object.keys(plan.params).sort().map((k) => `${k}=${plan.params[k]}`).join(" ");
  const lines: string[] = [];

  lines.push("RUN MANIFEST");
  lines.push(`  plan:      mode=${plan.mode} cases=${plan.casesPlanned} ${params}`);
  lines.push(`  digest:    ${planDigest(plan)}`);
  lines.push(
    `  generated: ${tally.casesGenerated}/${plan.casesPlanned} cases` +
    `, ${tally.casesIngested} ingested, ${tally.generatorMalformed} generator-malformed`,
  );
  lines.push(
    `  harness:   ${plan.adapters.join(", ") || NONE}` +
    ` | quarantined: ${tally.quarantined.join(", ") || NONE}`,
  );
  lines.push(
    `  checks:    ${tally.checksAttempted} attempted` +
    `, ${tally.checksCompleted} completed, ${tally.errors} errored`,
  );
  lines.push(
    `  findings:  ${tally.divergences} divergences, ${tally.errors} errors` +
    ` (self-pairs: ${tally.selfPairDivergences} divergences, ${tally.selfPairErrors} errors)`,
  );

  if (tally.divergenceSignatures.size > 0) {
    lines.push(`  divergence signatures:`);
    for (const [sig, n] of [...tally.divergenceSignatures.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      lines.push(`    ${String(n).padStart(6)}x  ${sig}`);
    }
  }

  if (tally.errorSignatures.size > 0) {
    lines.push(`  error signatures:`);
    for (const [sig, n] of [...tally.errorSignatures.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
      lines.push(`    ${String(n).padStart(6)}x  ${sig}`);
    }
  }

  for (const p of problems) lines.push(`  problem:   ${p}`);

  // Not a finding and not a class: the caller called it a divergence and the oracle
  // called the trees equal. Rendered as a DEFECT so it cannot be mistaken for a
  // thin result, and kept out of the histogram above so it cannot be filed.
  if (tally.oracleDisagreements > 0) {
    lines.push(`  defect:    ${tally.oracleDisagreements} divergence(s) the oracle judges EQUAL.`);
    lines.push(`             The harness and the oracle disagree; fix that before triaging anything here.`);
  }

  // A self-pair divergence is legitimate signal -- an implementation disagreeing
  // with itself is the 013 precision class -- so this is a pointer, not a verdict.
  if (tally.selfPairErrors > 0) {
    lines.push(`  note:      ${tally.selfPairErrors} self-pair error(s): a call that never completed against`);
    lines.push(`             one implementation alone. Check the environment before triaging as findings.`);
  }

  lines.push(`  verdict:   ${verdict} (exit ${EXIT_FOR[verdict]})`);
  return lines.join("\n");
}
