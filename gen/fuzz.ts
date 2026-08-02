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
import { generateCase } from "./generate.ts";
import type { Provenance } from "./generate.ts";
import { CHANNELS, CONFIG, eligibleChannels, generateProperty } from "./property.ts";
import type { Channel } from "./property.ts";

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

function printFinding(
  c: Case, from: string, to: string, actual: string, error?: string, skew = "",
): void {
  console.log(`${from} \u2192 ${to}   \u2717   ${c.label}${skew}`);
  console.log(`  recipe:   ${c.recipe}`);
  if (error) { console.log(`  error:    ${error}\n`); return; }
  console.log(`  expected: ${trim(c.text)}`);
  console.log(`  actual:   ${trim(actual)}`);
  console.log(`  replay:   ${c.replay}\n`);
}

const main = async () => {
  let findings = 0, checks = 0, cases = 0, malformed = 0;
  const startedAt = Date.now();
  const heartbeat = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    process.stderr.write(`… ${cases}/${totalCases} cases, ${findings} findings, ${secs}s\n`);
  };

  console.log(mode === "prop"
    ? `fuzzing: ${propChannels.length} channels x ${per} = ${totalCases} property cases | size: ${size} | persistent python + rust\n` +
      `channels: ${propChannels.join(", ")}`
    : `fuzzing: ${seeds.length} seeds x ${per} = ${totalCases} cases | maxOps: ${maxOps} | persistent python + rust`);
  console.log(`claimed spec versions: ${adapters.map((a) => `${a.name}=${specClaim(a)}`).join("  ")}\n`);

  outer:
  for (const c of source()) {
    cases++;
    if (cases % progressEvery === 0) heartbeat();
    // The generator is supposed to emit valid JSON. If it ever doesn't, that's a
    // bug in THIS tool, not a finding about TOON -- so record it (on stderr, with
    // a replay command) and skip the case. Never abort a multi-thousand-case sweep
    // for our own bug.
    let expected;
    try {
      expected = ingest(c.text); // lossless; exact lexeme preserved
    } catch (e) {
      malformed++;
      process.stderr.write(
        `! generator emitted invalid JSON  ${c.label}\n` +
        `  recipe: ${c.recipe}\n` +
        `  ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n` +
        `  replay: ${c.replay}\n`,
      );
      continue;
    }
    for (const X of adapters) {
      for (const Y of adapters) {
        checks++;
        try {
          const back = await Y.decode(await X.encode(c.text));
          if (!equal(ingest(back), expected)) {
            findings++;
            printFinding(c, X.name, Y.name, back, undefined, skewNote(X, Y));
          }
        } catch (e) {
          findings++;
          printFinding(c, X.name, Y.name, "", e instanceof Error ? e.message : String(e), skewNote(X, Y));
        }
        if (findings >= maxFindings) break outer;
      }
    }
  }

  heartbeat();
  console.log(`\n${findings === 0 ? "NO DIVERGENCES" : `DIVERGENCES: ${findings}`}` +
    ` | cases: ${cases}/${totalCases} | pair-checks: ${checks}` +
    ` | generator-malformed: ${malformed}` +
    (findings >= maxFindings ? " | (capped)" : ""));
  shutdownPython();
  shutdownRust();
  process.exit(findings === 0 ? 0 : 1);
};

main();
