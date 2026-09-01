/**
 * probe/selftest-grid.ts — proves the NxN grid report.
 *
 * Fixtures are TODAY'S REAL MATRIX (2026-07-12): the exact 7 divergences
 * cli-v2 printed on a verified environment — same pins as selftest-explain,
 * so the two engines are proven against the same world. Checks:
 *   - aggregate cell counts (the 013 TS-asymmetry + the 002 decoder column)
 *   - error-vs-mismatch marks per case (002: python coerces ✗, rust errors E)
 *   - corpus ordering of case grids and in-cell case lists
 *   - pairChecks arithmetic matches cli-v2's counter (14 x 3 x 3 = 126)
 *
 * v0.4: the N×N grid is fed NON-SPEC cases only. Spec cases are one-sided
 * (N checks, not N×N) and render in their own lane via buildSpecGrid, so
 * folding them in here would inflate pairChecks by 2 x 3 x 3 instead of the
 * 2 x 3 they actually cost. The arithmetic is a tripwire, so it must stay true.
 *   - harness-bug tripwires: unknown adapter, unknown case, duplicate record
 *   - rendering: alignment inputs, legend, all-agree grid has no BY CASE
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types probe/selftest-grid.ts
 */

import { loadCorpus } from "./corpus.ts";
import {
  buildGrid, renderGridReport, buildSpecGrid, renderSpecGridReport,
  type GridVocabulary, type OracleVocabulary,
} from "./grid.ts";
import type { DivergenceRecord } from "./explain.ts";

