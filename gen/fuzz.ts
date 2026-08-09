// gen/fuzz.ts
//
// The generator, wired into the differential matrix. Reuses cli-v2's exact check
//     decode_Y( encode_X( case ) )  ==  case      (lossless comparison)
// over GENERATED cases, and every divergence carries the provenance needed to
// replay and shrink it.
//
// FULL ENV ONLY: imports the adapters, which need the TOON impls installed
// (npm i @toon-format/toon; python impl on PATH). The generator and its
// self-tests need none of that.
//
// This driver is built for BIG sweeps:
//   * a PERSISTENT python worker (adapters/python-persistent.ts) — one interpreter
//     for the whole run instead of ~15k spawns; behavior parity proven by
//     adapters/selftest-parity.ts.
//   * a HEARTBEAT on stderr every --progress cases, so a long run is legible and a
//     hang is distinguishable from work. stderr keeps it out of a `| tee` file.
//   * findings STREAMED to stdout as they occur, so Ctrl-C still leaves every
//     finding-so-far saved.
//
// TWO CASE SOURCES, ONE MATRIX. --mode selects where cases come from:
//   mut   (default) — the v0.2 mutation generator: a seed plus an operator pipeline.
//   prop            — the v0.4 property generator: grammar productions, no seed.
// They are kept apart at exactly one point: IDENTITY. A mutation case is
// (seed, rngSeed, maxOps); a property case is (channel, rngSeed, size). Forcing
// either into the other'"'"'s shape would misreport where a finding came from, which
// is the whole of thesis D. Everything downstream — the NxN loop, the oracle
// comparison, the heartbeat, the spec-skew annotation — is shared, because
// duplicating the matrix is how the two halves quietly drift apart.
//
// Run:
//   node --experimental-strip-types gen/fuzz.ts [--mode mut|prop] [--per 200]
//                                               [--maxops 3] [--seed 1] [--size 40]
//                                               [--channel <name>]
//                                               [--max-findings 100000] [--progress 100]

import { loadCorpus } from "../probe/corpus.ts";
import { ingest, equal } from "../oracle/ingest.ts";
import type { Adapter } from "../adapters/contract.ts";
import { tsAdapter } from "../adapters/ts.ts";
import { pythonAdapterPersistent, shutdownPython } from "../adapters/python-persistent.ts";
import { rustAdapterPersistent, shutdownRust } from "../adapters/rust-persistent.ts";
import { fingerprintMismatch } from "./failure-signature.ts";
import { generateCase } from "./generate.ts";
import type { Provenance } from "./generate.ts";
import { CHANNELS, CONFIG, eligibleChannels, generateProperty } from "./property.ts";
import type { Channel } from "./property.ts";
import {
  AdapterHealth, CANARY_JSON, EXIT, emptyTally, exitCodeFor, failedCanaries,
  legacyFindings, legacyLine, planProblems, recordDivergence, recordError,
  recordOk, renderManifest,
} from "./run-manifest.ts";
import type { CanaryResult, Plan, RunState } from "./run-manifest.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapterPersistent, rustAdapterPersistent];

const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const per = parseInt(opt("per", "200"), 10);
const maxOps = parseInt(opt("maxops", "3"), 10);
const baseSeed = parseInt(opt("seed", "1"), 10);
const maxFindings = parseInt(opt("max-findings", "100000"), 10);
const progressEvery = parseInt(opt("progress", "100"), 10);
const mode = opt("mode", "mut");
const size = parseInt(opt("size", "40"), 10);
const channelOpt = opt("channel", "");

if (mode !== "mut" && mode !== "prop") {
  console.error(`unknown --mode "${mode}" (expected mut or prop)`);
  process.exit(2);
}
if (channelOpt && !(CHANNELS as readonly string[]).includes(channelOpt)) {
  console.error(`unknown --channel "${channelOpt}"\n  channels: ${CHANNELS.join(", ")}`);
  process.exit(2);
}
if (channelOpt && size < CONFIG.minSize[channelOpt as Channel]) {
  console.error(`--channel ${channelOpt} needs --size >= ${CONFIG.minSize[channelOpt as Channel]} (got ${size})\n` +
    `  eligible at this size: ${eligibleChannels(size).join(", ") || "(none)"}`);
  process.exit(2);
}

