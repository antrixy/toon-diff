/**
 * probe/selftest-explain.ts — proves the explained-failures engine.
 *
 * Fixtures are TODAY'S REAL MATRIX (2026-07-12, tree 26bad6a): the exact 7
 * divergences cli-v2 printed on a verified environment. Corpus, registry, and
 * claims are the real ones — only the divergence records are pinned, so this
 * test proves the engine's answer for the state of the world it will actually
 * be asked about, including:
 *   - 002 rust: BEHIND (claims 3.0 < rule's 3.1) with full clause citation
 *   - 002 python: VIOLATES CURRENT (claims nothing)
 *   - 002 ts: NO verdict — decoder rule never indicts the encoder
 *   - 013 x5: round-trip verdicts on both endpoints, citation PENDING (stub)
 *   - a post-#71 world via the claims parameter: rust at 3.3 flips to
 *     violates-claimed with no code change
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types probe/selftest-explain.ts
 */

import { loadCorpus } from "./corpus.ts";
import { explain, renderExplainReport, type DivergenceRecord } from "./explain.ts";

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

const corpus = loadCorpus();

console.log("Part 1: the real 7, real claims");
const report = explain(MATRIX_2026_07_12, corpus);
ok("7 divergences in", report.total, 7);
ok("7 explained (both cases carry rules)", report.explained, 7);
ok("no unexplained", report.unexplained.length, 0);
ok("5 citation-pending (all 013s, stub rule)", report.citationPending, 5);

const eRust = report.explanations[1];
ok("002 ts->rust kind is error", eRust.kind, "error");
ok("002 ts->rust detail carries the parser message", eRust.detail.includes("RightBracket"), true);
const rRust = eRust.rules[0];
ok("002 rule linked", rRust.ruleId, "empty-array-canonical-literal");
ok("002 citation cites §9.1", (rRust.citation ?? "").includes("\u00a79.1"), true);
ok("002 citation cites the changelog", (rRust.citation ?? "").includes("[3.1] 2026-05-18"), true);
ok("002 rust: exactly one constrained side", rRust.verdicts.length, 1);
ok("002 rust: decoder role", rRust.verdicts[0].role, "decoder");
ok("002 rust: verdict is BEHIND", rRust.verdicts[0].verdict, "behind");
ok("002 rust: text says not violating", rRust.verdicts[0].text.includes("not violating"), true);

const ePy = report.explanations[0];
const rPy = ePy.rules[0];
ok("002 ts->python kind is value-mismatch", ePy.kind, "value-mismatch");
ok("002 python: verdict is VIOLATES-CURRENT", rPy.verdicts[0].verdict, "violates-current");
ok("002 python: the encoder (ts) is never indicted", rPy.verdicts.every((v) => v.side !== "ts"), true);

const eTsTs = report.explanations[2];
const rTsTs = eTsTs.rules[0];
ok("013 ts->ts: one side, role both", rTsTs.verdicts.length === 1 && rTsTs.verdicts[0].role === "both", true);
ok("013 ts->ts: ts violates its claimed 3.3", rTsTs.verdicts[0].verdict, "violates-claimed");
ok("013 citation is pending", rTsTs.citationPending, true);
ok("013 citation is null", rTsTs.citation, null);
ok("013 carries no upstream refs (none filed yet; old toon#322 ref was a recon error)", rTsTs.refs.length, 0);

const ePyTs = report.explanations[5];
const rPyTs = ePyTs.rules[0];
ok("013 python->ts: both endpoints constrained", rPyTs.verdicts.length, 2);
ok("013 python->ts: python violates-current", rPyTs.verdicts.find((v) => v.side === "python")!.verdict, "violates-current");
ok("013 python->ts: ts violates-claimed", rPyTs.verdicts.find((v) => v.side === "ts")!.verdict, "violates-claimed");

console.log("Part 2: coverage gaps and harness bugs");
const unexplainedReport = explain(
  [{ file: "seeds/001-empty-object.json", from: "ts", to: "ts", expected: "{}", actual: "{ }" }],
  corpus,
);
ok("case without specRules is unexplained", unexplainedReport.explained, 0);
ok("unexplained labels name file and pair", unexplainedReport.unexplained[0], "seeds/001-empty-object.json (ts -> ts)");

{
  let threw = "";
  try {
    explain([{ file: "seeds/999-nope.json", from: "ts", to: "ts", expected: "", actual: "" }], corpus);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("unknown case key throws", threw.includes("unknown case"), true);
}
{
  let threw = "";
  try {
    explain([{ file: K002, from: "ts", to: "go", expected: "", actual: "" }], corpus);
  } catch (e) {
    threw = (e as Error).message;
  }
  ok("unknown adapter throws and names it", threw.includes(`"go"`), true);
}

console.log("Part 3: the post-#71 world (claims as a parameter)");
const post71 = explain(MATRIX_2026_07_12, corpus, { ts: "3.3", python: null, rust: "3.3" });
const post71Rust = post71.explanations[1].rules[0].verdicts[0];
ok("rust at 3.3 flips to violates-claimed", post71Rust.verdict, "violates-claimed");
ok("python verdict unchanged", post71.explanations[0].rules[0].verdicts[0].verdict, "violates-current");

console.log("Part 4: rendering");
const lines = renderExplainReport(report);
ok("summary line reads 7/7", lines[0].includes("7/7"), true);
ok("summary flags citation-pending count", lines[0].includes("5 citation-pending"), true);
ok("a PENDING line renders for the stub", lines.some((l) => l.includes("PENDING")), true);
ok("a cite line renders for 002", lines.some((l) => l.startsWith("  cite: SPEC 3.3")), true);
ok("no unexplained section for a fully-covered report", lines.some((l) => l.includes("UNEXPLAINED")), false);

console.log();
if (fail === 0) {
  console.log(`EXPLAIN ENGINE PROVEN: ${pass} checks pass. Today's 7 divergences are explained with citations, fenced stubs, side-scoped verdicts, and a parameterized post-#71 future.`);
} else {
  console.log(`EXPLAIN ENGINE FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
