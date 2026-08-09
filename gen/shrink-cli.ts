// gen/shrink-cli.ts
//
// Shrink real failing cases against the real differential matrix. Turns a bloated
// fuzz finding into a minimal reproducer you can file upstream or drop into
// probe/cases/ as a regression.
//
// FULL ENV ONLY (needs the TOON impls, like fuzz.ts).
//
// Single case (by generator coordinates or by file):
//   node --experimental-strip-types gen/shrink-cli.ts --seed 002-empty-array.json --rng 1010088 [--maxops 3]
//   node --experimental-strip-types gen/shrink-cli.ts --file some-case.json
//   node --experimental-strip-types gen/shrink-cli.ts --json '{"unsafe":9007199254740993}'
//   node --experimental-strip-types gen/shrink-cli.ts --recipe "prop:v2/general@1059844/40"
//
// Batch (collapse a whole run to one minimal case per distinct failure signature):
//   node --experimental-strip-types gen/shrink-cli.ts --batch fuzz-out.txt [--limit 40]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Adapter } from "../adapters/contract.ts";
import { tsAdapter } from "../adapters/ts.ts";
import { pythonAdapterPersistent, shutdownPython } from "../adapters/python-persistent.ts";
import { rustAdapterPersistent, shutdownRust } from "../adapters/rust-persistent.ts";
import { generateCase } from "./generate.ts";
import { dedupeFindings, parseFindingLog, refusalReport, splitByVersion } from "./finding-log.ts";
import type { Finding } from "./finding-log.ts";
import { PROPERTY_GEN_VERSION, parseIdentity, replayProperty } from "./property.ts";
import { shrink } from "./shrink.ts";
import { captureSignatures, makeInteresting } from "./failure-signature.ts";
import type { Signature } from "./failure-signature.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapterPersistent, rustAdapterPersistent];
const args = process.argv.slice(2);
const opt = (n: string): string | null => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : null; };

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
// Recipes name seeds by corpus key ("seeds/NNN-name.json") since v0.3, or by
// flat filename in pre-v0.3 recipes and archived sweep baselines. Accept both.
function readSeed(seedFile: string): string {
  try {
    return readFileSync(casesDir + seedFile, "utf8").trim();
  } catch {
    return readFileSync(casesDir + "seeds/" + seedFile, "utf8").trim();
  }
}
const sigLine = (s: Signature) => `${s.from} → ${s.to}  ${s.kind}  ${s.fp}`;

async function shrinkOne(caseText: string, label: string): Promise<void> {
  const targets = await captureSignatures(caseText, adapters);
  if (targets.length === 0) {
    console.log(`\n${label}\n  does NOT fail on any adapter pair — nothing to shrink.`);
    return;
  }
  console.log(`\n${label}`);
  console.log(`  case (${caseText.length}B): ${caseText.length > 80 ? caseText.slice(0, 80) + "…" : caseText}`);
  console.log(`  signatures (${targets.length}):`);
  for (const s of targets) console.log(`    ${sigLine(s)}`);

  const interesting = makeInteresting(targets, adapters);
  const r = await shrink(caseText, interesting, { maxChecks: 100_000 });
  const finalSigs = await captureSignatures(r.text, adapters);

  console.log(`  ── minimal (${r.endBytes}B, ${r.startBytes}→${r.endBytes} in ${r.steps} steps / ${r.checks} checks):`);
  console.log(`     ${r.text}`);
  console.log(`     reproduces: ${finalSigs.map((s) => s.fp).join(", ") || "none"}`);
}

/**
 * Resolve a finding record to the exact case bytes the fuzz run tested.
 *
 * Both generators are pure over their identity, so this reproduces the tested
 * bytes rather than something similar to them. A property recipe from another
 * generator version never reaches here: splitByVersion refuses it upstream, out
 * loud, because replaying it would produce DIFFERENT bytes under the same name.
 */
function caseTextOf(f: Finding): string {
  if (f.kind === "property") return replayProperty(f.recipe)!.text;
  return generateCase(readSeed(f.seed), f.rng, { seedName: f.seed, maxOps: f.maxOps }).text;
}