// ---- case sources --------------------------------------------------------
//
// A Case is what the matrix consumes: text, plus the identity needed to report
// and replay it. `label` is the one-line identity shown on a finding; `replay`
// is a command that reproduces the exact bytes. Nothing below this point knows
// which generator produced a case.

interface Case {
  text: string;
  label: string;
  replay: string;
  /** Recipe/pipeline line, shown under the identity. */
  recipe: string;
}

// Mutation substrate is the seeds/ bucket ONLY: regressions, promoted fuzz
// cases, and community cases protect specific invariants and are not mutation
// stock. seedName is the corpus key ("seeds/NNN-name.json"), which replay-case
// resolves relative to probe/cases/.
const seeds = loadCorpus().byBucket.seeds
  .map((c) => ({ name: c.key, text: c.text }));
const rngSeedFor = (seedIdx: number, i: number) => (baseSeed * 1_000_003 + seedIdx * 9973 + i) >>> 0;

function chain(p: Provenance): string {
  return p.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(identity)";
}

function* mutationCases(): Generator<Case> {
  for (let si = 0; si < seeds.length; si++) {
    for (let i = 0; i < per; i++) {
      const rngSeed = rngSeedFor(si, i);
      const g = generateCase(seeds[si].text, rngSeed, { seedName: seeds[si].name, maxOps });
      yield {
        text: g.text,
        label: `seed=${g.provenance.seed} rngSeed=${g.provenance.rngSeed} maxOps=${maxOps}`,
        recipe: chain(g.provenance),
        replay: `node --experimental-strip-types gen/replay-case.ts ${g.provenance.seed} ${g.provenance.rngSeed} ${maxOps}`,
      };
    }
  }
}

// One channel per --channel, or every channel eligible at --size. Sweeping the
// eligible set rather than auto-selecting keeps coverage even instead of
// weighted: a sweep is not a sample.
const propChannels: Channel[] = channelOpt
  ? [channelOpt as Channel]
  : eligibleChannels(size);

function* propertyCases(): Generator<Case> {
  for (let ci = 0; ci < propChannels.length; ci++) {
    const channel = propChannels[ci];
    for (let i = 0; i < per; i++) {
      const rngSeed = rngSeedFor(ci, i);
      const c = generateProperty(rngSeed, size, { channel });
      yield {
        text: c.text,
        label: c.recipe,
        recipe: `${channel}, ${c.nodes} nodes`,
        replay: `node --experimental-strip-types gen/replay-case.ts "${c.recipe}"`,
      };
    }
  }
}

const source = mode === "prop" ? propertyCases : mutationCases;
const totalCases = mode === "prop" ? propChannels.length * per : seeds.length * per;

const trim = (s: string) => (s.length > 200 ? s.slice(0, 200) + `… [${s.length}B]` : s);

// Spec-version ANNOTATION (never classification): a finding between adapters
// with different non-null claimed spec versions gets a marker, because SOME
// such divergences may be spec-skew artifacts rather than impl bugs. A null
// claim ("targets current") never produces a marker — there is no claim to
// skew against. Triage still decides what each finding IS.
const specClaim = (a: Adapter): string => a.specVersion ?? "(none)";
function skewNote(X: Adapter, Y: Adapter): string {
  return X.specVersion !== null && Y.specVersion !== null && X.specVersion !== Y.specVersion
    ? `   [claimed-spec skew ${X.specVersion} vs ${Y.specVersion}]`
    : "";
}

