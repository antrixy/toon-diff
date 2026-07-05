// cli.ts (v2)
//
// Drives the differential matrix over the probe corpus using the LOSSLESS
// oracle (oracle/ingest.ts). The v1 quarantine is gone: because ingestion no
// longer routes numbers through an f64, every case is testable -- including
// 010 (-0, 1.0) and 013 (2^53+1), which v1 had to bench.
//
// For every case and every ordered adapter pair (X, Y) it checks:
//      decode_Y( encode_X( case ) )  ==  case        (compared losslessly)
//
// Run (after installing the impls):  node --experimental-strip-types cli.ts
//
// NOTE on what a red row MEANS now: with lossless comparison, a mismatch on 013
// for any TS-involving pair is a REAL finding -- the JS f64 path corrupts the
// integer at the adapter's own JSON.parse, before TOON is even involved. That
// is the reportable behavior, not a harness artifact.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ingest, equal } from "./oracle/ingest.ts";
import { ingestionFidelity } from "./oracle/compare.ts"; // kept only for the v1-vs-v2 note
import type { Adapter } from "./adapters/contract.ts";
import { tsAdapter } from "./adapters/ts.ts";
import { pythonAdapter } from "./adapters/python.ts";
import { rustAdapter } from "./adapters/rust.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapter, rustAdapter];
const casesDir = fileURLToPath(new URL("./probe/cases/", import.meta.url));

interface Mismatch {
  file: string;
  from: string;
  to: string;
  expected: string;
  actual: string;
  error?: string;
}

const main = async () => {
  const files = (await readdir(casesDir)).filter((f) => f.endsWith(".json")).sort();
  const mismatches: Mismatch[] = [];
  const wouldHaveQuarantined: string[] = []; // v1 would have benched these
  let pairChecks = 0;

  for (const file of files) {
    const raw = (await readFile(casesDir + file, "utf8")).trim();

    // Informational only: show which cases v1 could not test but v2 now can.
    if (!ingestionFidelity(raw).faithful) wouldHaveQuarantined.push(file);

    const expected = ingest(raw); // LOSSLESS: exact lexeme preserved, no f64
    for (const X of adapters) {
      for (const Y of adapters) {
        pairChecks++;
        try {
          const back = await Y.decode(await X.encode(raw));
          if (!equal(ingest(back), expected)) {
            mismatches.push({
              file, from: X.name, to: Y.name,
              expected: raw, actual: back,
            });
          }
        } catch (e) {
          mismatches.push({
            file, from: X.name, to: Y.name,
            expected: raw, actual: "",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }

  // ---- report -------------------------------------------------------------
  console.log(`corpus: ${files.length} cases | tested: ${files.length} (lossless) | pair-checks: ${pairChecks}\n`);

  if (wouldHaveQuarantined.length) {
    console.log(`now-testable (v1 would have quarantined ${wouldHaveQuarantined.length}): ${wouldHaveQuarantined.join(", ")}\n`);
  }

  if (mismatches.length === 0) {
    console.log("ALL PAIRS AGREE on every case.");
  } else {
    console.log(`DIVERGENCES (${mismatches.length}):\n`);
    for (const m of mismatches) {
      console.log(`${m.from} \u2192 ${m.to}   \u2717   ${m.file}`);
      if (m.error) { console.log(`  error:    ${m.error}\n`); continue; }
      console.log(`  expected: ${m.expected}`);
      console.log(`  actual:   ${m.actual}\n`);
    }
  }
  process.exit(mismatches.length === 0 ? 0 : 1);
};

main();
