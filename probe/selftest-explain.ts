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
import { NUMERIC_FACTS } from "./numeric-domain.ts";

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
ok("0 citation-pending (013 rule promoted)", report.citationPending, 0);

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
ok("013 ts->ts: judged by the numeric-domain kind", rTsTs.verdictKind, "numeric-domain");
ok("013 ts->ts: ts violates (self-pair, encoder obligation first)", rTsTs.verdicts[0].verdict, "violates");
ok("013 ts->ts: cited under §3 + §2 (host-type mapping)", rTsTs.verdicts[0].clause, "§3 + §2");
ok("013 governing probe is 2^53+1, read from the case text", rTsTs.governingProbe, "9007199254740993");
ok("013 citation is real (rule promoted)", rTsTs.citationPending, false);
ok("013 citation cites the [1.3] changelog", (rTsTs.citation ?? "").includes("[1.3] 2025-10-31"), true);
ok("013 refs carry toon#329 (filed 2026-07-16)", rTsTs.refs.some((r) => r.includes("issues/329")), true);

const ePyTs = report.explanations[5];
const rPyTs = ePyTs.rules[0];
ok("013 python->ts: both endpoints constrained", rPyTs.verdicts.length, 2);
// THE v0.4 POINT: python holds 2^53+1 exactly, so it is CONFORMANT rather
// than a co-defendant. Under the old version-only logic it read
// "violates-current" purely because the rule predates every claimed version.
ok("013 python->ts: python is conformant (bignum holds the value)", rPyTs.verdicts.find((v) => v.side === "python")!.verdict, "conformant");
ok("013 python->ts: ts satisfies its documented §4 policy (post-#331)", rPyTs.verdicts.find((v) => v.side === "ts")!.verdict, "documented-policy");
ok("013 python->ts: ts is cited under §4", rPyTs.verdicts.find((v) => v.side === "ts")!.clause, "§4");
// And the mirror: with TS encoding, the fault moves to the encoder side and
// rust becomes the faithful relay.
const rTsRust = report.explanations[4].rules[0];
ok("013 ts->rust: ts violates as ENCODER (§3 + §2)", rTsRust.verdicts.find((v) => v.side === "ts")!.clause, "§3 + §2");
ok("013 ts->rust: rust is conformant (faithful relay)", rTsRust.verdicts.find((v) => v.side === "rust")!.verdict, "conformant");

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

console.log("Part 4: the PRE-#331 world (numeric facts as a parameter)");
// #331 merged 2026-07-26 and documented the DECODER's out-of-range policy, so
// the post-merge verdicts are now the BASELINE above. What stays worth proving
// is that the engine can still express the world before it: parameterize the
// decoder policy back to null and ts-as-decoder returns to violating §4.
const pre331 = explain(MATRIX_2026_07_12, corpus, undefined, {
  ...NUMERIC_FACTS,
  ts: { ...NUMERIC_FACTS.ts, decoderPolicy: null },
});
const p331PyTs = pre331.explanations[5].rules[0];
ok("pre-#331: ts-as-decoder violated §4 (undocumented)", p331PyTs.verdicts.find((v) => v.side === "ts")!.verdict, "violates");
ok("pre-#331: python still conformant", p331PyTs.verdicts.find((v) => v.side === "python")!.verdict, "conformant");
const p331TsRust = pre331.explanations[4].rules[0];
ok("pre-#331: ts-as-ENCODER violates (§3 gap predates the fix)", p331TsRust.verdicts.find((v) => v.side === "ts")!.verdict, "violates");
// THE THESIS, as a single assertion: a decoder-only docs fix moved the decoder
// verdict and left the encoder verdict untouched. Both-or-neither could not
// have produced this pair.
ok(
  "the §3 encoder verdict is IDENTICAL before and after #331",
  p331TsRust.verdicts.find((v) => v.side === "ts")!.verdict === rTsRust.verdicts.find((v) => v.side === "ts")!.verdict,
  true,
);

console.log("Part 5: rendering");
const lines = renderExplainReport(report);
ok("summary line reads 7/7", lines[0].includes("7/7"), true);
ok("summary reports no citation-pending", lines[0].includes("citation-pending"), false);
ok("no PENDING lines render (all rules citable)", lines.some((l) => l.includes("PENDING")), false);
// The v0.3 note-line was an admission that fault could not be attributed.
// Numeric-domain rules attribute per side, so it must no longer render.
ok("unattributed-fault note is GONE (013 now attributes)", lines.some((l) => l.includes("fault not attributed")), false);
ok("per-side clause renders for 013", lines.some((l) => l.includes("[\u00a73 + \u00a72]")), true);
ok("decoder-side §4 clause renders for 013", lines.some((l) => l.includes("[\u00a74]")), true);
ok("a cite line renders for 002", lines.some((l) => l.startsWith("  cite: SPEC 4.1")), true);
ok("no unexplained section for a fully-covered report", lines.some((l) => l.includes("UNEXPLAINED")), false);

