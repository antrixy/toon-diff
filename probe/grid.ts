/**
 * probe/grid.ts — NxN matrix grid report (v0.3 finale).
 *
 * Turns the matrix's flat divergence list into the shape people actually ask
 * about: "which PAIRS disagree, and on what?" Two levels:
 *
 *   AGGREGATE  — one NxN grid (encoder row → decoder col), each cell the
 *                count of divergent CASES for that ordered pair. A glance
 *                shows the 013 asymmetry (every TS-involving pair) vs the
 *                002 column pattern (python/rust decoders only).
 *   BY CASE    — one NxN grid per divergent case, cells marked
 *                · agree   ✗ value-mismatch   E error
 *                so error-vs-mismatch (002: python coerces, rust rejects)
 *                is visible without reading the detail blocks.
 *
 * Pure and side-effect free: takes the divergence records plus the adapter
 * and case orderings, renders strings. Reuses explain.ts's DivergenceRecord
 * so the harness never grows a third copy of that shape. Throws on harness
 * bugs (unknown adapter, unknown case, duplicate pair record) — those are
 * OUR mistakes, not data.
 */

import type { DivergenceRecord } from "./explain.ts";

export type CellMark = "agree" | "value-mismatch" | "error";

export interface GridCell {
  from: string; // encoder
  to: string; // decoder
  divergentCases: string[]; // corpus keys, corpus order
  errorCount: number; // how many of those divergences were errors
}

export interface CaseGrid {
  file: string; // corpus key
  /** marks[from][to] — every adapter pair present, "agree" by default. */
  marks: Record<string, Record<string, CellMark>>;
}

export interface GridReport {
  adapters: string[]; // cli order, rows and cols
  caseCount: number;
  pairChecks: number; // caseCount * N * N — must match cli-v2's counter
  totalDivergences: number;
  /** cells[rowIdx][colIdx], rows = encoder, cols = decoder, cli order. */
  cells: GridCell[][];
  /** Only divergent cases, corpus order. */
  caseGrids: CaseGrid[];
}

/** Build the grid. adapterNames and caseKeys define ordering (cli / corpus). */
export function buildGrid(
  records: DivergenceRecord[],
  adapterNames: string[],
  caseKeys: string[],
): GridReport {
  const adapterIdx = new Map(adapterNames.map((a, i) => [a, i]));
  const caseIdx = new Map(caseKeys.map((k, i) => [k, i]));

  const cells: GridCell[][] = adapterNames.map((from) =>
    adapterNames.map((to) => ({ from, to, divergentCases: [], errorCount: 0 })),
  );
  const perCase = new Map<string, Map<string, CellMark>>(); // file -> "from\u0000to" -> mark

  const seen = new Set<string>();
  for (const r of records) {
    const fi = adapterIdx.get(r.from);
    const ti = adapterIdx.get(r.to);
    if (fi === undefined) throw new Error(`grid: divergence names unknown adapter "${r.from}" — harness bug`);
    if (ti === undefined) throw new Error(`grid: divergence names unknown adapter "${r.to}" — harness bug`);
    if (!caseIdx.has(r.file)) throw new Error(`grid: divergence names unknown case "${r.file}" — harness bug`);
    const dupKey = `${r.file}\u0000${r.from}\u0000${r.to}`;
    if (seen.has(dupKey)) {
      throw new Error(`grid: duplicate divergence for ${r.file} (${r.from} -> ${r.to}) — harness bug`);
    }
    seen.add(dupKey);

    const cell = cells[fi][ti];
    cell.divergentCases.push(r.file);
    if (r.error !== undefined) cell.errorCount++;

    let marks = perCase.get(r.file);
    if (!marks) {
      marks = new Map();
      perCase.set(r.file, marks);
    }
    marks.set(`${r.from}\u0000${r.to}`, r.error !== undefined ? "error" : "value-mismatch");
  }

  // Corpus order within each cell and across case grids.
  for (const row of cells) {
    for (const cell of row) {
      cell.divergentCases.sort((a, b) => caseIdx.get(a)! - caseIdx.get(b)!);
    }
  }
  const caseGrids: CaseGrid[] = [...perCase.keys()]
    .sort((a, b) => caseIdx.get(a)! - caseIdx.get(b)!)
    .map((file) => {
      const src = perCase.get(file)!;
      const marks: CaseGrid["marks"] = {};
      for (const from of adapterNames) {
        marks[from] = {};
        for (const to of adapterNames) {
          marks[from][to] = src.get(`${from}\u0000${to}`) ?? "agree";
        }
      }
      return { file, marks };
    });

  return {
    adapters: adapterNames,
    caseCount: caseKeys.length,
    pairChecks: caseKeys.length * adapterNames.length * adapterNames.length,
    totalDivergences: records.length,
    cells,
    caseGrids,
  };
}

const MARK_CHAR: Record<CellMark, string> = {
  agree: "\u00b7",
  "value-mismatch": "\u2717",
  error: "E",
};

/** One aligned NxN grid: rows/cols from adapters, cellText yields each cell. */
function renderOneGrid(
  adapters: string[],
  cellText: (from: string, to: string) => string,
  indent: string,
): string[] {
  const label = "enc\\dec";
  const labelW = Math.max(label.length, ...adapters.map((a) => a.length));
  const colW = adapters.map((to) =>
    Math.max(to.length, ...adapters.map((from) => cellText(from, to).length)),
  );
  const lines: string[] = [];
  lines.push(
    indent + label.padEnd(labelW) + adapters.map((a, i) => "  " + a.padStart(colW[i])).join(""),
  );
  for (const from of adapters) {
    lines.push(
      indent +
        from.padEnd(labelW) +
        adapters.map((to, i) => "  " + cellText(from, to).padStart(colW[i])).join(""),
    );
  }
  return lines;
}

/** CLI rendering — aggregate grid always; per-case grids only when divergent. */
export function renderGridReport(report: GridReport): string[] {
  const lines: string[] = [];
  lines.push(
    `GRID (encoder row \u2192 decoder col): divergent cases per pair, of ${report.caseCount}`,
  );
  const byPair = new Map(report.cells.flat().map((c) => [`${c.from}\u0000${c.to}`, c]));
  lines.push(
    ...renderOneGrid(
      report.adapters,
      (from, to) => {
        const n = byPair.get(`${from}\u0000${to}`)!.divergentCases.length;
        return n === 0 ? MARK_CHAR.agree : String(n);
      },
      "  ",
    ),
  );
  lines.push(`  ${MARK_CHAR.agree} = all cases agree`);
  if (report.caseGrids.length) {
    lines.push("");
    lines.push(
      `BY CASE (${MARK_CHAR["value-mismatch"]} value-mismatch, ${MARK_CHAR.error} error):`,
    );
    for (const g of report.caseGrids) {
      lines.push(`  ${g.file}`);
      lines.push(...renderOneGrid(report.adapters, (from, to) => MARK_CHAR[g.marks[from][to]], "    "));
    }
  }
  return lines;
}
