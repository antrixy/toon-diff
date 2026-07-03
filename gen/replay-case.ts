// gen/replay-case.ts
//
// Reproduce a single generated case from its identity: (seed file, rngSeed, maxOps).
// Because generateCase is pure, this prints the EXACT bytes the fuzz run tested --
// the basis for filing a reproducible upstream issue, and the input the shrinker
// (next milestone) will reduce to a minimal reproducer.
//
// Run: node --experimental-strip-types gen/replay-case.ts <seedFile> <rngSeed> [maxOps]
//   e.g. node --experimental-strip-types gen/replay-case.ts 004-uniform-table.json 7029941 3

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCase } from "./generate.ts";

const [seedFile, rngSeedArg, maxOpsArg] = process.argv.slice(2);
if (!seedFile || !rngSeedArg) {
  console.error("usage: replay-case.ts <seedFile> <rngSeed> [maxOps]");
  process.exit(2);
}
const rngSeed = parseInt(rngSeedArg, 10);
const maxOps = maxOpsArg ? parseInt(maxOpsArg, 10) : 3;

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
const seedText = readFileSync(casesDir + seedFile, "utf8").trim();
const g = generateCase(seedText, rngSeed, { seedName: seedFile, maxOps });

console.error(`# seed=${seedFile} rngSeed=${rngSeed} maxOps=${maxOps}`);
console.error(`# recipe: ${g.provenance.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(identity)"}`);
process.stdout.write(g.text + "\n"); // the case itself on stdout, pipeable into any adapter