console.log("Part 6: the one-sided spec lane (v0.4)");
// A spec-derived divergence has ONE implementation side. The spec sits in the
// encoder position and carries no obligation — a spec cannot violate a spec —
// so only the decoder is judged, and it is judged on its OWN domain and its
// OWN documented policy rather than being excused as a faithful relay.
const SPEC_U64 = "spec/001-u64-boundary.json";
const SPEC_LEGACY = "spec/002-legacy-empty-array-root.json";
const specReport = explain(
  [
    { file: SPEC_U64, from: "spec", to: "rust", expected: `{"n":18446744073709551617}`, actual: `{"n":1.8446744073709552e19}` },
    { file: SPEC_U64, from: "spec", to: "ts", expected: `{"n":18446744073709551617}`, actual: `{"n":18446744073709551616}` },
    { file: SPEC_LEGACY, from: "spec", to: "python", expected: "[]", actual: "", error: "unexpected token" },
  ],
  corpus,
);
ok("all three spec divergences explained", specReport.explained, 3);

const specRust = specReport.explanations[0].rules[0];
ok("exactly ONE side is judged", specRust.verdicts.length, 1);
ok("and it is the decoder", specRust.verdicts[0].role, "decoder");
ok("the decoder is the implementation, not the spec", specRust.verdicts[0].side, "rust");
ok("no verdict is issued against the spec", specRust.verdicts.some((v) => v.side === "spec"), false);
// 2^64+1 governs: out of rust's i64/u64 window and not f64-exact.
ok("the governing probe is 2^64+1", specRust.governingProbe, "18446744073709551617");
// THE LOAD-BEARING CHECK. In the pairwise lane, an out-of-domain ENCODER
// excuses the decoder as a faithful relay. The spec is never out-of-domain, so
// that excuse is structurally unavailable here and rust is judged on its own
// undocumented out-of-range policy — which is the independence gain, stated as
// a verdict.
ok("rust VIOLATES §4 (no faithful-relay excuse against the spec)", specRust.verdicts[0].verdict, "violates");
ok("judged under §4", specRust.verdicts[0].clause, "\u00a74");

const specTs = specReport.explanations[1].rules[0];
// ts documents its decoder policy (post-#331), so the same wire yields a
// DIFFERENT verdict on the same clause — attribution, not a blanket red row.
ok("ts is documented-policy, not violates", specTs.verdicts[0].verdict, "documented-policy");
ok("ts is judged under §4 too", specTs.verdicts[0].clause, "\u00a74");

const specPy = specReport.explanations[2].rules[0];
ok("the legacy-root case judges only python", specPy.verdicts.length, 1);
ok("under a decoder rule it is still the decoder", specPy.verdicts[0].role, "decoder");
ok("python claims no version, so it is measured against current spec",
  specPy.verdicts[0].verdict, "violates-current");

// An encoder-only rule against a spec case constrains NOBODY. Rendering zero
// verdicts would report as coverage, so it must throw.
{
  const bad = {
    cases: [{ ...corpus.byBucket.spec[0], meta: { origin: "t", invariant: "t", specRules: ["non-ascii-key-quoting"] } }],
    byBucket: corpus.byBucket,
  } as typeof corpus;
  let threw = "";
  try {
    explain([{ file: SPEC_U64, from: "spec", to: "ts", expected: "", actual: "" }], bad);
  } catch (e) { threw = (e as Error).message; }
  ok("encoder-only rule on a spec case throws", threw.includes("no encoder side to judge"), true);
}
{
  let threw = "";
  try {
    explain([{ file: SPEC_U64, from: "ts", to: "spec", expected: "", actual: "" }], corpus);
  } catch (e) { threw = (e as Error).message; }
  ok("\"spec\" as a DECODER throws", threw.includes("cannot be a decoder"), true);
}

const specLines = renderExplainReport(specReport);
ok("spec divergences render with the spec as encoder",
  specLines.some((l) => l.startsWith("spec \u2192 rust")), true);
ok("the unattributed-fault note does not render on the spec lane",
  specLines.some((l) => l.includes("fault not attributed")), false);

console.log();
if (fail === 0) {
  console.log(`EXPLAIN ENGINE PROVEN: ${pass} checks pass. Today's 7 divergences are explained with citations, fenced stubs, side-scoped verdicts, a parameterized post-#71 future, a parameterized pre-#331 past, and a one-sided spec lane where the decoder gets no faithful-relay excuse.`);
} else {
  console.log(`EXPLAIN ENGINE FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
