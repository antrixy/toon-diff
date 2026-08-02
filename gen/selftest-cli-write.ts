// gen/selftest-cli-write.ts
//
// Proves `gen/cli.ts write` persists a batch correctly. This path had no coverage
// through v0.3, which is exactly why it broke unnoticed: v0.3 made the corpus key
// bucket-prefixed ("seeds/010-numbers.json"), the filename was derived from that
// key, and the first writeFileSync went ENOENT into a directory nobody created.
// Every other gen/ selftest is in-process, but the defect lived in the ENTRY POINT
// -- argv handling and path resolution -- so this one spawns the real CLI. Testing
// an imported function would not have caught it.
//
// The load-bearing check is REPLAY IDENTITY: for every manifest line, feeding
// (seed, rngSeed, maxOps) back through generateCase must reproduce the written
// bytes exactly. That is the manifest's whole promise, and a filename or seed-name
// mix-up breaks it even when the files look right.
//
// What is deliberately NOT checked: corpus legality. Filenames here reuse the
// seed's three-digit id, so a batch is not loadable as a corpus bucket. That is by
// design -- probe/generated/ is gitignored scratch, and promotion is a separate
// command that owns id allocation. See the header of gen/cli.ts.
//
// Run: node --experimental-strip-types gen/selftest-cli-write.ts

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCorpus } from "../probe/corpus.ts";
import { generateCase } from "./generate.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const PER = 2;
const MAXOPS = 3;

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

const seeds = loadCorpus().byBucket.seeds;
const seedText = new Map(seeds.map((c) => [c.key, c.text]));

/** Run the real CLI in write mode against an out dir. */
function runWrite(outDir: string) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", CLI, "write", "--per", String(PER),
     "--maxops", String(MAXOPS), "--out", outDir],
    { cwd: REPO, encoding: "utf8" },
  );
}

// ---- absolute --out -------------------------------------------------------
// A path outside the repo must not be concatenated onto the repo root.
const absDir = mkdtempSync(join(tmpdir(), "toon-diff-write-"));
let relDir = "";

try {
  const run = runWrite(absDir);
  check("absolute --out: exits 0", run.status === 0);
  if (run.status !== 0) console.log(`       stderr: ${(run.stderr || "").split("\n")[0]}`);

  const files = readdirSync(absDir).sort();
  const cases = files.filter((f) => f !== "provenance.jsonl");

  check("writes one case per (seed, index)", cases.length === seeds.length * PER);
  check("writes exactly one manifest", files.length === cases.length + 1);
  check("manifest is named provenance.jsonl", files.includes("provenance.jsonl"));

  // The v0.3 break, pinned: a bucket-prefixed name would make this a subpath.
  check("no filename contains a path separator",
    cases.every((f) => !f.includes("/") && !f.includes("\\")));
  check("every filename is NNN-name-gNNNN.json",
    cases.every((f) => /^\d{3}-[a-z0-9]+(?:-[a-z0-9]+)*-g\d{4}\.json$/.test(f)));

  // ---- manifest integrity -------------------------------------------------
  const lines = readFileSync(join(absDir, "provenance.jsonl"), "utf8")
    .split("\n").filter((l) => l.trim() !== "");
  check("manifest has one line per case", lines.length === cases.length);

  const records = lines.map((l) => JSON.parse(l) as {
    case: string; origin: string; seed: string; rngSeed: number;
    maxOps: number; pipeline: { op: string; detail: string }[]; note: string;
  });

  check("every manifest line names a file that exists",
    records.every((r) => existsSync(join(absDir, r.case))));
  check("every manifest seed is a corpus key that resolves",
    records.every((r) => seedText.has(r.seed)));
  check("every manifest seed carries its bucket prefix",
    records.every((r) => r.seed.startsWith("seeds/")));
  check("every manifest line records maxOps", records.every((r) => r.maxOps === MAXOPS));
  check("rngSeeds are distinct across the batch",
    new Set(records.map((r) => r.rngSeed)).size === records.length);
  check("origin is 'generated'", records.every((r) => r.origin === "generated"));

  // ---- replay identity: the promise the manifest makes ---------------------
  let replayed = 0;
  const bad: string[] = [];
  for (const r of records) {
    const text = seedText.get(r.seed);
    if (text === undefined) { bad.push(`${r.case}: unknown seed`); continue; }
    const again = generateCase(text, r.rngSeed, { seedName: r.seed, maxOps: r.maxOps });
    const onDisk = readFileSync(join(absDir, r.case), "utf8");
    if (onDisk === again.text + "\n") replayed++;
    else bad.push(r.case);
  }
  check(`all ${records.length} cases replay byte-for-byte from their manifest line`,
    replayed === records.length);
  if (bad.length) console.log(`       first mismatch: ${bad[0]}`);

  // Pipelines are recorded, not invented: they match what replay produces.
  check("recorded pipelines match replayed pipelines",
    records.every((r) => {
      const t = seedText.get(r.seed);
      if (t === undefined) return false;
      const p = generateCase(t, r.rngSeed, { seedName: r.seed, maxOps: r.maxOps }).provenance.pipeline;
      return JSON.stringify(p) === JSON.stringify(r.pipeline);
    }));

  // ---- determinism --------------------------------------------------------
  const absDir2 = mkdtempSync(join(tmpdir(), "toon-diff-write-"));
  try {
    const run2 = runWrite(absDir2);
    check("second run exits 0", run2.status === 0);
    const files2 = readdirSync(absDir2).sort();
    check("second run writes the same filenames", JSON.stringify(files2) === JSON.stringify(files));
    check("second run is byte-identical in every file",
      files2.every((f) =>
        readFileSync(join(absDir2, f), "utf8") === readFileSync(join(absDir, f), "utf8")));
  } finally {
    rmSync(absDir2, { recursive: true, force: true });
  }

  // ---- repo-relative --out (the default shape) ----------------------------
  // probe/generated/ is gitignored, so a sibling scratch name stays out of git.
  const relName = "probe/generated-selftest-tmp";
  relDir = join(REPO, relName);
  const run3 = runWrite(relName);
  check("relative --out: exits 0", run3.status === 0);
  check("relative --out resolves under the repo root",
    existsSync(relDir) && readdirSync(relDir).length === cases.length + 1);
} finally {
  rmSync(absDir, { recursive: true, force: true });
  if (relDir) rmSync(relDir, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\nCLI WRITE PROVEN: 20 checks pass. Batches are flat-named, deterministic, and replay from their manifest."
  : `\nCLI WRITE BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
