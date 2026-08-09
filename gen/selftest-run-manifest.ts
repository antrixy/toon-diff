// gen/selftest-run-manifest.ts
//
// Proves gen/run-manifest.ts. PURE -- no adapters, no network -- which is the
// reason the accounting was extracted from fuzz.ts in the first place: fuzz.ts
// imports the three adapters and therefore cannot be run in the sandbox at all,
// so its summary logic was the one part of the harness nothing proved.
//
// THE OBLIGATION BEING PROVEN, in one sentence: a run that did not happen must
// not be reportable as a run that found nothing. Obligations 1, 2 and 8 are that
// sentence in three forms; 4 is its loud twin (a dead harness must not be
// reportable as a divergence haul).
//
// Each numbered section below is one obligation, and each was written with the
// MUTATION that must turn it red already in mind -- the mutation pass is a
// separate script, but a check nobody knows how to break is not a tripwire.
//
// Run: node --experimental-strip-types gen/selftest-run-manifest.ts

import {
  AdapterHealth, CANARY_JSON, EXIT, EXIT_FOR, RECANARY_AFTER, VERDICT_RULES,
  classify, emptyTally, errorSignature, exitCodeFor, failedCanaries,
  divergenceSignature,
  legacyFindings, legacyLine, planDigest, planProblems, recordDivergence,
  recordError, recordOk, renderManifest,
} from "./run-manifest.ts";
import type { Plan, RunState, Tally, Verdict } from "./run-manifest.ts";