let pass = 0;
let fail = 0;
function ok(label: string, got: unknown, want: unknown) {
  const good = Object.is(got, want);
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

const K002 = "seeds/002-empty-array.json";
const K013 = "seeds/013-precision-loss-2pow53plus1.json";
const N993 = `{"unsafe":9007199254740993}`;
const N992 = `{"unsafe":9007199254740992}`;

// The 7 divergences exactly as printed by cli-v2 on 2026-07-12.
const MATRIX_2026_07_12: DivergenceRecord[] = [
  { file: K002, from: "ts", to: "python", expected: "[]", actual: `"[]"` },
  {
    file: K002, from: "ts", to: "rust", expected: "[]", actual: "",
    error: "rust decode failed: decode failed: Parse error at line 1, column 3: Expected array length, found RightBracket",
  },
  { file: K013, from: "ts", to: "ts", expected: N993, actual: N992 },
  { file: K013, from: "ts", to: "python", expected: N993, actual: `{"unsafe": 9007199254740992}` },
  { file: K013, from: "ts", to: "rust", expected: N993, actual: N992 },
  { file: K013, from: "python", to: "ts", expected: N993, actual: N992 },
  { file: K013, from: "rust", to: "ts", expected: N993, actual: N992 },
];

const ADAPTERS = ["ts", "python", "rust"]; // cli order
const corpus = loadCorpus();
// NON-SPEC only: the pairwise matrix never runs a spec case (see spec-run.ts).
const caseKeys = corpus.cases.filter((c) => c.bucket !== "spec").map((c) => c.key);
const specCaseKeys = corpus.byBucket.spec.map((c) => c.key);

console.log("Part 1: aggregate grid on the real 7");
const grid = buildGrid(MATRIX_2026_07_12, ADAPTERS, caseKeys);
ok("14 cases", grid.caseCount, 14);
ok("126 pair-checks (matches cli-v2 arithmetic)", grid.pairChecks, 126);
ok("7 total divergences", grid.totalDivergences, 7);
ok("adapters keep cli order", grid.adapters.join(","), "ts,python,rust");

const cell = (from: string, to: string) =>
  grid.cells[ADAPTERS.indexOf(from)][ADAPTERS.indexOf(to)];
ok("ts->ts: 1 divergent case", cell("ts", "ts").divergentCases.length, 1);
ok("ts->python: 2 divergent cases", cell("ts", "python").divergentCases.length, 2);
ok("ts->rust: 2 divergent cases", cell("ts", "rust").divergentCases.length, 2);
ok("python->ts: 1 divergent case", cell("python", "ts").divergentCases.length, 1);
ok("rust->ts: 1 divergent case", cell("rust", "ts").divergentCases.length, 1);
ok("python->python clean", cell("python", "python").divergentCases.length, 0);
ok("python->rust clean", cell("python", "rust").divergentCases.length, 0);
ok("rust->python clean", cell("rust", "python").divergentCases.length, 0);
ok("rust->rust clean", cell("rust", "rust").divergentCases.length, 0);
ok("cell counts sum to 7", grid.cells.flat().reduce((n, c) => n + c.divergentCases.length, 0), 7);
ok("ts->rust cell counts its 1 error (002)", cell("ts", "rust").errorCount, 1);
ok("ts->python cell has 0 errors", cell("ts", "python").errorCount, 0);
ok("in-cell case list is corpus-ordered (002 before 013)", cell("ts", "python").divergentCases.join("|"), `${K002}|${K013}`);

console.log("Part 2: per-case grids");
ok("2 divergent cases get grids", grid.caseGrids.length, 2);
ok("case grids corpus-ordered (002 first)", grid.caseGrids[0].file, K002);
const g002 = grid.caseGrids[0].marks;
const g013 = grid.caseGrids[1].marks;
ok("002 ts->python marked value-mismatch", g002["ts"]["python"], "value-mismatch");
ok("002 ts->rust marked error", g002["ts"]["rust"], "error");
ok("002 ts->ts agrees", g002["ts"]["ts"], "agree");
ok("013 ts->ts marked value-mismatch", g013["ts"]["ts"], "value-mismatch");
ok("013 marks 5 divergent pairs", ADAPTERS.flatMap((f) => ADAPTERS.map((t) => g013[f][t])).filter((m) => m !== "agree").length, 5);
ok("013 python->python agrees (the real asymmetry)", g013["python"]["python"], "agree");

console.log("Part 3: harness-bug tripwires");
{
  // M15: the ENCODER side of the unknown-adapter guard. Only the decoder side
  // was exercised, so `from` could have been dropped on the floor entirely —
  // which would silently discard whole rows of a report rather than failing.
  let threwFrom = "";
  try {
    buildGrid([{ file: K002, from: "go", to: "ts", expected: "", actual: "" }], ADAPTERS, caseKeys);
  } catch (e) { threwFrom = (e as Error).message; }
  ok("unknown ENCODER throws", threwFrom.includes("unknown adapter"), true);
  ok("and names the offending side", threwFrom.includes("\"go\""), true);
}
{
  let threw = "";
  try {
    buildGrid([{ file: K002, from: "ts", to: "go", expected: "", actual: "" }], ADAPTERS, caseKeys);
  } catch (e) { threw = (e as Error).message; }
  ok("unknown adapter throws and names it", threw.includes(`"go"`), true);
}
{
  let threw = "";
  try {
    buildGrid([{ file: "seeds/999-nope.json", from: "ts", to: "ts", expected: "", actual: "" }], ADAPTERS, caseKeys);
  } catch (e) { threw = (e as Error).message; }
  ok("unknown case throws", threw.includes("unknown case"), true);
}
{
  let threw = "";
  try {
    buildGrid([MATRIX_2026_07_12[0], MATRIX_2026_07_12[0]], ADAPTERS, caseKeys);
  } catch (e) { threw = (e as Error).message; }
  ok("duplicate (file, pair) record throws", threw.includes("duplicate"), true);
}

console.log("Part 4: rendering");
const lines = renderGridReport(grid);
ok("header names the geometry", lines[0].includes("encoder row"), true);
ok("header carries the case count", lines[0].includes("of 14"), true);
ok("column header row renders all adapters", lines[1].includes("ts") && lines[1].includes("python") && lines[1].includes("rust"), true);
ok("a count cell renders (ts row has a 2)", lines.some((l) => l.trimStart().startsWith("ts ") && l.includes("2")), true);
ok("agree cells render as \u00b7", lines.some((l) => l.trimStart().startsWith("python") && l.includes("\u00b7")), true);
ok("legend renders", lines.some((l) => l.includes("= all cases agree")), true);
ok("BY CASE section renders", lines.some((l) => l.startsWith("BY CASE")), true);
ok("002 grid renders its E", lines.some((l) => l.trimStart().startsWith("ts") && l.trimEnd().endsWith("E")), true);
ok("both case files named", lines.some((l) => l.includes(K002)) && lines.some((l) => l.includes(K013)), true);

const clean = renderGridReport(buildGrid([], ADAPTERS, caseKeys));
ok("all-agree grid still renders", clean[0].startsWith("GRID"), true);
ok("all-agree grid has no BY CASE section", clean.some((l) => l.startsWith("BY CASE")), false);
ok("all-agree cells are all \u00b7", clean.slice(2, 5).every((l) => !/\d/.test(l.replace(/^\s*\w+/, ""))), true);

console.log("Part 5: the spec lane (one-sided, v0.4)");
// Rows are CASES and columns are DECODERS — there is no encoder axis, because
// the wire came from SPEC.md. The synthetic "spec" name never enters the N\u00d7N
// adapter namespace, and these checks pin that separation.
const SPEC_K1 = "spec/001-u64-boundary.json";
const SPEC_K2 = "spec/002-legacy-empty-array-root.json";
const specRecords: DivergenceRecord[] = [
  { file: SPEC_K1, from: "spec", to: "ts", expected: `{"n":18446744073709551617}`, actual: `{"n":18446744073709551616}` },
  { file: SPEC_K1, from: "spec", to: "rust", expected: `{"n":18446744073709551617}`, actual: "", error: "number out of range" },
];
const sg = buildSpecGrid(specRecords, ADAPTERS, specCaseKeys);
ok("2 spec cases", sg.caseKeys.length, 2);
// 2 x 3 = 6, NOT 2 x 3 x 3. The whole reason spec cases are kept out of the
// N\u00d7N counter: a one-sided case costs N checks, and the arithmetic is a tripwire.
ok("6 spec checks (N, not N\u00d7N)", sg.specChecks, 6);
ok("spec checks are not pair-checks", sg.specChecks === specCaseKeys.length * ADAPTERS.length, true);
ok("2 divergences recorded", sg.totalDivergences, 2);
ok("ts marked value-mismatch", sg.marks[SPEC_K1]["ts"], "value-mismatch");
ok("rust marked error", sg.marks[SPEC_K1]["rust"], "error");
ok("python agrees on the u64 case", sg.marks[SPEC_K1]["python"], "agree");
ok("the clean case is clean across every decoder",
  ADAPTERS.every((a) => sg.marks[SPEC_K2][a] === "agree"), true);

// Harness-bug tripwires, same discipline as the N\u00d7N lane.
{
  let threw = "";
  try {
    buildSpecGrid([{ file: SPEC_K1, from: "ts", to: "rust", expected: "", actual: "" }], ADAPTERS, specCaseKeys);
  } catch (e) { threw = (e as Error).message; }
  // A pairwise record routed into the one-sided lane would silently drop its
  // encoder side and report a pair result as a spec result.
  ok("a real encoder in the spec lane throws", threw.includes("admits only"), true);
}
{
  let threw = "";
  try {
    buildSpecGrid([{ file: SPEC_K1, from: "spec", to: "go", expected: "", actual: "" }], ADAPTERS, specCaseKeys);
  } catch (e) { threw = (e as Error).message; }
  ok("unknown decoder throws", threw.includes("unknown decoder"), true);
}
{
  let threw = "";
  try {
    buildSpecGrid([{ file: "spec/999-nope.json", from: "spec", to: "ts", expected: "", actual: "" }], ADAPTERS, specCaseKeys);
  } catch (e) { threw = (e as Error).message; }
  ok("unknown spec case throws", threw.includes("unknown case"), true);
}
{
  let threw = "";
  try {
    buildSpecGrid([specRecords[0], specRecords[0]], ADAPTERS, specCaseKeys);
  } catch (e) { threw = (e as Error).message; }
  ok("duplicate (case, decoder) record throws", threw.includes("duplicate"), true);
}

const specLines = renderSpecGridReport(sg);
ok("spec header names the lane", specLines[0].startsWith("SPEC GRID"), true);
ok("spec header says no encoder is in the loop", specLines[0].includes("no encoder in the loop"), true);
ok("spec header carries the check count", specLines[0].includes("6 check(s)"), true);
ok("spec grid names its decoders", specLines[1].includes("ts") && specLines[1].includes("rust"), true);
ok("spec grid renders a row per case",
  specLines.some((l) => l.includes(SPEC_K1)) && specLines.some((l) => l.includes(SPEC_K2)), true);
ok("spec legend explains agreement WITH THE SPEC",
  specLines.some((l) => l.includes("decodes as the spec says")), true);
const emptySpec = renderSpecGridReport(buildSpecGrid([], ADAPTERS, []));
ok("an empty spec bucket still renders", emptySpec.some((l) => l.includes("(no spec cases)")), true);

console.log("Part 6: a NON-TOON configuration (4.5b generalization, v0.4)");
// THE WHOLE POINT OF THIS PART. The renderers now take vocabulary and an oracle
// name instead of hardwiring TOON's words, and a parameter that is accepted and
// then ignored is indistinguishable from no parameter at all -- the M19 shape,
// on a third file. So the generalization is exercised against a configuration
// that shares NOTHING with TOON: four implementations instead of three, and a
// privileged oracle called "git" rather than "spec".
//
// The shape is backlog.md §4.1's: gitignore, where `git check-ignore -v` is the
// reference and the other three implementations are judged against it. That is
// why decisions.md ruled 4.5b must cover the one-sided geometry -- it is not a
// toon-diff peculiarity, it is what you get whenever an oracle is privileged.
// This is a SHAPE test, not a claim about gitignore behaviour: the marks below
// are invented, and nothing here asserts anything about any implementation.
const GIT_IMPLS = ["git", "ignore-rs", "node-ignore", "pathspec"];
const GIT_VOCAB: GridVocabulary = {
  rowRole: "reference",
  colRole: "implementation",
  axisLabel: "ref\\impl",
  unit: "patterns",
  agreeLegend: "all patterns agree",
};
const GIT_ORACLE: OracleVocabulary = {
  oracleName: "git",
  title: "ORACLE GRID",
  axisLabel: "pattern\\impl",
  unit: "pattern(s)",
  sourceNote: "judged against git check-ignore -v",
  agreeLegend: "matches git",
  disagreeLegend: "differs from git",
  emptyNote: "(no patterns)",
};

// -- 4-wide pairwise, proving buildGrid is not bound to three --
const P1 = "patterns/001-negation.txt";
const P2 = "patterns/002-trailing-slash.txt";
const wide = buildGrid(
  [
    { file: P1, from: "ignore-rs", to: "pathspec", expected: "", actual: "" },
    { file: P2, from: "node-ignore", to: "git", expected: "", actual: "", error: "parse" },
  ],
  GIT_IMPLS,
  [P1, P2],
);
ok("4 implementations give a 4x4 grid", wide.cells.length, 4);
ok("every row is 4 wide", wide.cells.every((r) => r.length === 4), true);
// 2 x 4 x 4 = 32. The arithmetic is a tripwire at any N, not just 3.
ok("pair-checks scale as cases x N x N", wide.pairChecks, 32);
ok("the fourth implementation is addressable", wide.cells[0][3].to, "pathspec");

const wideLines = renderGridReport(wide, GIT_VOCAB);
ok("the row role reaches the header", wideLines[0].includes("reference row"), true);
ok("the col role reaches the header", wideLines[0].includes("implementation col"), true);
ok("the unit reaches the header", wideLines[0].includes("divergent patterns"), true);
ok("the axis label reaches the corner cell", wideLines[1].includes("ref\\impl"), true);
ok("the agree legend is the caller's", wideLines.some((l) => l.includes("all patterns agree")), true);
// NO TOON WORD MAY SURVIVE INTO A NON-TOON REPORT. This is the check that would
// have caught a renderer still concatenating its own vocabulary.
ok("no TOON vocabulary leaks into the 4-wide report",
  wideLines.some((l) => /encoder|decoder|enc\\dec|cases agree/.test(l)), false);

// -- one-sided with a DIFFERENT oracle name --
const oracleGrid = buildSpecGrid(
  [{ file: P1, from: "git", to: "node-ignore", expected: "", actual: "" }],
  ["ignore-rs", "node-ignore", "pathspec"],
  [P1, P2],
  GIT_ORACLE,
);
ok("the oracle lane accepts an oracle named git", oracleGrid.totalDivergences, 1);
ok("and marks the disagreeing implementation", oracleGrid.marks[P1]["node-ignore"], "value-mismatch");
ok("while the others still agree", oracleGrid.marks[P1]["pathspec"], "agree");
ok("one-sided checks are cases x implementations", oracleGrid.specChecks, 6);
{
  // The guard must reject the OLD oracle name once a new one is configured,
  // or it is still comparing against the module constant.
  let threw = "";
  try {
    buildSpecGrid([{ file: P1, from: "spec", to: "pathspec", expected: "", actual: "" }],
      ["pathspec"], [P1], GIT_ORACLE);
  } catch (e) { threw = (e as Error).message; }
  ok("a record from \"spec\" is refused when the oracle is git", threw.includes("admits only the oracle \"git\""), true);
}
const oracleLines = renderSpecGridReport(oracleGrid, GIT_ORACLE);
ok("the oracle title is the caller's", oracleLines[0].startsWith("ORACLE GRID"), true);
ok("the source note is the caller's", oracleLines[0].includes("git check-ignore -v"), true);
ok("the oracle legends are the caller's",
  oracleLines.some((l) => l.includes("matches git") && l.includes("differs from git")), true);
// M9: the corner cell of the one-sided grid. The pairwise axis label was
// checked and this one was not, so it could still say "case\\dec".
ok("the one-sided axis label is the caller's", oracleLines[1].includes("pattern\\impl"), true);
ok("no TOON vocabulary leaks into the oracle report",
  oracleLines.some((l) => /SPEC\.md|spec case|decodes as the spec|no encoder in the loop/.test(l)), false);
const emptyOracle = renderSpecGridReport(buildSpecGrid([], ["pathspec"], [], GIT_ORACLE), GIT_ORACLE);
ok("even the empty note is the caller's", emptyOracle.some((l) => l.includes("(no patterns)")), true);

// And the TOON defaults still apply when no vocabulary is passed — the
// generalization must not have quietly changed the live report.
ok("default vocabulary is still TOON's", renderGridReport(grid)[0].includes("encoder row"), true);
ok("default oracle vocabulary is still TOON's", renderSpecGridReport(sg)[0].startsWith("SPEC GRID"), true);

console.log();
if (fail === 0) {
  console.log(`GRID REPORT PROVEN: ${pass} checks pass. The real 7 divergences render as the 013 TS-asymmetry plus the 002 decoder column, with error-vs-mismatch marks and harness-bug tripwires intact; the spec lane renders one-sided at N checks and refuses a pairwise record, and a 4-wide non-TOON configuration with a git oracle renders with none of TOON's vocabulary.`);
} else {
  console.log(`GRID REPORT FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
