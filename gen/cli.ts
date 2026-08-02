// gen/cli.ts
//
// Drive the generator without needing any TOON implementation. Two uses:
//   preview  — generate a handful of cases and show their PROVENANCE + text, so a
//              human can eyeball what the operators produce.
//   write    — persist a batch to probe/generated/ as {case}.json plus a
//              provenance manifest (provenance.jsonl), for eyeballing a batch or
//              handing one to another tool.
//
// SCRATCH, NOT CORPUS. probe/generated/ is gitignored and this output is not a
// corpus promotion path. The v0.3 corpus takes per-case .meta.json sidecars under
// probe/cases/<bucket>/ and never reads this manifest; neither does gen/fuzz.ts,
// which generates in memory. Promotion is a deliberate act and will get its own
// command, which owns corpus-legal id allocation. Filenames written here are
// therefore NOT corpus-legal: every case from one seed reuses that seed's id, and
// loadCorpus enforces per-bucket unique ids.
//
// Reproducibility: a case is (seed file, rngSeed, maxOps). The manifest records
// all three, so any persisted case replays byte-for-byte via generate.replay().
//
// Run:
//   node --experimental-strip-types gen/cli.ts preview [--per 3] [--maxops 3] [--seed 1]
//   node --experimental-strip-types gen/cli.ts write   [--per 20] [--maxops 3] [--seed 1] [--out probe/generated]

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
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
// key is the replay identity ("seeds/010-numbers.json"); id and name are the
// loader's already-parsed parts, used to build a flat output filename. Deriving
// the filename from key is what broke write in v0.3 -- the bucket prefix made it
// a path into a directory that was never created.
const seeds = loadCorpus().byBucket.seeds
  .map((c) => ({ key: c.key, id: c.id, name: c.name, text: c.text }));

// Distinct rngSeed per (seed, index) so the whole batch is one reproducible set.
const rngSeedFor = (seedIdx: number, i: number) => (baseSeed * 1_000_003 + seedIdx * 9973 + i) >>> 0;

if (mode === "preview") {
  let shown = 0;
  seeds.forEach((seed, si) => {
    for (let i = 0; i < per; i++) {
      const g = generateCase(seed.text, rngSeedFor(si, i), { seedName: seed.key, maxOps });
      const chain = g.provenance.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(no-op)";
      const preview = g.text.length > 100 ? g.text.slice(0, 100) + `… [${g.text.length}B]` : g.text;
      console.log(`\n${seed.key}  rngSeed=${g.provenance.rngSeed}`);
      console.log(`  ${chain}`);
      console.log(`  ${preview}`);
      shown++;
    }
  });
  console.log(`\n${shown} cases previewed (deterministic; rerun for identical output).`);
} else {
  // --out may be repo-relative (the default) or absolute.
  const absOut = isAbsolute(outDir)
    ? outDir.replace(/\/?$/, "/")
    : fileURLToPath(new URL("../" + outDir + "/", import.meta.url));
  mkdirSync(absOut, { recursive: true });
  const manifest: string[] = [];
  let n = 0;
  seeds.forEach((seed, si) => {
    for (let i = 0; i < per; i++) {
      const rngSeed = rngSeedFor(si, i);
      const g = generateCase(seed.text, rngSeed, { seedName: seed.key, maxOps });
      // Flat filename, no bucket prefix: id + name are the loader's parsed parts.
      const base = `${seed.id}-${seed.name}-g${String(i).padStart(4, "0")}`;
      writeFileSync(absOut + base + ".json", g.text + "\n");
      manifest.push(JSON.stringify({
        case: base + ".json",
        origin: "generated",
        seed: seed.key,
        rngSeed,
        maxOps,
        pipeline: g.provenance.pipeline,
        note: `mutation of ${seed.key} via ${g.provenance.pipeline.map((s) => s.op).join("+") || "identity"}`,
      }));
      n++;
    }
  });
  writeFileSync(absOut + "provenance.jsonl", manifest.join("\n") + "\n");
  console.log(`wrote ${n} cases + provenance.jsonl to ${outDir}/`);
}
