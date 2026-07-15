/**
 * probe/spec-rules.ts — the spec-rule registry (v0.3, "explained failures").
 *
 * WHY THIS EXISTS
 * ---------------
 * The 002 episode: TS emitted canonical "[]" (spec >=3.1), python decoded it
 * as the STRING "[]", rust refused to parse it. Three behaviors, but NOT three
 * equal violations — rust's README claimed spec v3.0, which predates the []
 * literal. An implementation claiming a version BEFORE a rule existed is
 * BEHIND that rule, not violating it. An implementation claiming a version
 * AT/AFTER the rule violates its own claim. An implementation claiming
 * nothing is measured against the current spec.
 *
 * Explanations therefore need, per rule: WHICH spec sections govern it and
 * WHEN it entered the spec (the CHANGELOG entry is citable structure, exactly
 * like a section number). That data lives HERE, once per rule — sidecars
 * reference rules by id instead of restating clause lists.
 *
 * Registry discipline mirrors the corpus loader: strict validation, every
 * problem listed, all-or-nothing — an ambiguous registry is refused whole.
 *
 * A rule with an EMPTY sections list is a stub: tracked, but not yet citable.
 * Stubs are legal in the registry (they carry refs and identity) but
 * explain-layer code MUST refuse to cite them until sections are filled in
 * from the live spec text. Browser verification is authoritative for spec
 * text; section numbers are never guessed.
 */

export const SPEC_CURRENT = "3.3"; // bump deliberately, with a ref, when the live spec moves

export interface SpecRule {
  /** Kebab-case id, referenced from case sidecars (e.g. "empty-array-canonical-literal"). */
  id: string;
  /** One line: what the rule requires. */
  title: string;
  /** Governing SPEC.md section numbers (e.g. ["4", "9.1"]). Empty = stub, not citable. */
  sections: string[];
  /** Spec version that introduced the rule, or null if present since first tracked spec. */
  introducedIn: string | null;
  /** CHANGELOG entry citation (required when introducedIn is set), e.g. "[3.1] 2026-05-18". */
  changelog: string | null;
  /**
   * Which side of a pair-check the rule constrains. Verdicts are computed
   * ONLY for constrained sides: "decoder" rules never indict the encoder,
   * and "round-trip" rules indict both endpoints without attributing which.
   */
  appliesTo: "encoder" | "decoder" | "round-trip";
  /** Optional: upstream issues, spec URLs, evidence. */
  refs?: string[];
  /** Optional: caveats, TODOs, verification notes. */
  notes?: string;
}

export const SPEC_RULES: SpecRule[] = [
  {
    id: "empty-array-canonical-literal",
    title:
      "canonical root-form and field-position [] must be accepted by every decoder; legacy [0]:/key[0]: forms remain MUST-accept",
    sections: ["4", "5", "9.1", "13.2"],
    introducedIn: "3.1",
    changelog: "[3.1] 2026-05-18",
    appliesTo: "decoder",
    refs: [
      "https://github.com/toon-format/spec/blob/main/SPEC.md",
      "https://github.com/toon-format/toon/issues/322",
      "https://github.com/toon-format/toon-python/issues/61",
      "https://github.com/toon-format/toon-rust/issues/76",
    ],
    notes:
      "verified against live SPEC.md v3.3 in browser (Jul 2026 session); fetched copies of the spec have been observed stale — reverify in browser before editing sections. Upstream encoder issue toon#322 closed Jul 2026 as resolved-by-spec (AI triage: v3.3 §9.1 blesses [] as SHOULD, decoders MUST accept both — verify §9.1 language in browser); python decoder fix still tracked at toon-python#61",
  },
  {
    id: "integer-precision-lossless",
    title:
      "integer lexemes outside f64-exact range (e.g. 2^53+1) must round-trip without precision loss",
    sections: [], // STUB: governing sections not yet verified against live SPEC.md — do not cite
    introducedIn: null,
    changelog: null,
    appliesTo: "round-trip",
    notes:
      "TODO(verify-in-browser): fill sections from live SPEC.md before this rule may be cited in explanations; divergence evidence lives in seeds/013. NO upstream issue filed yet (browser-verified 2026-07-15 via author-issues search); the earlier toon#322 ref here was a recon error — #322 is the empty-array issue. Candidate for upstream filing once stub promotion supplies spec citations",
  },
];

const RULE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SPEC_VERSION_RE = /^\d+\.\d+$/;

