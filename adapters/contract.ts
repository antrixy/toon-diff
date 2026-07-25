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
  /** Numeric domain + documented out-of-range policy (numeric-domain verdicts). */
  numeric: NumericClaim;
}

// ---------------------------------------------------------------------------
// Numeric domain and out-of-range policy
//
// SPEC.md splits numeric obligations by DOMAIN MEMBERSHIP, and the domain is
// per-implementation, so the same wire value lands in different regimes across
// the matrix:
//   §2 — round-trip fidelity is an ENCODER MUST, scoped to IN-DOMAIN values.
//        Out-of-domain, the encoder MAY emit a lossless quoted string (which
//        MUST be documented) or a lossy approximation.
//   §3 — the host-type -> JSON model mapping is implementation-defined and
//        MUST be documented. An impl's text->native ingestion (JSON.parse ->
//        f64, serde_json::from_str -> i64/u64/f64) IS that mapping, so an
//        undocumented rounding boundary is a §3 gap, not a §2 excuse.
//   §4 — a decoder MAY return an approximation for an out-of-range token IF
//        that is the DOCUMENTED policy; the out-of-range policy is a
//        MUST-document (lossless-first RECOMMENDED).
// So §4 does not excuse §2: for an out-of-domain value there is no §2
// round-trip MUST to violate, and both sides instead owe DOCUMENTATION —
// the encoder under §3+§2, the decoder under §4. Two independent obligations,
// which is why encoder and decoder policies are recorded separately below.
//
// The domain tag is the ADAPTER'S JSON-ingestion model (evidenced in-repo),
// not an upstream marketing claim: it is the same boundary on the way in and
// on the way out. Tag -> exact-integer range is probe-side classifier logic;
// this file records only the claims.
// ---------------------------------------------------------------------------

/** The set of values an implementation represents EXACTLY, as ingested. */
export type NumericDomainTag =
  | "f64" // IEEE-754 double: integers exact to +/-2^53
  | "i64u64f64" // serde_json, arbitrary_precision OFF: exact in [-2^63, 2^64)
  | "bignum"; // arbitrary-precision integers: no integer boundary

/**
 * A DOCUMENTED out-of-range behavior, or null when the implementation
 * documents none. null is a recorded, dated FINDING (docs searched, nothing
 * found) — never a placeholder for "not looked at yet".
 */
export type OutOfRangePolicy =
  | "approximate" // documented: returns a lossy host-native approximation
  | "quoted-lossless" // documented: preserves the value as a quoted string
  | "reject" // documented: errors rather than approximate
  | null; // undocumented

export interface NumericClaim {
  /** The implementation's exact-value domain, as its adapter ingests text. */
  domain: NumericDomainTag;
  /** Where the domain is evidenced — usually in-repo (adapter/notes). */
  domainEvidence: string;
  /** §4 decoder out-of-range policy, or null if undocumented. */
  decoderPolicy: OutOfRangePolicy;
  /** §3+§2 encoder out-of-domain / host-type mapping policy, or null. */
  encoderPolicy: OutOfRangePolicy;
  /**
   * Does the project AFFIRMATIVELY claim lossless round-trips in prose?
   * Distinguishes silence (null policy, no claim) from self-contradiction
   * (null policy while promising losslessness) — the latter is the stronger
   * finding, since the docs assert what the implementation does not do.
   */
  claimsLossless: boolean;
  /** Where the policy claim (or its documented absence) was read. */
  policyEvidence: string;
  /** Date the policy claim was last browser-verified (YYYY-MM-DD). */
  verified: string;
  /** Pending upstream changes, applicability caveats. */
  notes?: string;
}

