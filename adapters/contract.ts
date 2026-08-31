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
  | "i64u64" // exact in [-2^63, 2^64) and NOWHERE ELSE — no f64 fallback
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
      decoderPolicy: "approximate",
      encoderPolicy: null,
      claimsLossless: true,
      policyEvidence:
        "docs/reference/api.md documents the decoder policy in TWO places, from DIFFERENT sources. (1) decode() \"Return Value\": numeric tokens follow IEEE 754 double precision, with a direct link to spec §4 — this is PR #331's entire contribution, verified in the PR diff as a +2-line addition at api.md:343 (merge commit 52653ce). (2) DecodeOptions \"Documented decoder policies\": states the rule three ways — magnitude past the finite double range decodes as a string, underflow decodes as numeric 0, and a value that fits but is not exactly representable decodes as the nearest double. Block (2) is NOT from #331: it was added by acc1bed \"docs: sync guide, api reference, and playground with spec v4.1\" (johannschopplich), dated 2026-07-25 ~19:19 UTC — the SAME DAY as, and some hours after, our Jul 25 browser read that recorded DecodeOptions as silent on precision. That read is therefore true-when-written, not a miss; the same commit moves the docs' spec pin from 3.3 to 4.1. The THIRD clause of (2) governs 013 (2^53+1 is far inside the finite range), so \"approximate\" is the policy at OUR probed boundary. \"Round-Trip Compatibility\" is UNCHANGED and still promises lossless round-trips after normalization with no numeric caveat",
      verified: "2026-08-02",
      notes:
        "#329 closed as completed by PR #331 (\"docs: document decoder number precision\", merged 52653ce; commits 29041f5, 26a7755, ad83ebc; api.md only, no runtime change). DECODER-ONLY — encoderPolicy stays null: the Type Normalization table still has no row for a plain number past 2^53, so the §3 host-ingestion mapping is still undocumented and the encoder cell stays violates. The contradiction did not close, it SHARPENED — one file now documents silent rounding and promises lossless round-trips. MODEL LIMIT: OutOfRangePolicy is single-valued but the documented ts policy is three-way (quoted-lossless at overflow, approximate at underflow and at inexact-in-range); \"approximate\" records the clause governing our probe, not the whole policy",
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
      domain: "i64u64",
      domainEvidence:
        "MEASURED 2026-08-30, superseding a read of serde_json's model that was never checked against the implementation. A 14-value boundary ladder was decoded through the built bridge (crate toon-format 0.5.0, rustc 1.96.1): every plain integer token in [-2^63, 2^64) comes back an EXACT NUMBER, and every token outside it comes back a LOSSLESS QUOTED STRING — 2^64, 2^64+1, 2^65, 2^100, 2^100+1 and -2^63-1 all stringify, and -2^63 does not. " +
        "THERE IS NO f64 FALLBACK. The prior evidence line asserted that a value beyond u64 \"loses precision at serde_json::from_str\", symmetric to the TS adapter. THAT IS FALSE: nothing is lost, and the boundary is the i64/u64 window alone rather than its union with the exactly-representable doubles. 2^100 is an exact double and still stringifies, which is the row that settles it. " +
        "CONSEQUENCE FOR THE CAVEAT BELOW: the divergence on spec/001 is NOT a precision loss and therefore NOT an artifact of our arbitrary_precision-OFF choice — toon-format detects the out-of-range token and stringifies it before serde's number model applies. What remains reportable is documentation only. " +
        "LIMIT NOW CLOSED, 2026-08-30 (token-form ladder, same session). THE PATH IS CHOSEN BY THE TOKEN\u0027S FORM, NOT ITS VALUE. A plain integer token outside the window returns a lossless string; an EXPONENT token takes the f64 numeric path at every magnitude tested (1e3, 1e19, 1e21, 1e30, 1.2676506002282294e+30, 1e300), and the split is purely lexical \u2014 123456789012345678901e5 is integer-valued and still parsed as a float. So this domain tag describes rust\u0027s behaviour for PLAIN INTEGER TOKENS; for exponent tokens the effective domain is f64. " +
        "NEW DIVERGENCE FOUND BY THAT LADDER, NOT YET A CASE: on 1e400 \u2014 a token \u00a74\u0027s number grammar accepts, with no finite double \u2014 rust ERRORS (\"Invalid input: Invalid number\") while python returns the STRING \"1e400\". \u00a74 permits both rejection and returning a string IF documented, and neither documents anything, so this is a real rust/python fault line ABOVE the u64 one. Books to v0.5 under the scope rule; a natural spec/003",
      decoderPolicy: null,
      encoderPolicy: null,
      claimsLossless: false,
      policyEvidence:
        "toon-rust README: no precision / out-of-range / u64 / 2^53 statement anywhere; numeric handling is implicit via serde_json::Value, and the round-trip examples use small values with no prose losslessness claim",
      verified: "2026-07-25",
      notes:
        "CAVEAT LARGELY DISCHARGED 2026-08-30 by measurement. It read: the u64 boundary is OUR ADAPTER's arbitrary_precision-OFF choice, so a loss there is a harness-model fact. There is NO LOSS — rust returns the exact digits as a quoted string (see domainEvidence), which is \u00a74's \"return a string\" option and the LOSSLESS-FIRST behaviour \u00a74 RECOMMENDS. So the behaviour is upstream's, not the bridge's, and it is the recommended behaviour rather than a defect. " +
        "WHAT IS STILL REPORTABLE IS DOCUMENTATION ONLY: \u00a74 makes documenting the out-of-range policy a MUST and toon-rust documents none, so decoderPolicy stays null. A filing here should read \"your decoder already does the recommended thing; please say so in the docs\", NOT \"your decoder loses data\". Silent, not self-contradicting (unlike ts). " +
        "PR #71's scope is v3.3 empty-array/header edge cases and adds no numeric policy, so a #71 merge does not touch this record",
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