/** Strictly parse "MAJOR.MINOR" (the spec's version shape). Returns null if malformed. */
export function parseSpecVersion(v: string): [number, number] | null {
  if (!SPEC_VERSION_RE.test(v)) return null;
  const [maj, min] = v.split(".");
  return [Number(maj), Number(min)];
}

/** -1 / 0 / 1 for a<b / a==b / a>b. Throws on malformed input — callers validate first. */
export function compareSpecVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSpecVersion(a);
  const pb = parseSpecVersion(b);
  if (!pa || !pb) throw new Error(`malformed spec version: "${!pa ? a : b}"`);
  if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
  if (pa[1] !== pb[1]) return pa[1] < pb[1] ? -1 : 1;
  return 0;
}

/**
 * The 002 lesson as a total function.
 *   behind            — impl claims a version OLDER than the rule: not a violation,
 *                       the impl is behind the spec.
 *   violates-claimed  — impl claims a version that INCLUDES the rule and breaks it.
 *   violates-current  — impl claims nothing; the current spec is the bar.
 */
export type SpecVerdict = "behind" | "violates-claimed" | "violates-current";

export function specVerdict(
  claimedVersion: string | null,
  rule: SpecRule,
  current: string = SPEC_CURRENT,
): SpecVerdict {
  if (claimedVersion === null) return "violates-current";
  if (rule.introducedIn === null) return "violates-claimed"; // rule predates all tracked versions
  return compareSpecVersions(claimedVersion, rule.introducedIn) < 0
    ? "behind"
    : "violates-claimed";
}

/** One line of prose per verdict, for explanation rendering. */
export function verdictText(v: SpecVerdict, claimedVersion: string | null): string {
  switch (v) {
    case "behind":
      return `behind the rule, not violating it (claims spec ${claimedVersion}, which predates the rule)`;
    case "violates-claimed":
      return `violates its claimed spec ${claimedVersion}`;
    case "violates-current":
      return `violates current spec ${SPEC_CURRENT} (implementation claims no spec version)`;
  }
}

/** Validate a registry. Returns every problem found (empty = valid). */
export function validateSpecRules(rules: SpecRule[] = SPEC_RULES): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>(); // id -> first index

  rules.forEach((r, i) => {
    const where = `rules[${i}] (${r.id || "<no id>"})`;
    if (!RULE_ID_RE.test(r.id)) {
      problems.push(`${where}: id must be kebab-case (got "${r.id}")`);
    }
    const first = seen.get(r.id);
    if (first !== undefined) {
      problems.push(`${where}: duplicate id (also rules[${first}])`);
    } else {
      seen.set(r.id, i);
    }
    if (!r.title.trim()) problems.push(`${where}: title must be non-empty`);
    if (r.sections.some((s) => !s.trim())) {
      problems.push(`${where}: sections must not contain empty entries`);
    }
    if (r.introducedIn !== null && !parseSpecVersion(r.introducedIn)) {
      problems.push(
        `${where}: introducedIn must be MAJOR.MINOR (got "${r.introducedIn}")`,
      );
    }
    if (r.introducedIn !== null && !r.changelog) {
      problems.push(
        `${where}: introducedIn is set, so the CHANGELOG entry must be cited`,
      );
    }
    if (r.introducedIn === null && r.changelog !== null) {
      problems.push(
        `${where}: changelog cited but introducedIn is null — cite both or neither`,
      );
    }
    if (!["encoder", "decoder", "round-trip"].includes(r.appliesTo)) {
      problems.push(
        `${where}: appliesTo must be "encoder", "decoder", or "round-trip" (got ${JSON.stringify(r.appliesTo)})`,
      );
    }
  });

  if (!parseSpecVersion(SPEC_CURRENT)) {
    problems.push(`SPEC_CURRENT must be MAJOR.MINOR (got "${SPEC_CURRENT}")`);
  }

  return problems;
}

/** A rule is citable in explanations only once its sections are verified. */
export function isCitable(rule: SpecRule): boolean {
  return rule.sections.length > 0;
}

/** All-or-nothing accessor: validated Map of id -> rule, or throws listing every problem. */
export function specRulesById(rules: SpecRule[] = SPEC_RULES): Map<string, SpecRule> {
  const problems = validateSpecRules(rules);
  if (problems.length > 0) {
    throw new Error(
      `spec-rule registry refused (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return new Map(rules.map((r) => [r.id, r]));
}
