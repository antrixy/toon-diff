// gen/cli.ts
//
// Drive the generator without needing any TOON implementation. Two uses:
//   preview  — generate a handful of cases and show their PROVENANCE + text, so a
//              human can eyeball what the operators produce.
//   write    — persist a batch to probe/generated/ as {case}.json plus a
//              provenance manifest (provenance.jsonl). This is the on-disk shape
//              v0.3's provenance-grouped corpus consumes, and what the fuzz-run
//              harness (gen/fuzz.ts) reads when reproducing a finding.
//
// Reproducibility: a case is (seed file, rngSeed, maxOps). The manifest records
// all three, so any persisted case replays byte-for-byte via generate.replay().
//
// Run:
//   node --experimental-strip-types gen/cli.ts preview [--per 3] [--maxops 3] [--seed 1]
//   node --experimental-strip-types gen/cli.ts write   [--per 20] [--maxops 3] [--seed 1] [--out probe/generated]

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "../probe/corpus.ts";
import { generateCase } from "./generate.ts";

const args = process.argv.slice(2);
const mode = args[0] === "write" ? "write" : "preview";
function opt(name: string, def: string): string {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const per = parseInt(opt("per", mode === "write" ? "20" : "3"), 10);
const maxOps = parseInt(opt("maxops", "3"), 10);
const baseSeed = parseInt(opt("seed", "1"), 10);
const outDir = opt("out", "probe/generated");

// Mutation substrate is the seeds/ bucket ONLY (see gen/fuzz.ts note).
const seeds = loadCorpus().byBucket.seeds
  .map((c) => ({ name: c.key, text: c.text }));

// Distinct rngSeed per (seed, index) so the whole batch is one reproducible set.
const rngSeedFor = (seedIdx: number, i: number) => (baseSeed * 1_000_003 + seedIdx * 9973 + i) >>> 0;

if (mode === "preview") {
  let shown = 0;
  seeds.forEach((seed, si) => {
    for (let i = 0; i < per; i++) {
      const g = generateCase(seed.text, rngSeedFor(si, i), { seedName: seed.name, maxOps });
      const chain = g.provenance.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(no-op)";
      const preview = g.text.length > 100 ? g.text.slice(0, 100) + `… [${g.text.length}B]` : g.text;
      console.log(`\n${seed.name}  rngSeed=${g.provenance.rngSeed}`);
      console.log(`  ${chain}`);
      console.log(`  ${preview}`);
      shown++;
    }
  });
  console.log(`\n${shown} cases previewed (deterministic; rerun for identical output).`);
} else {
  const absOut = fileURLToPath(new URL("../" + outDir + "/", import.meta.url));
  mkdirSync(absOut, { recursive: true });
  const manifest: string[] = [];
  let n = 0;
  seeds.forEach((seed, si) => {
    for (let i = 0; i < per; i++) {
      const rngSeed = rngSeedFor(si, i);
      const g = generateCase(seed.text, rngSeed, { seedName: seed.name, maxOps });
      const base = `${seed.name.replace(/\.json$/, "")}-g${String(i).padStart(4, "0")}`;
      writeFileSync(absOut + base + ".json", g.text + "\n");
      manifest.push(JSON.stringify({
        case: base + ".json",
        origin: "generated",
        seed: seed.name,
        rngSeed,
        maxOps,
        pipeline: g.provenance.pipeline,
        note: `mutation of ${seed.name} via ${g.provenance.pipeline.map((s) => s.op).join("+") || "identity"}`,
      }));
      n++;
    }
  });
  writeFileSync(absOut + "provenance.jsonl", manifest.join("\n") + "\n");
  console.log(`wrote ${n} cases + provenance.jsonl to ${outDir}/`);
}