let failures = 0;
let total = 0;
function check(label: string, ok: boolean) {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

const ADAPTERS = ["ts", "python", "rust"];

function plan(over: Partial<Plan> = {}): Plan {
  return {
    mode: "prop",
    casesPlanned: 140,
    adapters: ADAPTERS,
    params: { per: 20, size: 40, channels: 7 },
    ...over,
  };
}

function tally(over: Partial<Tally> = {}): Tally {
  return { ...emptyTally(), ...over };
}

const state = (p: Partial<Plan>, t: Partial<Tally>): RunState =>
  ({ plan: plan(p), tally: tally(t) });

/** A run that generated everything it planned and completed every check. */
const healthy = (t: Partial<Tally> = {}): RunState => state({}, {
  casesGenerated: 140, casesIngested: 140, checksAttempted: 1260, checksCompleted: 1260, ...t,
});

// ---- 1. zero planned cases is a configuration error, not a result ---------
// The four invocations verified against the live driver before this module
// existed: --size 0, --size abc, --per 0, --per abc. All four printed
// "NO DIVERGENCES" and exited 0. Each is pinned here as its own check.

{
  const zero = state({ casesPlanned: 0 }, {});
  check("zero planned cases classifies DID-NOT-RUN", classify(zero) === "DID-NOT-RUN");
  check("zero planned cases exits 3, not 0", exitCodeFor(zero) === EXIT.UNTRUSTWORTHY);
  check("zero planned cases is never RAN-CLEAN", classify(zero) !== "RAN-CLEAN");
  check("planProblems names the zero-case plan", planProblems(plan({ casesPlanned: 0 })).length === 1);

  // Planned > 0 but the source yielded nothing: --per 0 with channels present.
  const generatedNone = state({ casesPlanned: 140 }, { casesGenerated: 0 });
  check("planned cases but none generated is DID-NOT-RUN",
    classify(generatedNone) === "DID-NOT-RUN" && exitCodeFor(generatedNone) === EXIT.UNTRUSTWORTHY);

  // The distinction the whole file exists for, stated as one comparison.
  check("a zero-case run and a clean sweep get DIFFERENT exit codes",
    exitCodeFor(zero) !== exitCodeFor(healthy()));

  check("an empty adapter set is a plan problem",
    planProblems(plan({ adapters: [] })).some((p) => p.includes("adapter")));
}

// ---- 2. a short run is not a clean run -----------------------------------

{
  const short = healthy({ casesGenerated: 139 });
  check("generated < planned, uncapped, classifies INCOMPLETE", classify(short) === "INCOMPLETE");
  check("INCOMPLETE exits 3", exitCodeFor(short) === EXIT.UNTRUSTWORTHY);

  // Over-generation is equally a defect: the plan and the run disagree either way.
  const over = healthy({ casesGenerated: 141 });
  check("generated > planned is also INCOMPLETE", classify(over) === "INCOMPLETE");

  // INCOMPLETE outranks a clean finding count -- a short run's zero findings
  // are not evidence of anything.
  check("a short run with zero findings is still not RAN-CLEAN",
    classify(healthy({ casesGenerated: 1 })) !== "RAN-CLEAN");
}

// ---- 3. a capped run stopped on purpose ----------------------------------

{
  const capped = healthy({ casesGenerated: 12, capped: true, divergences: 100 });
  check("capped run with fewer cases is NOT INCOMPLETE", classify(capped) !== "INCOMPLETE");
  check("capped run with divergences is RAN-FOUND", classify(capped) === "RAN-FOUND");
  check("capped run exits 1", exitCodeFor(capped) === EXIT.FOUND);
  check("the capped marker survives into the legacy line", legacyLine(capped).includes("(capped)"));
}

// ---- 4. a dead harness is not a divergence haul --------------------------
// The measured shape of the defect: 14 cases x 9 pairs against dead adapters
// produced "DIVERGENCES: 126 | cases: 14/14 | pair-checks: 126" and a 100%
// finding rate that read as a record haul.

{
  // Built through the recording helpers rather than by setting counters, so the
  // helpers are on trial here too.
  const deadTally = tally({ casesGenerated: 14, casesIngested: 14 });
  for (let i = 0; i < 126; i++) recordError(deadTally, "ts", "python", "stub adapter called");
  const s = state({ casesPlanned: 14 }, deadTally);

  check("every check errored classifies HARNESS-DEAD", classify(s) === "HARNESS-DEAD");
  check("HARNESS-DEAD exits 3, not 1", exitCodeFor(s) === EXIT.UNTRUSTWORTHY);
  check("HARNESS-DEAD is not RAN-FOUND", classify(s) !== "RAN-FOUND");

  // A quarantined adapter makes the run untrustworthy even if other pairs worked.
  const partial = healthy({ divergences: 3, quarantined: ["python"] });
  check("a quarantined adapter classifies HARNESS-DEAD even with completed checks",
    classify(partial) === "HARNESS-DEAD");

  // 126 identical failures group to ONE signature with a count.
  check("repeated identical errors collapse to one signature",
    deadTally.errorSignatures.size === 1 && deadTally.errorSignatures.get("stub adapter called") === 126);

  check("error signatures normalise digit runs",
    errorSignature("row 47 failed") === errorSignature("row 9931 failed"));
  check("error signatures keep quoted detail",
    errorSignature("No module named 'toon_format'") !== errorSignature("No module named 'orjson'"));
  // WHICH LINE. Three checks, because the rule has to survive BOTH failure modes:
  // first-line-only loses python, last-non-empty loses Node. The old check here was
  // named "take the first line only" and pinned the defect as if it were the rule.
  check("a Node error keeps its message line, not its last frame",
    errorSignature("boom\n  at frame one\n  at frame two") === "boom");
  check("a python traceback keeps its exception line, not its header",
    errorSignature("Traceback (most recent call last):\n  File \"a.py\", line 3\nValueError: bad key")
      === "ValueError: bad key");
  check("two different python exceptions do NOT group together",
    errorSignature("Traceback (most recent call last):\n  File \"a.py\", line 3\nValueError: bad key")
      !== errorSignature("Traceback (most recent call last):\n  File \"a.py\", line 9\nKeyError: missing"));
  check("an all-frame message falls back to the first line rather than empty",
    errorSignature("  at one\n  at two") === "at one");
  check("a single-line message is unaffected by the rule",
    errorSignature("stub adapter called") === "stub adapter called");

  // Canary preflight: deterministic, not a rate threshold.
  check("failedCanaries names exactly the failing adapters",
    JSON.stringify(failedCanaries([
      { adapter: "ts", ok: true },
      { adapter: "python", ok: false, error: "ModuleNotFoundError" },
      { adapter: "rust", ok: true },
    ])) === JSON.stringify(["python"]));
  check("all-passing canaries name nobody", failedCanaries([{ adapter: "ts", ok: true }]).length === 0);
  check("the canary case is trivial and fixed", CANARY_JSON === '{"a":1}');

  // THE PROPERTY THAT MAKES THE THRESHOLD SAFE: consecutive errors alone never
  // quarantine. A genuine fault class can fail many cases in a row, and killing
  // an adapter on a count would hide real findings.
  const h = new AdapterHealth();
  for (let i = 0; i < 500; i++) {
    h.noteError("python");
    if (h.shouldRecanary("python")) h.noteCanary("python", true);
  }
  check("500 consecutive errors with a passing canary never quarantine",
    !h.isDead("python") && h.deadAdapters().length === 0);

  const h2 = new AdapterHealth();
  for (let i = 0; i < RECANARY_AFTER; i++) h2.noteError("python");
  check("consecutive errors reach the re-canary threshold", h2.shouldRecanary("python"));
  h2.noteCanary("python", false);
  check("a FAILED canary is what quarantines", h2.isDead("python"));
  check("a quarantined adapter stops asking for canaries", !h2.shouldRecanary("python"));

  const h3 = new AdapterHealth();
  h3.noteError("rust"); h3.noteError("rust"); h3.noteOk("rust");
  check("a successful call resets the consecutive counter", h3.consecutiveErrors("rust") === 0);
  check("below the threshold no canary is spent", !h3.shouldRecanary("rust"));
}

// ---- 5. the pre-split finding count is preserved -------------------------
// Every figure in the handoff history ("124 findings from 20 cases") must remain
// comparable, or splitting the counter silently invalidates the record.

{
  const t = tally({ casesGenerated: 20, casesIngested: 20 });
  for (let i = 0; i < 3; i++) recordDivergence(t, "ts", "python", "number-changed");
  for (let i = 0; i < 121; i++) recordError(t, "python", "rust", "ModuleNotFoundError: No module named 'toon_format'");
  for (let i = 0; i < 56; i++) recordOk(t);

  check("divergences + errors equals the pre-split finding count",
    legacyFindings(t) === 124 && t.divergences === 3 && t.errors === 121);
  check("attempted equals completed plus errored",
    t.checksAttempted === t.checksCompleted + t.errors);
  check("the legacy line still reports the pre-split total",
    legacyLine(state({ casesPlanned: 20 }, t)).startsWith("DIVERGENCES: 124 |"));

  check("grouping a divergence does not disturb the legacy total",
    legacyFindings(t) === 124);
  check("the legacy line keeps its original field order and shape",
    legacyLine(state({ casesPlanned: 20 }, t)) ===
      "DIVERGENCES: 124 | cases: 20/20 | pair-checks: 180 | generator-malformed: 0");
  check("the manifest separates what the legacy line merges",
    renderManifest(state({ casesPlanned: 20 }, t)).includes("3 divergences, 121 errors"));

  // A clean run's legacy line is unchanged from the pre-module wording.
  check("a clean run still reads NO DIVERGENCES on the legacy line",
    legacyLine(healthy()).startsWith("NO DIVERGENCES |"));
}

// ---- divergence grouping --------------------------------------------------
// Errors were grouped from the first version of this module and divergences were
// not, so "124 findings" could not say how many were ONE input-side cause. These
// checks are the difference between counting that and inferring it.

{
  const t = tally({ casesGenerated: 20, casesIngested: 20 });
  for (let i = 0; i < 118; i++) recordDivergence(t, "ts", "python", "number-changed");
  for (let i = 0; i < 4; i++) recordDivergence(t, "ts", "rust", "container->string");
  recordDivergence(t, "python", "rust", "array->object");

  check("repeated identical divergences collapse to one signature",
    t.divergenceSignatures.get("number-changed") === 118);
  check("distinct divergence classes stay apart",
    t.divergenceSignatures.size === 3 &&
    t.divergenceSignatures.get("container->string") === 4 &&
    t.divergenceSignatures.get("array->object") === 1);
  check("the signature histogram sums to the divergence count",
    [...t.divergenceSignatures.values()].reduce((a, b) => a + b, 0) === t.divergences);
  check("a dominant class is visible as a share, not inferred from pair uniformity",
    (t.divergenceSignatures.get("number-changed")! / t.divergences) > 0.9);

  const rendered = renderManifest(state({ casesPlanned: 20 }, t));
  check("the manifest renders divergence signatures", rendered.includes("divergence signatures:"));
  check("the manifest renders the dominant class with its count",
    rendered.includes("118x  number-changed"));
  check("divergence signatures are ordered by count, dominant first",
    rendered.indexOf("number-changed") < rendered.indexOf("container->string"));
}

// ---- the oracle-disagreement path -----------------------------------------
// A fingerprint of "none" means the oracle judges the trees EQUAL, so the caller
// and the oracle disagree about whether this is a divergence at all. That is a
// harness defect and must never become a filed divergence class.

{
  const t = tally({ casesGenerated: 5, casesIngested: 5 });
  recordDivergence(t, "ts", "python", "number-changed");
  recordDivergence(t, "ts", "python", "none");
  recordDivergence(t, "ts", "python", "none");

  check("an oracle disagreement is counted apart", t.oracleDisagreements === 2);
  check("an oracle disagreement never enters the signature histogram",
    t.divergenceSignatures.size === 1 && !t.divergenceSignatures.has("none"));
  check("an oracle disagreement still counts as a divergence for the totals",
    t.divergences === 3);
  const rendered = renderManifest(state({ casesPlanned: 5 }, t));
  check("the manifest reports an oracle disagreement as a DEFECT, not a finding",
    rendered.includes("defect:") && rendered.includes("the oracle judges EQUAL"));
}

// ---- signature normalisation ----------------------------------------------

{
  check("divergence signatures collapse whitespace",
    divergenceSignature("number  changed\n") === "number changed");
  check("divergence signatures are length-capped",
    divergenceSignature("x".repeat(400)).length === 120);
  check("divergence signatures do NOT blank digits, unlike error signatures",
    divergenceSignature("field-3-changed") !== divergenceSignature("field-9-changed"));
}

// ---- 6. a real clean run still passes ------------------------------------
// A guard that cannot say yes is not a guard.

{
  const clean = healthy();
  check("a full, complete, error-free run is RAN-CLEAN", classify(clean) === "RAN-CLEAN");
  check("RAN-CLEAN exits 0", exitCodeFor(clean) === EXIT.CLEAN);

  const found = healthy({ divergences: 7 });
  check("divergences on a complete run is RAN-FOUND", classify(found) === "RAN-FOUND");
  check("RAN-FOUND exits 1", exitCodeFor(found) === EXIT.FOUND);

  // Errors alone, on a live harness, are findings -- an implementation that
  // throws on a legal input is a result, not a broken pipe.
  const threw = healthy({ checksCompleted: 1259, errors: 1 });
  check("a single error on an otherwise live harness is RAN-FOUND", classify(threw) === "RAN-FOUND");

  // Generator-malformed cases are OUR bug, recorded but not a TOON finding.
  const malformed = healthy({ generatorMalformed: 2 });
  check("generator-malformed alone does not manufacture a finding",
    classify(malformed) === "RAN-CLEAN");
}

// ---- 7. the rule list is total and has no dead rules ---------------------
// Checked structurally rather than asserted: an if-chain with a default branch
// would satisfy neither property while looking identical from outside.

{
  const VERDICTS: Verdict[] = ["DID-NOT-RUN", "HARNESS-DEAD", "INCOMPLETE", "RAN-FOUND", "RAN-CLEAN"];

  check("every rule carries a known verdict",
    VERDICT_RULES.every((r) => VERDICTS.includes(r.verdict)));
  check("the final rule is unconditional (totality by construction)",
    VERDICT_RULES[VERDICT_RULES.length - 1].when(healthy()) === true &&
    VERDICT_RULES[VERDICT_RULES.length - 1].when(state({ casesPlanned: -1 }, {})) === true);

  // Exhaustive enumeration over the fields the rules read.
  const firstMatch = new Map<number, number>();
  let enumerated = 0, unmatched = 0;
  for (const casesPlanned of [0, 1, 2, NaN, -3, 1.5]) {
    for (const casesGenerated of [0, 1, 2]) {
      for (const capped of [false, true]) {
        for (const quarantined of [[], ["python"]]) {
          for (const checksAttempted of [0, 4]) {
            for (const checksCompleted of [0, 4]) {
              for (const divergences of [0, 2]) {
                for (const errors of [0, 2]) {
                  const s = state({ casesPlanned }, {
                    casesGenerated, capped, quarantined, checksAttempted,
                    checksCompleted, divergences, errors,
                  });
                  enumerated++;
                  const i = VERDICT_RULES.findIndex((r) => r.when(s));
                  if (i < 0) { unmatched++; continue; }
                  firstMatch.set(i, (firstMatch.get(i) ?? 0) + 1);
                  if (classify(s) !== VERDICT_RULES[i].verdict) unmatched++;
                }
              }
            }
          }
        }
      }
    }
  }
  check(`every enumerated state matches a rule and classify agrees (${enumerated} states)`, unmatched === 0);
  check(`no dead rules: all ${VERDICT_RULES.length} are first-match somewhere`,
    firstMatch.size === VERDICT_RULES.length);
  check("every verdict has an exit code", VERDICTS.every((v) => Number.isInteger(EXIT_FOR[v])));

  // THE ORDERING THE SPLIT EXISTS FOR. A failed canary aborts before the first
  // case, so a collapsed DID-NOT-RUN rule would blame the invocation for a dead
  // environment and send the reader to their command line instead of their venv.
  const canaryAbort = state({}, { casesGenerated: 0, quarantined: ["python"] });
  check("a canary abort is HARNESS-DEAD, not DID-NOT-RUN",
    classify(canaryAbort) === "HARNESS-DEAD");
  check("a canary abort still exits 3", exitCodeFor(canaryAbort) === EXIT.UNTRUSTWORTHY);
  check("a bad invocation outranks harness state",
    classify(state({ casesPlanned: 0 }, { quarantined: ["python"] })) === "DID-NOT-RUN");
  check("plan-fine, harness-fine, nothing generated is still DID-NOT-RUN",
    classify(state({ casesPlanned: 5 }, { casesGenerated: 0 })) === "DID-NOT-RUN");
  check("only RAN-CLEAN exits 0",
    VERDICTS.filter((v) => EXIT_FOR[v] === EXIT.CLEAN).join() === "RAN-CLEAN");
  check("untrustworthy verdicts share exit 3 and are distinct from 0 and 1",
    EXIT_FOR["DID-NOT-RUN"] === 3 && EXIT_FOR["HARNESS-DEAD"] === 3 && EXIT_FOR["INCOMPLETE"] === 3);
}

// ---- 8. NaN never reaches a clean verdict --------------------------------
// parseInt returns NaN on a non-numeric argument and NaN fails every comparison
// silently. `--size abc` and `--per abc` were verified to exit 0 against the
// live driver; both are pinned here.

{
  for (const bad of [NaN, -1, 0, 1.5, Infinity, -Infinity]) {
    const s = state({ casesPlanned: bad }, { casesGenerated: 140, casesIngested: 140, checksAttempted: 1260, checksCompleted: 1260 });
    check(`casesPlanned=${String(bad)} classifies DID-NOT-RUN`, classify(s) === "DID-NOT-RUN");
  }
  check("NaN is caught by Number.isInteger, not by a comparison",
    planProblems(plan({ casesPlanned: NaN }))[0].includes("not an integer"));
  check("a NaN plan never renders a clean verdict",
    !renderManifest(state({ casesPlanned: NaN }, { casesGenerated: 5 })).includes("RAN-CLEAN"));
}

// ---- 9. the manifest is deterministic ------------------------------------

{
  const s = healthy({ divergences: 2 });
  check("renderManifest is deterministic over the same state",
    renderManifest(s) === renderManifest(s));

  const a = plan({ params: { size: 40, per: 20, channels: 7 } });
  const b = plan({ params: { channels: 7, per: 20, size: 40 } });
  check("planDigest is insensitive to key order", planDigest(a) === planDigest(b));
  check("planDigest is sensitive to values", planDigest(a) !== planDigest(plan({ params: { size: 41, per: 20, channels: 7 } })));
  check("planDigest is insensitive to adapter order",
    planDigest(plan({ adapters: ["rust", "ts", "python"] })) === planDigest(plan({ adapters: ["python", "rust", "ts"] })));

  // The verdict is IN the rendered text: a manifest that had to be interpreted
  // would reintroduce the reading-a-histogram-by-hand problem it replaces.
  check("the rendered manifest states the verdict and the exit code",
    renderManifest(s).includes("verdict:   RAN-FOUND (exit 1)"));
  check("the rendered manifest states planned vs generated",
    renderManifest(s).includes("generated: 140/140 cases"));

  const withErrors = tally({ casesGenerated: 140, casesIngested: 140 });
  recordError(withErrors, "ts", "ts", "worker exited");
  recordError(withErrors, "ts", "ts", "worker exited");
  recordError(withErrors, "python", "rust", "decode failed at 12");
  // A LIVE harness: completed checks exist, so the run is a result and the
  // self-pair errors are a pointer for triage rather than a verdict.
  for (let i = 0; i < 40; i++) recordOk(withErrors);
  const rendered = renderManifest(state({}, withErrors));
  check("error signatures render in descending count order",
    rendered.indexOf("worker exited") < rendered.indexOf("decode failed at #"));
  check("self-pair errors raise an environment note, not a verdict",
    rendered.includes("self-pair error(s)") && rendered.includes("verdict:   RAN-FOUND"));
}

console.log(failures === 0
  ? `\nRUN MANIFEST PROVEN: ${total} checks pass. A run that did not happen, did not finish, or ran against a dead harness cannot report as a clean sweep.`
  : `\nRUN MANIFEST BROKEN: ${failures} of ${total} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
