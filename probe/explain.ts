/**
 * probe/explain.ts — explained failures (v0.3).
 *
 * Takes the matrix's divergence records and answers, per divergence:
 *   WHAT diverged   — value mismatch vs error, with the evidence inline
 *   WHICH rule      — via the case sidecar's specRules -> the registry
 *   WHICH clauses   — SPEC sections + CHANGELOG citation, but ONLY for
 *                     citable rules; stubs render as citation-pending
 *   WHOSE claim     — a spec-version verdict PER CONSTRAINED SIDE:
 *                     "decoder" rules never indict the encoder, "round-trip"
 *                     rules indict both endpoints without attributing which.
 *
 * The verdict logic is the 002 lesson (see spec-rules.ts): an impl claiming a
 * version OLDER than the rule is BEHIND it, not violating it; claiming a
 * version that includes the rule violates its own claim; claiming nothing is
 * measured against the current spec.
 *
 * Pure and side-effect free. Claims default to the adapters' single source
 * (SPEC_VERSION_CLAIMS) but are a parameter, so a post-#71 world is testable
 * today and the harness never hardcodes a second copy.
 */

import type { Corpus } from "./corpus.ts";
import {
  specRulesById,
  specVerdict,
  verdictText,
  isCitable,
  SPEC_CURRENT,
  type SpecRule,
  type SpecVerdict,
} from "./spec-rules.ts";
import { SPEC_VERSION_CLAIMS } from "../adapters/contract.ts";

/** Structurally identical to cli-v2's Mismatch. */
export interface DivergenceRecord {
  file: string; // corpus key, e.g. "seeds/002-empty-array.json"
  from: string; // encoder adapter name
  to: string; // decoder adapter name
  expected: string;
  actual: string;
  error?: string;
}

export interface SideVerdict {
  side: string; // adapter name
  role: "encoder" | "decoder" | "both"; // role in THIS pair
  claimedVersion: string | null;
  verdict: SpecVerdict;
  text: string;
}

export interface RuleExplanation {
  ruleId: string;
  title: string;
  /** e.g. `SPEC 3.3 §4, §5, §9.1, §13.2; introduced [3.1] 2026-05-18` — null for stubs. */
  citation: string | null;
  citationPending: boolean;
  refs: string[];
  verdicts: SideVerdict[]; // constrained sides only
}

export interface Explanation {
  file: string;
  pair: { from: string; to: string };
  kind: "error" | "value-mismatch";
  detail: string;
  rules: RuleExplanation[];
  explained: boolean; // at least one rule linked
}

export interface ExplainReport {
  explanations: Explanation[];
  total: number;
  explained: number;
  citationPending: number;
  unexplained: string[]; // "file (from -> to)" labels for coverage gaps
}

export type Claims = Record<string, string | null>;

function citationOf(rule: SpecRule): string | null {
  if (!isCitable(rule)) return null;
  const sections = rule.sections.map((s) => `\u00a7${s}`).join(", ");
  const intro = rule.changelog ? `; introduced ${rule.changelog}` : "";
  return `SPEC ${SPEC_CURRENT} ${sections}${intro}`;
}

function constrainedSides(
  rule: SpecRule,
  from: string,
  to: string,
): { side: string; role: SideVerdict["role"] }[] {
  switch (rule.appliesTo) {
    case "encoder":
      return [{ side: from, role: "encoder" }];
    case "decoder":
      return [{ side: to, role: "decoder" }];
    case "round-trip":
      return from === to
        ? [{ side: from, role: "both" }]
        : [
            { side: from, role: "encoder" },
            { side: to, role: "decoder" },
          ];
  }
}

/** Explain a set of divergences against a loaded corpus. Throws on harness bugs
 *  (unknown case key, unknown adapter name) — those are OUR mistakes, not data. */
export function explain(
  records: DivergenceRecord[],
  corpus: Corpus,
  claims: Claims = SPEC_VERSION_CLAIMS,
): ExplainReport {
  const rules = specRulesById(); // validated, all-or-nothing
  const byKey = new Map(corpus.cases.map((c) => [c.key, c]));

  const explanations: Explanation[] = records.map((r) => {
    const c = byKey.get(r.file);
    if (!c) throw new Error(`explain: divergence names unknown case "${r.file}" — harness bug`);
    for (const side of [r.from, r.to]) {
      if (!(side in claims)) {
        throw new Error(`explain: divergence names unknown adapter "${side}" — harness bug`);
      }
    }

    const ruleExplanations: RuleExplanation[] = (c.meta.specRules ?? []).map((rid) => {
      const rule = rules.get(rid);
      if (!rule) throw new Error(`explain: case ${c.key} references unknown rule "${rid}" — harness bug`);
      const verdicts: SideVerdict[] = constrainedSides(rule, r.from, r.to).map(({ side, role }) => {
        const claimed = claims[side];
        const v = specVerdict(claimed, rule);
        return { side, role, claimedVersion: claimed, verdict: v, text: verdictText(v, claimed) };
      });
      return {
        ruleId: rule.id,
        title: rule.title,
        citation: citationOf(rule),
        citationPending: !isCitable(rule),
        refs: rule.refs ?? [],
        verdicts,
      };
    });

    return {
      file: r.file,
      pair: { from: r.from, to: r.to },
      kind: r.error !== undefined ? "error" : "value-mismatch",
      detail:
        r.error !== undefined
          ? r.error
          : `expected ${r.expected}  actual ${r.actual}`,
      rules: ruleExplanations,
      explained: ruleExplanations.length > 0,
    };
  });

  const unexplained = explanations
    .filter((e) => !e.explained)
    .map((e) => `${e.file} (${e.pair.from} -> ${e.pair.to})`);

  return {
    explanations,
    total: explanations.length,
    explained: explanations.length - unexplained.length,
    citationPending: explanations.filter((e) => e.rules.some((x) => x.citationPending)).length,
    unexplained,
  };
}

/** CLI rendering — one block per divergence, coverage summary first. */
export function renderExplainReport(report: ExplainReport): string[] {
  const lines: string[] = [];
  lines.push(
    `EXPLAINED: ${report.explained}/${report.total}` +
      (report.citationPending ? ` (${report.citationPending} citation-pending)` : ""),
  );
  if (report.unexplained.length) {
    lines.push(`UNEXPLAINED (link a specRules id in the sidecar):`);
    for (const u of report.unexplained) lines.push(`  ${u}`);
  }
  lines.push("");
  for (const e of report.explanations) {
    lines.push(`${e.pair.from} \u2192 ${e.pair.to}   ${e.file}   [${e.kind}]`);
    for (const r of e.rules) {
      lines.push(`  rule: ${r.ruleId}`);
      lines.push(
        r.citation !== null
          ? `  cite: ${r.citation}`
          : `  cite: PENDING — sections not yet browser-verified (refs: ${r.refs.join(", ") || "none"})`,
      );
      for (const v of r.verdicts) {
        lines.push(`  ${v.role} ${v.side}: ${v.text}`);
      }
    }
    if (!e.explained) lines.push(`  (no rule linked)`);
    lines.push("");
  }
  return lines;
}
