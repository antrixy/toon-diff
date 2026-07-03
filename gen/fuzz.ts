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
// Run:
//   node --experimental-strip-types gen/fuzz.ts [--per 200] [--maxops 3] [--seed 1]
//                                               [--max-findings 100000] [--progress 100]

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingest, equal } from "../oracle/ingest.ts";
import type { Adapter } from "../adapters/contract.ts";
import { tsAdapter } from "../adapters/ts.ts";
import { pythonAdapterPersistent, shutdownPython } from "../adapters/python-persistent.ts";
// import { rustAdapter } from "../adapters/rust.ts"; // when ready: 2->3 adapters = 4->9 pair-checks
import { generateCase } from "./generate.ts";
import type { Provenance } from "./generate.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapterPersistent];

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

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
const seeds = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f, text: readFileSync(casesDir + f, "utf8").trim() }));
const rngSeedFor = (seedIdx: number, i: number) => (baseSeed * 1_000_003 + seedIdx * 9973 + i) >>> 0;

const totalCases = seeds.length * per;
function chain(p: Provenance): string {
  return p.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(identity)";
}
const trim = (s: string) => (s.length > 200 ? s.slice(0, 200) + `… [${s.length}B]` : s);

function printFinding(
  p: Provenance, from: string, to: string, expected: string, actual: string, error?: string,
): void {
  console.log(`${from} \u2192 ${to}   \u2717   seed=${p.seed} rngSeed=${p.rngSeed} maxOps=${maxOps}`);
  console.log(`  recipe:   ${chain(p)}`);
  if (error) { console.log(`  error:    ${error}\n`); return; }
  console.log(`  expected: ${trim(expected)}`);
  console.log(`  actual:   ${trim(actual)}`);
  console.log(`  replay:   node --experimental-strip-types gen/replay-case.ts ${p.seed} ${p.rngSeed} ${maxOps}\n`);
}

const main = async () => {
  let findings = 0, checks = 0, cases = 0;
  const startedAt = Date.now();
  const heartbeat = () => {
    const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
    process.stderr.write(`… ${cases}/${totalCases} cases, ${findings} findings, ${secs}s\n`);
  };

  console.log(`fuzzing: ${seeds.length} seeds x ${per} = ${totalCases} cases | maxOps: ${maxOps} | persistent python\n`);

  outer:
  for (let si = 0; si < seeds.length; si++) {
    const seed = seeds[si];
    for (let i = 0; i < per; i++) {
      const rngSeed = rngSeedFor(si, i);
      const g = generateCase(seed.text, rngSeed, { seedName: seed.name, maxOps });
      const expected = ingest(g.text); // lossless; exact lexeme preserved
      cases++;
      if (cases % progressEvery === 0) heartbeat();
      for (const X of adapters) {
        for (const Y of adapters) {
          checks++;
          try {
            const back = await Y.decode(await X.encode(g.text));
            if (!equal(ingest(back), expected)) {
              findings++;
              printFinding(g.provenance, X.name, Y.name, g.text, back);
            }
          } catch (e) {
            findings++;
            printFinding(g.provenance, X.name, Y.name, g.text, "", e instanceof Error ? e.message : String(e));
          }
          if (findings >= maxFindings) break outer;
        }
      }
    }
  }

  heartbeat();
  console.log(`\n${findings === 0 ? "NO DIVERGENCES" : `DIVERGENCES: ${findings}`}` +
    ` | cases: ${cases}/${totalCases} | pair-checks: ${checks}` +
    (findings >= maxFindings ? " | (capped)" : ""));
  shutdownPython();
  process.exit(findings === 0 ? 0 : 1);
};

main();