/**
 * A finding line, with the divergence CLASS on it.
 *
 * WHY THE CLASS IS PRINTED. expected/actual are truncated at 200 bytes, so the
 * class was previously recoverable from a log only when the difference happened to
 * fall inside that window. In the first v2 run it did so for 7 of 71 divergences:
 * #78's U+0000 keys were in the log the whole time and mostly invisible. The
 * fingerprint is already computed for the tally, so printing it costs nothing and
 * makes a log greppable by class without re-running the adapters.
 *
 * The marker sits in BRACKETS after the label, the same shape the skew note uses,
 * so a line can carry both and finding-log's pattern -- deliberately not anchored
 * at end of line, since the skew-note defect -- keeps working unchanged.
 *
 * ERRORS GET NO MARKER. Their class is already on the `error:` line and grouped by
 * errorSignature; a second vocabulary for them would be noise.
 */
function printFinding(
  c: Case, from: string, to: string, actual: string, error?: string, skew = "", fingerprint = "",
): void {
  const fp = fingerprint ? `   [${fingerprint}]` : "";
  console.log(`${from} \u2192 ${to}   \u2717   ${c.label}${skew}${fp}`);
  console.log(`  recipe:   ${c.recipe}`);
  if (error) { console.log(`  error:    ${error}\n`); return; }
  console.log(`  expected: ${trim(c.text)}`);
  console.log(`  actual:   ${trim(actual)}`);
  console.log(`  replay:   ${c.replay}\n`);
}