export const IMPL_CLAIMS = {
  ts: {
    version: "3.3",
    evidence:
      "toon-format/toon SPEC.md tracks 3.3 + \"align with spec v3.3\" commits (package @toon-format/toon 2.3.0, lockfile-pinned)",
    verified: "2026-07-07",
    numeric: {
      domain: "f64",
      domainEvidence:
        "adapters/ts.ts ingests via JSON.parse -> JS number (f64); docs/reference/api.md Type Normalization documents BigInt-out-of-range -> quoted decimal string (example literally \"9007199254740993\") but has NO row for a plain number beyond 2^53",
      decoderPolicy: null,
      encoderPolicy: null,
      claimsLossless: true,
      policyEvidence:
        "docs/reference/api.md: decode section, DecodeOptions and the strict-mode list are all silent on out-of-range/precision; \"Round-Trip Compatibility\" affirmatively claims lossless round-trips after normalization, with no numeric-domain caveat",
      verified: "2026-07-25",
      notes:
        "the ONLY documented lossless path past 2^53 is via BigInt, which dodges f64 — it does not document the plain-number rounding. #329 (PR \"docs: document decoder number precision\", 29041f5, awaiting maintainer approval) edits this same api.md: on merge set decoderPolicy \"approximate\" + verified, citing the merge commit. DECODER-ONLY — encoderPolicy stays null, so the §3+§2 encoder gap survives the fix",
    },
  },
  python: {
    version: null,
    evidence:
      "toon-python README claims only \"working towards spec compliance\" — no pinned version anywhere",
    verified: "2026-07-07",
    notes:
      "identity is the git commit installed at env build (pip git+ HEAD); record it each rebuild — e475c82 on 2026-07-12",
    numeric: {
      domain: "bignum",
      domainEvidence:
        "adapters/adapter.py ingests via json.loads -> Python int (arbitrary precision) for integer tokens, and json.dumps renders them exact on the way out",
      decoderPolicy: null,
      encoderPolicy: null,
      claimsLossless: false,
      policyEvidence:
        "toon-python README: no precision / out-of-range / large-integer statement; its Type Normalization line covers only Decimal->float, Infinity/NaN->null, -0->0 (type coercion, not integer precision)",
      verified: "2026-07-25",
      notes:
        "null here is NOT-APPLICABLE rather than a documentation gap: an arbitrary-precision domain has no integer boundary to overflow. Silent, not self-contradicting. Moot for 2^53+1 (in-domain, conformant); matters only as the FAITHFUL side at the u64 boundary, where rust goes out-of-domain and python does not",
    },
  },
  rust: {
    version: "3.0",
    evidence:
      "toon-rust README: spec v3.0 badge + \"spec-compliant Rust implementation of TOON v3.0\" (crate toon-format v0.5.0, Cargo.lock-pinned)",
    verified: "2026-07-10",
    notes:
      "CORRECTION of earlier 3.2 recon (was wrong — see #76 filing session); fetch-corroborated 2026-07-12. PR #71 bumps README to v3.3: on merge, update version+verified here citing the merge commit",
    numeric: {
      domain: "i64u64f64",
      domainEvidence:
        "adapters/RUST-NOTES.md \"Two deliberate serde_json feature choices\": the bridge builds serde_json with arbitrary_precision OFF, so the model is i64/u64/f64 and a value beyond u64 loses precision at serde_json::from_str — deliberate, and symmetric to the TS adapter losing >2^53 at JSON.parse",
      decoderPolicy: null,
      encoderPolicy: null,
      claimsLossless: false,
      policyEvidence:
        "toon-rust README: no precision / out-of-range / u64 / 2^53 statement anywhere; numeric handling is implicit via serde_json::Value, and the round-trip examples use small values with no prose losslessness claim",
      verified: "2026-07-25",
      notes:
        "CAVEAT: the u64 boundary is OUR ADAPTER's arbitrary_precision-OFF choice, not an upstream policy — a loss there is a harness-model fact and must not be reported as an upstream violation. Silent, not self-contradicting (unlike ts). PR #71's scope is v3.3 empty-array/header edge cases and adds no numeric policy, so a #71 merge does not touch this record",
    },
  },
} as const satisfies Record<string, ImplClaim>;

// Derived legacy shape — adapters consume this. A selftest pins the
// derivation so the two can never disagree.
export const SPEC_VERSION_CLAIMS = {
  ts: IMPL_CLAIMS.ts.version,
  python: IMPL_CLAIMS.python.version,
  rust: IMPL_CLAIMS.rust.version,
} as const satisfies Record<string, string | null>;

// Derived domain map — the numeric-domain classifier consumes this. Same
// single-source discipline as SPEC_VERSION_CLAIMS, pinned by a selftest.
export const NUMERIC_DOMAINS = {
  ts: IMPL_CLAIMS.ts.numeric.domain,
  python: IMPL_CLAIMS.python.numeric.domain,
  rust: IMPL_CLAIMS.rust.numeric.domain,
} as const satisfies Record<string, NumericDomainTag>;
