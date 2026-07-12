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
  // never to classify or excuse them. Values, evidence, and verification
  // dates live in IMPL_CLAIMS below — the single source of truth.
  specVersion: string | null;
  encode(jsonText: string): Promise<string>; // JSON text -> TOON text
  decode(toonText: string): Promise<string>; // TOON text -> JSON text
}

// Single source of truth for upstream spec-version claims, so spawn and
// persistent variants of the same implementation can never drift apart, and
// so every claim carries ITS EVIDENCE and verification date. Claims are the
// upstream project's own statements, verified in a BROWSER (fetches of
// GitHub/spec content have been observed stale) — update version, evidence,
// and verified together, never version alone.
export interface ImplClaim {
  /** The upstream project's claimed spec version, or null if it claims none. */
  version: string | null;
  /** Where the claim is made — README badge, SPEC.md, docs section. */
  evidence: string;
  /** Date the claim was last browser-verified (YYYY-MM-DD). */
  verified: string;
  /** Pending changes, identity caveats. */
  notes?: string;
}

export const IMPL_CLAIMS = {
  ts: {
    version: "3.3",
    evidence:
      "toon-format/toon SPEC.md tracks 3.3 + \"align with spec v3.3\" commits (package @toon-format/toon 2.3.0, lockfile-pinned)",
    verified: "2026-07-07",
  },
  python: {
    version: null,
    evidence:
      "toon-python README claims only \"working towards spec compliance\" — no pinned version anywhere",
    verified: "2026-07-07",
    notes:
      "identity is the git commit installed at env build (pip git+ HEAD); record it each rebuild — e475c82 on 2026-07-12",
  },
  rust: {
    version: "3.0",
    evidence:
      "toon-rust README: spec v3.0 badge + \"spec-compliant Rust implementation of TOON v3.0\" (crate toon-format v0.5.0, Cargo.lock-pinned)",
    verified: "2026-07-10",
    notes:
      "CORRECTION of earlier 3.2 recon (was wrong — see #76 filing session); fetch-corroborated 2026-07-12. PR #71 bumps README to v3.3: on merge, update version+verified here citing the merge commit",
  },
} as const satisfies Record<string, ImplClaim>;

// Derived legacy shape — adapters consume this. A selftest pins the
// derivation so the two can never disagree.
export const SPEC_VERSION_CLAIMS = {
  ts: IMPL_CLAIMS.ts.version,
  python: IMPL_CLAIMS.python.version,
  rust: IMPL_CLAIMS.rust.version,
} as const satisfies Record<string, string | null>;