const plan: Plan = {
  mode,
  casesPlanned: totalCases,
  adapters: adapters.map((a) => a.name),
  params: mode === "prop"
    ? { per, size, channels: propChannels.join("+") || "(none)", seed: baseSeed }
    : { per, maxOps, seeds: seeds.length, seed: baseSeed },
};

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const main = async () => {
  const tally = emptyTally();
  const health = new AdapterHealth();
  const state: RunState = { plan, tally };
  /** The pre-split finding count, which is what --max-findings has always capped. */
  const legacyCount = () => legacyFindings(tally);
  const startedAt = Date.now();
  const heartbeat = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    process.stderr.write(
      `… ${tally.casesGenerated}/${totalCases} cases, ${tally.divergences} divergences, ` +
      `${tally.errors} errors, ${secs}s\n`,
    );
  };

  // LIVENESS GATE. A plan that cannot generate anything is a configuration
  // error, and it is caught HERE -- before the loop -- so the run refuses to
  // start rather than reporting a sweep it never performed. Previously
  // `--size 0`, `--per 0` and any non-numeric argument printed NO DIVERGENCES
  // and exited 0, which is indistinguishable from a clean sweep.
  if (planProblems(plan).length > 0) {
    console.log(renderManifest(state));
    process.exit(EXIT.UNTRUSTWORTHY);
  }

  // CANARY PREFLIGHT. Three calls against a fixed trivial value. An adapter that
  // cannot round-trip {"a":1} is dead, and every "finding" it would go on to
  // produce is one environment error repeated -- the shape that wasted the first
  // property run, where ~35 of 50 findings were a dead python worker.
  const canaries: CanaryResult[] = [];
  for (const a of adapters) {
    try {
      const back = await a.decode(await a.encode(CANARY_JSON));
      const ok = equal(ingest(back), ingest(CANARY_JSON));
      canaries.push({ adapter: a.name, ok, error: ok ? undefined : `canary returned ${back}` });
    } catch (e) {
      canaries.push({ adapter: a.name, ok: false, error: msgOf(e) });
    }
  }
  const deadOnArrival = failedCanaries(canaries);
  if (deadOnArrival.length > 0) {
    tally.quarantined.push(...deadOnArrival);
    for (const c of canaries) if (!c.ok) recordError(tally, c.adapter, c.adapter, `canary: ${c.error}`);
    console.log(renderManifest(state));
    shutdownPython();
    shutdownRust();
    process.exit(EXIT.UNTRUSTWORTHY);
  }
  console.log(`canary: ${adapters.map((a) => `${a.name}=ok`).join("  ")}`);

  /** Spend a canary call only when consecutive errors say it is worth one. */
  const recanary = async (a: Adapter): Promise<void> => {
    if (!health.shouldRecanary(a.name)) return;
    try {
      const back = await a.decode(await a.encode(CANARY_JSON));
      const ok = equal(ingest(back), ingest(CANARY_JSON));
      health.noteCanary(a.name, ok);
      if (!ok) process.stderr.write(`! ${a.name} failed its re-canary; quarantined\n`);
    } catch (e) {
      health.noteCanary(a.name, false);
      process.stderr.write(`! ${a.name} died mid-run (${msgOf(e)}); quarantined\n`);
    }
    if (health.isDead(a.name) && !tally.quarantined.includes(a.name)) tally.quarantined.push(a.name);
  };

  console.log(mode === "prop"
    ? `fuzzing: ${propChannels.length} channels x ${per} = ${totalCases} property cases | size: ${size} | persistent python + rust\n` +
      `channels: ${propChannels.join(", ")}`
    : `fuzzing: ${seeds.length} seeds x ${per} = ${totalCases} cases | maxOps: ${maxOps} | persistent python + rust`);
  console.log(`claimed spec versions: ${adapters.map((a) => `${a.name}=${specClaim(a)}`).join("  ")}\n`);

  outer:
  for (const c of source()) {
    tally.casesGenerated++;
    if (tally.casesGenerated % progressEvery === 0) heartbeat();
    // The generator is supposed to emit valid JSON. If it ever doesn't, that's a
    // bug in THIS tool, not a finding about TOON -- so record it (on stderr, with
    // a replay command) and skip the case. Never abort a multi-thousand-case sweep
    // for our own bug.
    let expected;
    try {
      expected = ingest(c.text); // lossless; exact lexeme preserved
      tally.casesIngested++;
    } catch (e) {
      tally.generatorMalformed++;
      process.stderr.write(
        `! generator emitted invalid JSON  ${c.label}\n` +
        `  recipe: ${c.recipe}\n` +
        `  ${msgOf(e).split("\n")[0]}\n` +
        `  replay: ${c.replay}\n`,
      );
      continue;
    }
    for (const X of adapters) {
      if (health.isDead(X.name)) continue;
      for (const Y of adapters) {
        if (health.isDead(Y.name)) continue;

        // Encode and decode are awaited SEPARATELY so a failure is attributed to
        // the side that actually threw. Attribution is what makes the health
        // tracker meaningful: a combined await blames both adapters for one
        // adapter's death and quarantines nobody.
        let encoded: string;
        try {
          encoded = await X.encode(c.text);
        } catch (e) {
          recordError(tally, X.name, Y.name, msgOf(e));
          printFinding(c, X.name, Y.name, "", msgOf(e), skewNote(X, Y));
          health.noteError(X.name);
          await recanary(X);
          if (legacyCount() >= maxFindings) { tally.capped = true; break outer; }
          continue;
        }
        try {
          const back = await Y.decode(encoded);
          if (equal(ingest(back), expected)) {
            recordOk(tally);
          } else {
            // Classified HERE, not in run-manifest.ts: categorising a difference
            // needs the oracle, and that module stays adapter-free so it can be
            // proven in the sandbox. It takes the verdict; it does not reach for it.
            //
            // Computed ONCE and passed to both the tally and the printed line. Two
            // calls could disagree, and a manifest histogram that does not match
            // its own findings is worse than no histogram.
            const fp = fingerprintMismatch(c.text, back);
            recordDivergence(tally, X.name, Y.name, fp);
            printFinding(c, X.name, Y.name, back, undefined, skewNote(X, Y), fp);
          }
          health.noteOk(X.name);
          health.noteOk(Y.name);
        } catch (e) {
          recordError(tally, X.name, Y.name, msgOf(e));
          printFinding(c, X.name, Y.name, "", msgOf(e), skewNote(X, Y));
          health.noteError(Y.name);
          await recanary(Y);
        }
        if (legacyCount() >= maxFindings) { tally.capped = true; break outer; }
      }
    }
  }

  heartbeat();
  console.log(`\n${legacyLine(state)}`);
  console.log(renderManifest(state));
  shutdownPython();
  shutdownRust();
  process.exit(exitCodeFor(state));
};

main();