const labelOf = (f: Finding): string =>
  f.kind === "property" ? f.recipe : `seed=${f.seed} rng=${f.rng} maxOps=${f.maxOps}`;

const main = async () => {
  try {
    const batch = opt("batch");
    if (batch) {
      const limit = parseInt(opt("limit") ?? "40", 10);
      const findings = parseFindingLog(readFileSync(batch, "utf8"));

      // Stale property recipes are refused OUT LOUD before anything is shrunk.
      // After a PROPERTY_GEN_VERSION bump an old log is entirely stale, and a
      // silent skip would render that as "0 findings" -- indistinguishable from a
      // clean run, which is the did-not-run collapse one layer down.
      const split = splitByVersion(findings, PROPERTY_GEN_VERSION);
      for (const line of refusalReport(split, PROPERTY_GEN_VERSION)) console.log(line);
      const replayable = findings.filter(
        (f) => f.kind !== "property" || f.identity.version === PROPERTY_GEN_VERSION,
      );

      const reps = dedupeFindings(replayable).slice(0, limit);
      const nProp = reps.filter((f) => f.kind === "property").length;
      console.log(
        `batch: ${findings.length} findings -> ${dedupeFindings(replayable).length} distinct case(s)` +
        `; shrinking ${reps.length} (limit ${limit})` +
        ` [${nProp} property, ${reps.length - nProp} mutation]`,
      );

      // Shrink each; dedup final minimal cases by their text so identical minimals collapse.
      const seenMinimal = new Set<string>();
      for (const rep of reps) {
        const caseText = caseTextOf(rep);
        const targets = await captureSignatures(caseText, adapters);
        if (targets.length === 0) continue;
        const interesting = makeInteresting(targets, adapters);
        const r = await shrink(caseText, interesting, { maxChecks: 60_000 });
        if (seenMinimal.has(r.text)) continue;
        seenMinimal.add(r.text);
        const finalSigs = await captureSignatures(r.text, adapters);
        console.log(`\n${r.text}`);
        console.log(`   from ${labelOf(rep)}  |  ${finalSigs.map(sigLine).join(" ; ")}`);
      }
      console.log(`\n${seenMinimal.size} DISTINCT minimal reproducer(s).`);
    } else if (opt("recipe")) {
      const recipe = opt("recipe")!;
      const id = parseIdentity(recipe);
      if (!id) { console.error(`unparseable property recipe: ${recipe}`); process.exitCode = 2; }
      else if (id.version !== PROPERTY_GEN_VERSION) {
        console.error(
          `recipe targets generator v${id.version}, this build is v${PROPERTY_GEN_VERSION}.\n` +
          `The grammar is part of a case's identity, so these bytes would not match. ` +
          `Use the stored case file, which is authoritative.`);
        process.exitCode = 3;
      } else {
        await shrinkOne(replayProperty(recipe)!.text, recipe);
      }
    } else if (opt("file")) {
      await shrinkOne(readFileSync(opt("file")!, "utf8").trim(), `file: ${opt("file")}`);
    } else if (opt("json")) {
      await shrinkOne(opt("json")!, "inline json");
    } else if (opt("seed") && opt("rng")) {
      const seed = opt("seed")!, rng = parseInt(opt("rng")!, 10), maxOps = parseInt(opt("maxops") ?? "3", 10);
      const seedText = readSeed(seed);
      const caseText = generateCase(seedText, rng, { seedName: seed, maxOps }).text;
      await shrinkOne(caseText, `seed=${seed} rng=${rng} maxOps=${maxOps}`);
    } else {
      console.error("usage: --seed <file> --rng <n> [--maxops 3] | --recipe \"prop:vN/ch@seed/size\" | --file <p> | --json <t> | --batch <fuzz-out.txt> [--limit 40]");
      process.exitCode = 2;
    }
  } finally {
    shutdownPython();
    shutdownRust();
  }
};

main();
