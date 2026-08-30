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

import { loadCorpus } from "./probe/corpus.ts";
import { ingest, equal } from "./oracle/ingest.ts";
import { ingestionFidelity } from "./oracle/compare.ts"; // kept only for the v1-vs-v2 note
import type { Adapter } from "./adapters/contract.ts";
import { tsAdapter } from "./adapters/ts.ts";
import { pythonAdapter } from "./adapters/python.ts";
import { rustAdapter } from "./adapters/rust.ts";
import { explain, renderExplainReport } from "./probe/explain.ts";
import { buildGrid, renderGridReport, buildSpecGrid, renderSpecGridReport } from "./probe/grid.ts";
import { runSpecCases } from "./probe/spec-run.ts";

const adapters: Adapter[] = [tsAdapter, pythonAdapter, rustAdapter];

interface Mismatch {
  file: string;
  from: string;
  to: string;
  expected: string;
  actual: string;
  error?: string;
}

const main = async () => {
  const corpus = loadCorpus(); // validated: buckets, sidecars, wire text, raw-text fidelity
  // TWO LANES, DELIBERATELY SEPARATE. The pairwise matrix runs JSON-in cases
  // through every ordered adapter pair. Spec cases are wire-in and one-sided —
  // the spec is the oracle and there is no encoder — so they run N checks each
  // in their own lane. Folding them together would make pairChecks read
  // specCount * N * N for cases that cost specCount * N, turning the arithmetic
  // tripwire into a fudge.
  const cases = corpus.cases.filter((c) => c.bucket !== "spec");
  const specCases = corpus.byBucket.spec;
  const mismatches: Mismatch[] = [];
  const wouldHaveQuarantined: string[] = []; // v1 would have benched these
  let pairChecks = 0;

  for (const c of cases) {
    const file = c.key; // e.g. "seeds/013-precision-loss-2pow53plus1.json"
    const raw = c.text;

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

  // ---- the spec lane: wire from SPEC.md, no encoder in the loop ------------
  const spec = await runSpecCases(specCases, adapters);

  // ---- report -------------------------------------------------------------
  console.log(
    `corpus: ${corpus.cases.length} cases (${cases.length} pairwise, ${specCases.length} spec) | ` +
      `pair-checks: ${pairChecks} | spec-checks: ${spec.specChecks}\n`,
  );

  if (wouldHaveQuarantined.length) {
    console.log(`now-testable (v1 would have quarantined ${wouldHaveQuarantined.length}): ${wouldHaveQuarantined.join(", ")}\n`);
  }

  // NxN overview first: which PAIRS disagree, on how many cases, and (per
  // divergent case) error vs value-mismatch. Detail blocks follow as evidence.
  const grid = buildGrid(mismatches, adapters.map((a) => a.name), cases.map((c) => c.key));
  for (const line of renderGridReport(grid)) console.log(line);
  console.log();

  // The spec lane renders separately: rows are cases, columns are decoders, and
  // a mark means "disagrees with the SPECIFICATION" rather than "disagrees with
  // a peer". This is the evidence the pairwise design structurally cannot
  // produce, so it is not folded into the grid above.
  if (specCases.length) {
    const specGrid = buildSpecGrid(spec.records, adapters.map((a) => a.name), specCases.map((c) => c.key));
    for (const line of renderSpecGridReport(specGrid)) console.log(line);
    console.log();
  }

  const all = [...mismatches, ...spec.records];
  if (all.length === 0) {
    console.log("ALL PAIRS AGREE on every case, and every decoder matches the spec.");
  } else {
    console.log(`DIVERGENCES (${mismatches.length} pairwise, ${spec.records.length} vs spec):\n`);
    for (const m of all) {
      console.log(`${m.from} \u2192 ${m.to}   \u2717   ${m.file}`);
      if (m.error) { console.log(`  error:    ${m.error.trimEnd()}\n`); continue; }
      console.log(`  expected: ${m.expected}`);
      console.log(`  actual:   ${m.actual}\n`);
    }
    // Interpretation layer: rules, clause citations, spec-version verdicts.
    // Raw divergences above are the evidence; this is what they MEAN.
    for (const line of renderExplainReport(explain(all, corpus))) {
      console.log(line);
    }
  }
  process.exit(all.length === 0 ? 0 : 1);
};

main();
