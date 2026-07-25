/**
 * probe/explain.ts — explained failures (v0.3).
 *
 * Takes the matrix's divergence records and answers, per divergence:
 *   WHAT diverged   — value mismatch vs error, with the evidence inline
 *   WHICH rule      — via the case sidecar's specRules -> the registry
 *   WHICH clauses   — SPEC sections + CHANGELOG citation, but ONLY for
 *                     citable rules; stubs render as citation-pending
 *   WHOSE claim     — a verdict PER CONSTRAINED SIDE. "decoder" rules never
 *                     indict the encoder. Round-trip rules name both
 *                     endpoints; whether fault is ATTRIBUTED depends on the
 *                     rule's verdictKind.
 *
 * Two verdict kinds:
 *   "version"        — the 002 lesson (see spec-rules.ts): an impl claiming a
 *                      version OLDER than the rule is BEHIND it, not violating
 *                      it; claiming a version that includes the rule violates
 *                      its own claim; claiming nothing is measured against the
 *                      current spec.
 *   "numeric-domain" — the 013 lesson (see numeric-domain.ts): §2's round-trip
 *                      MUST binds only IN-DOMAIN, so each side is judged
 *                      against its own numeric domain and documented policy.
 *                      Fault is attributed, and a provably faithful endpoint
 *                      renders conformant instead of "violates".
 *
 * Pure and side-effect free. Claims default to the adapters' single source
 * (SPEC_VERSION_CLAIMS) and numeric facts to IMPL_CLAIMS, but both are
 * parameters, so post-#71 and post-#329 worlds are testable today and the
 * harness never hardcodes a second copy.
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
import {
  NUMERIC_FACTS,
  encoderVerdict,
  decoderVerdict,
  bothVerdict,
  governingProbe,
  type NumericFacts,
  type NumericVerdict,
} from "./numeric-domain.ts";

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
  /** Which verdict logic produced this — see SpecRule.verdictKind. */
  kind: "version" | "numeric-domain";
  claimedVersion: string | null;
  verdict: SpecVerdict | NumericVerdict;
  text: string;
  /** Clause this side is judged under (numeric-domain rules only). */
  clause?: string;
}

export interface RuleExplanation {
  ruleId: string;
  title: string;
  /** e.g. `SPEC 3.3 §4, §5, §9.1, §13.2; introduced [3.1] 2026-05-18` — null for stubs. */
  citation: string | null;
  citationPending: boolean;
  appliesTo: "encoder" | "decoder" | "round-trip";
  verdictKind: "version" | "numeric-domain";
  /**
   * For numeric-domain rules: the case value the verdicts are judged on, or
   * null when the case holds no value outside either side's domain — i.e. the
   * numeric model does NOT explain this divergence and says so.
   */
  governingProbe: string | null;
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
  facts: NumericFacts = NUMERIC_FACTS,
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
      const kind = rule.verdictKind ?? "version";
      const sides = constrainedSides(rule, r.from, r.to);

      let verdicts: SideVerdict[];
      let probe: string | null = null;

      if (kind === "numeric-domain") {
        for (const side of [r.from, r.to]) {
          if (!(side in facts)) {
            throw new Error(
              `explain: numeric-domain rule "${rid}" but no numeric facts for adapter "${side}" — harness bug`,
            );
          }
        }
        const e = facts[r.from];
        const d = facts[r.to];
        probe = governingProbe(c.text, e, d);
        verdicts = sides.map(({ side, role }) => {
          const claimed = claims[side];
          if (probe === null) {
            // No value in this case lies outside either domain, so the model
            // has nothing to attribute. Say so rather than render conformance.
            return {
              side,
              role,
              kind,
              claimedVersion: claimed,
              verdict: "conformant" as NumericVerdict,
              text: "no out-of-domain value in this case — numeric-domain model does not explain this divergence",
            };
          }
          const res =
            role === "decoder"
              ? decoderVerdict(probe, e, d)
              : role === "both"
                ? bothVerdict(probe, e)
                : encoderVerdict(probe, e);
          return {
            side,
            role,
            kind,
            claimedVersion: claimed,
            verdict: res.verdict,
            text: res.text,
            clause: res.clause,
          };
        });
      } else {
        verdicts = sides.map(({ side, role }) => {
          const claimed = claims[side];
          const v = specVerdict(claimed, rule);
          return { side, role, kind, claimedVersion: claimed, verdict: v, text: verdictText(v, claimed) };
        });
      }

      return {
        ruleId: rule.id,
        title: rule.title,
        citation: citationOf(rule),
        citationPending: !isCitable(rule),
        appliesTo: rule.appliesTo,
        verdictKind: kind,
        governingProbe: probe,
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
        lines.push(
          `  ${v.role} ${v.side}: ${v.text}` +
            (v.clause !== undefined ? `  [${v.clause}]` : ""),
        );
      }
      if (r.verdictKind === "numeric-domain" && r.governingProbe === null) {
        lines.push(
          "  note: numeric-domain rule linked, but this case holds no out-of-domain value \u2014 the model does not explain this divergence",
        );
      }
      // The unattributed-fault note applies only to rules whose verdicts
      // genuinely cannot name a faulting side. Numeric-domain rules attribute
      // per side, so it would now be false.
      if (
        r.appliesTo === "round-trip" &&
        r.verdictKind !== "numeric-domain" &&
        r.verdicts.length
      ) {
        lines.push("  note: round-trip rule \u2014 both endpoints named, fault not attributed");
      }
    }
    if (!e.explained) lines.push(`  (no rule linked)`);
    lines.push("");
  }
  return lines;
}
