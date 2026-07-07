// adapters/contract.ts
// One protocol every implementation speaks. Adding a language = one Adapter.
// encode/decode work on TEXT (json string <-> toon string) so the harness
// never has to hold a language's native value model.

export interface Adapter {
  name: string;
  // The TOON spec version this implementation CLAIMS to target, or null if it
  // makes no versioned claim (i.e. "targets current spec"). This is the
  // upstream project's claim, not our assessment. Used to ANNOTATE divergences
  // between adapters with mismatched non-null claims (possible version skew),
  // never to classify or excuse them.
  // Verified 2026-07-07 (browser recon):
  //   ts     "3.3"  — toon-format/toon SPEC.md + "align with spec v3.3" commits
  //   rust   "3.2"  — toon-rust README Specification section (v3.2, 2026-05-20)
  //   python null   — README claims only "working towards spec compliance",
  //                   no pinned version anywhere
  specVersion: string | null;
  encode(jsonText: string): Promise<string>; // JSON text -> TOON text
  decode(toonText: string): Promise<string>; // TOON text -> JSON text
}

// Single source of truth for the claims above, so spawn and persistent
// variants of the same implementation can never drift apart. Update HERE
// (and the verification note above) when an upstream claim changes.
export const SPEC_VERSION_CLAIMS = {
  ts: "3.3",
  python: null,
  rust: "3.2",
} as const satisfies Record<string, string | null>;
