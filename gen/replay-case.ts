// gen/replay-case.ts
//
// Reproduce a single generated case from its identity. Because both generators are
// pure over their identity, this prints the EXACT bytes the fuzz run tested -- the
// basis for a reproducible upstream issue, and the shrinker's input.
//
// TWO IDENTITY KINDS, dispatched on the argument shape:
//   mutation (v0.2): (seed file, rngSeed, maxOps)  -- three positional arguments
//   property (v0.4): a single "prop:vN/channel@rngSeed/size" recipe line
// The recipe form is what gen/fuzz.ts --mode prop prints on a finding and what a
// promoted case carries in its sidecar, so it must round-trip exactly.
//
// Run: node --experimental-strip-types gen/replay-case.ts <seedFile> <rngSeed> [maxOps]
//      node --experimental-strip-types gen/replay-case.ts "<prop recipe>"
//   e.g. node --experimental-strip-types gen/replay-case.ts 004-uniform-table.json 7029941 3
//        node --experimental-strip-types gen/replay-case.ts "prop:v2/general@1000003/40"

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateCase } from "./generate.ts";
import { PROPERTY_GEN_VERSION, parseIdentity, replayProperty } from "./property.ts";

const [seedFile, rngSeedArg, maxOpsArg] = process.argv.slice(2);
if (!seedFile) {
  console.error("usage: replay-case.ts <seedFile> <rngSeed> [maxOps]");
  console.error("       replay-case.ts \"prop:vN/channel@rngSeed/size\"");
  process.exit(2);
}

// --- property identity ----------------------------------------------------
if (seedFile.startsWith("prop:")) {
  const id = parseIdentity(seedFile);
  if (!id) {
    console.error(`unparseable property recipe: ${seedFile}`);
    process.exit(2);
  }
  if (id.version !== PROPERTY_GEN_VERSION) {
    // Stored case bytes are authoritative; a recipe is diagnostic provenance and
    // old generator versions are not preserved. Say so rather than silently
    // replaying a DIFFERENT case under the same name.
    console.error(
      `recipe targets generator v${id.version}, this build is v${PROPERTY_GEN_VERSION}.\n` +
      `The grammar is part of a case's identity, so these bytes would not match. ` +
      `Use the stored case file, which is authoritative.`,
    );
    process.exit(3);
  }
  const c = replayProperty(seedFile)!;
  console.error(`# ${c.recipe}`);
  console.error(`# channel: ${c.identity.channel}  nodes: ${c.nodes}  size: ${c.identity.size}`);
  process.stdout.write(c.text + "\n");
  process.exit(0);
}

// --- mutation identity ----------------------------------------------------
if (!rngSeedArg) {
  console.error("usage: replay-case.ts <seedFile> <rngSeed> [maxOps]");
  process.exit(2);
}
const rngSeed = parseInt(rngSeedArg, 10);
const maxOps = maxOpsArg ? parseInt(maxOpsArg, 10) : 3;

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
// v0.3 recipes name seeds by corpus key ("seeds/NNN-name.json"); pre-v0.3
// recipes (e.g. in archived sweep baselines) used the flat filename. Accept
// both so no old recipe goes stale.
let seedText: string;
try {
  seedText = readFileSync(casesDir + seedFile, "utf8").trim();
} catch {
  seedText = readFileSync(casesDir + "seeds/" + seedFile, "utf8").trim();
}
const g = generateCase(seedText, rngSeed, { seedName: seedFile, maxOps });

console.error(`# seed=${seedFile} rngSeed=${rngSeed} maxOps=${maxOps}`);
console.error(`# recipe: ${g.provenance.pipeline.map((s) => `${s.op}(${s.detail})`).join(" -> ") || "(identity)"}`);
process.stdout.write(g.text + "\n"); // the case itself on stdout, pipeable into any adapter
