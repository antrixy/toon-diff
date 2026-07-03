// gen/fuzz.ts
//
// The generator, wired into the differential matrix. This is what turns
// "inputs a person hand-wrote" into "inputs nobody wrote" while keeping the same
// proven judge (oracle/ingest.ts). It reuses cli-v2's exact check --
//     decode_Y( encode_X( case ) )  ==  case      (lossless comparison)
// -- but over GENERATED cases, and every divergence it prints carries the
// provenance needed to replay and (next milestone) shrink it.
//
// FULL ENV ONLY: this imports the adapters, which need the TOON implementations
// installed (npm i @toon-format/toon; the python impl on PATH). The generator
// itself (gen/generate.ts) and its self-tests need none of that -- run those
// anywhere; run THIS where the matrix runs.
//
// Run:
//   node --experimental-strip-types gen/fuzz.ts [--per 200] [--maxops 3] [--seed 1] [--max-findings 20]
//
// A finding line is fully reproducible:
//   seed=004-uniform-table.json rngSeed=7029941 maxOps=3
//   -> node --experimental-strip-types gen/replay-case.ts 004-uniform-table.json 7029941 3

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ingest, equal } from "../oracle/ingest.ts";
import type { Adapter } from "../adapters/contract.ts";
import { tsAdapter } from "../adapters/ts.ts";
import { pythonAdapter } from "../adapters/python.ts";
// import { rustAdapter } from "../adapters/rust.ts"; // when ready: 2->3 adapters = 4->9 pair-checks
import { generateCase } from "./generate.ts";
import type { Provenance } from "./generate.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapter];

const args = process.argv.slice(2);
function opt(name: string, def: string): string {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const per = parseInt(opt("per", "200"), 10);
const maxOps = parseInt(opt("maxops", "3"), 10);
const baseSeed = parseInt(opt("seed", "1"), 10);
const maxFindings = parseInt(opt("max-findings", "20"), 10);

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
const seeds = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f, text: readFileSync(casesDir + f, "utf8").trim() }));
const rngSeedFor = (seedIdx: number, i: number) => (baseSeed * 1_000_003 + seedIdx * 9973 + i) >>> 0;

interface Finding {
  provenance: Provenance;
  from: string; to: string;
  expected: string; actual: string; error?: string;
}

function chain(p: Provenance): string {
  return p.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(identity)";
}

const main = async () => {
  const findings: Finding[] = [];
  let checks = 0, cases = 0;

  outer:
  for (let si = 0; si < seeds.length; si++) {
    const seed = seeds[si];
    for (let i = 0; i < per; i++) {
      const rngSeed = rngSeedFor(si, i);
      const g = generateCase(seed.text, rngSeed, { seedName: seed.name, maxOps });
      const expected = ingest(g.text); // lossless; exact lexeme preserved
      cases++;
      for (const X of adapters) {
        for (const Y of adapters) {
          checks++;
          try {
            const back = await Y.decode(await X.encode(g.text));
            if (!equal(ingest(back), expected)) {
              findings.push({ provenance: g.provenance, from: X.name, to: Y.name, expected: g.text, actual: back });
            }
          } catch (e) {
            findings.push({
              provenance: g.provenance, from: X.name, to: Y.name,
              expected: g.text, actual: "", error: e instanceof Error ? e.message : String(e),
            });
          }
          if (findings.length >= maxFindings) break outer;
        }
      }
    }
  }

  console.log(`generated: ${cases} cases | pair-checks: ${checks} | seeds: ${seeds.length} x ${per} | maxOps: ${maxOps}\n`);
  if (findings.length === 0) {
    console.log("NO DIVERGENCES across the generated corpus.");
  } else {
    console.log(`DIVERGENCES (${findings.length}${findings.length >= maxFindings ? "+, capped" : ""}):\n`);
    for (const f of findings) {
      const p = f.provenance;
      console.log(`${f.from} \u2192 ${f.to}   \u2717   seed=${p.seed} rngSeed=${p.rngSeed} maxOps=${maxOps}`);
      console.log(`  recipe:   ${chain(p)}`);
      if (f.error) { console.log(`  error:    ${f.error}\n`); continue; }
      const trim = (s: string) => (s.length > 200 ? s.slice(0, 200) + `… [${s.length}B]` : s);
      console.log(`  expected: ${trim(f.expected)}`);
      console.log(`  actual:   ${trim(f.actual)}`);
      console.log(`  replay:   node --experimental-strip-types gen/replay-case.ts ${p.seed} ${p.rngSeed} ${maxOps}\n`);
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
};

main();
