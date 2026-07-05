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
import { shrink } from "./shrink.ts";
import { captureSignatures, makeInteresting } from "./failure-signature.ts";
import type { Signature } from "./failure-signature.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapterPersistent, rustAdapterPersistent];
const args = process.argv.slice(2);
const opt = (n: string): string | null => { const i = args.indexOf("--" + n); return i >= 0 && args[i + 1] ? args[i + 1] : null; };

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
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

// Parse a fuzz-out.txt into (seed, rngSeed, maxOps) finding coordinates.
function parseFindings(path: string): { seed: string; rng: number; maxOps: number; from: string; to: string; ops: string }[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const out: { seed: string; rng: number; maxOps: number; from: string; to: string; ops: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(ts|python|rust) → (ts|python|rust)\s+✗\s+seed=(\S+) rngSeed=(\d+) maxOps=(\d+)/);
    if (!m) continue;
    let ops = "";
    const rm = (lines[i + 1] || "").match(/^\s*recipe:\s*(.*)$/);
    if (rm) ops = rm[1].replace(/\([^)]*\)/g, "").trim();
    out.push({ from: m[1], to: m[2], seed: m[3], rng: parseInt(m[4], 10), maxOps: parseInt(m[5], 10), ops });
  }
  return out;
}

const main = async () => {
  try {
    const batch = opt("batch");
    if (batch) {
      const limit = parseInt(opt("limit") ?? "40", 10);
      const findings = parseFindings(batch);
      // Cheap pre-dedup: one representative per (from,to,ops-set) — cuts thousands to dozens.
      const groups = new Map<string, { seed: string; rng: number; maxOps: number }>();
      for (const f of findings) {
        const key = `${f.from}->${f.to}|${f.seed}|${f.ops}`;
        if (!groups.has(key)) groups.set(key, { seed: f.seed, rng: f.rng, maxOps: f.maxOps });
      }
      const reps = [...groups.values()].slice(0, limit);
      console.log(`batch: ${findings.length} findings -> ${groups.size} candidate groups; shrinking ${reps.length} (limit ${limit})`);
      // Shrink each; dedup final minimal cases by their text so identical minimals collapse.
      const seenMinimal = new Set<string>();
      for (const rep of reps) {
        const seedText = readFileSync(casesDir + rep.seed, "utf8").trim();
        const caseText = generateCase(seedText, rep.rng, { seedName: rep.seed, maxOps: rep.maxOps }).text;
        const targets = await captureSignatures(caseText, adapters);
        if (targets.length === 0) continue;
        const interesting = makeInteresting(targets, adapters);
        const r = await shrink(caseText, interesting, { maxChecks: 60_000 });
        if (seenMinimal.has(r.text)) continue;
        seenMinimal.add(r.text);
        const finalSigs = await captureSignatures(r.text, adapters);
        console.log(`\n${r.text}`);
        console.log(`   from seed=${rep.seed} rng=${rep.rng}  |  ${finalSigs.map(sigLine).join(" ; ")}`);
      }
      console.log(`\n${seenMinimal.size} DISTINCT minimal reproducer(s).`);
    } else if (opt("file")) {
      await shrinkOne(readFileSync(opt("file")!, "utf8").trim(), `file: ${opt("file")}`);
    } else if (opt("json")) {
      await shrinkOne(opt("json")!, "inline json");
    } else if (opt("seed") && opt("rng")) {
      const seed = opt("seed")!, rng = parseInt(opt("rng")!, 10), maxOps = parseInt(opt("maxops") ?? "3", 10);
      const seedText = readFileSync(casesDir + seed, "utf8").trim();
      const caseText = generateCase(seedText, rng, { seedName: seed, maxOps }).text;
      await shrinkOne(caseText, `seed=${seed} rng=${rng} maxOps=${maxOps}`);
    } else {
      console.error("usage: --seed <file> --rng <n> [--maxops 3] | --file <p> | --json <t> | --batch <fuzz-out.txt> [--limit 40]");
      process.exitCode = 2;
    }
  } finally {
    shutdownPython();
    shutdownRust();
  }
};

main();
