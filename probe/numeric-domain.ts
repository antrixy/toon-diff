/**
 * probe/numeric-domain.ts — per-side verdicts for numeric-domain rules (v0.4).
 *
 * WHY THIS EXISTS
 * ---------------
 * The 013 episode. 2^53+1 round-trips exactly through rust and python and
 * rounds through TS, so the matrix reports divergences on every pair that
 * touches TS. Under the version-only verdict logic those divergences indict
 * BOTH endpoints — the round-trip rule names the encoder and the decoder and
 * attributes fault to neither. That renders rust and python, which are
 * provably faithful here, as "violates". The v0.3 mitigation was a note-line
 * admitting the fault was unattributed. This file removes the need for it.
 *
 * THE SPEC READING (browser-verified against SPEC.md v3.3)
 *   §2  round-trip fidelity is an ENCODER MUST, and it is SCOPED TO IN-DOMAIN
 *       values: "Encoders MUST emit sufficient precision so that
 *       decode(encode(x)) equals x", with numbers compared by MATHEMATICAL
 *       VALUE. For a value outside the implementation's documented numeric
 *       domain the encoder MAY instead emit a lossless quoted string (which
 *       MUST be documented) or a lossy approximation.
 *   §3  the host-type -> JSON model mapping is implementation-defined and MUST
 *       be documented. An implementation's text->native ingestion IS that
 *       mapping, so an undocumented rounding boundary is a §3 gap.
 *   §4  a decoder MAY return an approximation for an out-of-range token IF
 *       that is its DOCUMENTED policy; documenting the out-of-range policy is
 *       itself a MUST (lossless-first RECOMMENDED).
 *
 * So §4 does NOT excuse §2. For an out-of-domain value there is no §2
 * round-trip MUST left to violate — instead each side owes DOCUMENTATION,
 * the encoder under §3+§2 and the decoder under §4. Two independent
 * obligations, judged per side, which is the whole point of this module.
 *
 * DOMAIN MEMBERSHIP IS PER-IMPLEMENTATION, so the same wire value lands in
 * different regimes across the matrix. That is what makes attribution
 * possible at all: for 2^53+1 only the f64 side is out-of-domain, so only it
 * can owe anything.
 *
 * SCOPE: INTEGERS. The domains differ only on integers (f64 exact to 2^53,
 * serde_json exact to the i64/u64 range, python unbounded). Fractional values
 * like 0.1 are inexact in every one of these implementations, so they are not
 * a differential fault line and are deliberately not classified here.
 *
 * Pure and side-effect free. Facts default to the adapters' single source
 * (IMPL_CLAIMS) but are a PARAMETER, so a post-#329 world is testable today
 * exactly as the post-#71 world is testable through the claims parameter.
 */

import { ingest, isNum, canonical, type Node } from "../oracle/ingest.ts";
import {
  IMPL_CLAIMS,
  type NumericDomainTag,
  type OutOfRangePolicy,
} from "../adapters/contract.ts";

// ---------------------------------------------------------------------------
// Probes: the values a case actually contains
// ---------------------------------------------------------------------------

/**
 * Every integer a case contains, as an exact decimal string, in encounter
 * order without duplicates.
 *
 * Values are read from the CASE TEXT through the oracle's lossless ingest, so
 * the probe is the same lexeme the matrix round-trips — never a second copy in
 * a sidecar that could drift away from the case it describes, and never an f64.
 */
export function integerProbes(caseText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: Node): void => {
    if (isNum(n)) {
      // canonical() renders a number node as "#" + its exact canonical value.
      // The NUM symbol itself is module-private, so this is the supported read.
      const v = canonical(n).slice(1);
      if (INTEGER_RE.test(v) && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
      return;
    }
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (typeof n === "object" && n !== null) {
      for (const k of Object.keys(n)) walk((n as Record<string, Node>)[k]);
    }
  };
  walk(ingest(caseText));
  return out;
}

const INTEGER_RE = /^-?\d+$/;

// ---------------------------------------------------------------------------
// Domain membership
// ---------------------------------------------------------------------------

const TWO_53 = 2n ** 53n;
const TWO_63 = 2n ** 63n;
const TWO_64 = 2n ** 64n;
/** Beyond this an IEEE-754 double has no finite representation at all. */
const F64_MAX_MAGNITUDE = 2n ** 1024n;

/**
 * Is this integer EXACTLY representable as an IEEE-754 double?
 *
 * Not simply |v| <= 2^53. Above the safe range doubles still represent every
 * value whose odd part fits the 53-bit significand — 2^54 is exact, 2^54+1 is
 * not. Testing the odd part keeps 013's verdict right without mislabelling a
 * large power of two as out-of-domain later.
 */
export function isExactF64Integer(v: bigint): boolean {
  let m = v < 0n ? -v : v;
  if (m === 0n) return true;
  if (m >= F64_MAX_MAGNITUDE) return false;
  while (m % 2n === 0n) m /= 2n; // strip trailing zero bits
  return m < TWO_53;
}

/** Is this integer within the implementation's EXACT-value domain? */
export function inDomain(tag: NumericDomainTag, value: string): boolean {
  const v = BigInt(value);
  switch (tag) {
    case "bignum":
      return true;
    case "f64":
      return isExactF64Integer(v);
    case "i64u64":
      // MEASURED 2026-08-30 (see IMPL_CLAIMS.rust.numeric.domainEvidence), not
      // read off serde_json's model. This used to union the window with the
      // exactly-representable doubles, on the reasoning that serde_json falls
      // back to f64 past the integer range. IT DOES NOT: toon-format detects
      // the out-of-range token and returns the exact digits as a QUOTED STRING
      // before serde's number model applies. 2^100 is an exact double and
      // still stringifies, which is the row that settles it.
      return v >= -TWO_63 && v < TWO_64;
  }
}

/**
 * THE DOMAINS NO LONGER NEST, AND THAT IS A MEASURED FACT, NOT A MODEL CHOICE.
 *
 * This function used to assert f64 ⊆ i64u64f64 ⊆ bignum, and the decoder's
 * faithful-relay credit (below) rested on it: when an encoder is out-of-domain
 * it emits its own approximation, and we credited the decoder as a faithful
 * relay only because that approximation was GUARANTEED to land inside the
 * decoder's domain too.
 *
 * The 2026-08-30 boundary measurement removed the guarantee. With rust's f64
 * fallback gone, f64 and i64u64 are INCOMPARABLE, in both directions:
 *   - 2^100 is an exact double and is NOT in [-2^63, 2^64), so f64 ⊄ i64u64;
 *   - 2^63-1 is in the window and is NOT an exact double, so i64u64 ⊄ f64.
 * Only bignum still contains both.
 *
 * So this predicate now reports the truth rather than pinning an invariant,
 * and the relay credit is decided per value by relayLandsInDomain() instead of
 * by an assumption that no longer holds. Keeping the old assertion would have
 * been the worst option: a check that passes because nothing tests it.
 */
export function domainsNest(value: string): boolean {
  const f = inDomain("f64", value);
  const i = inDomain("i64u64", value);
  const b = inDomain("bignum", value);
  return (!f || i) && (!i || b);
}

/**
 * The exact integer value of the nearest IEEE-754 double, or null when the
 * value has no finite double. BigInt(Number(x)) is exact for integer-valued
 * doubles, so this is the encoder's emitted approximation, not an estimate.
 */
export function f64Approximation(value: string): bigint | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return BigInt(n);
}

/**
 * SPEC §2 lets an encoder emit exponent notation for |n| >= 1e21 (canonical
 * decimal is REQUIRED only for n = 0 and 1e-6 <= |n| < 1e21), and the TS
 * encoder measurably takes that option at exactly this threshold:
 *
 *   2^65    -> n: 36893488147419103000        (plain decimal)
 *   2^100   -> n: 1.2676506002282294e+30      (exponent)
 *
 * This constant is therefore the TOKEN FORM boundary on the wire, and it
 * matters because the form — not the value — decides which path a decoder
 * takes. Measured 2026-08-30; see the form ladder in
 * IMPL_CLAIMS.rust.numeric.domainEvidence.
 */
const EXPONENT_FORM_THRESHOLD = 10n ** 21n;

/**
 * Is the decoder's faithful-relay credit SOUND at this value?
 *
 * The credit says: the encoder was already out-of-domain, so the wire carries
 * ITS lossy output and this side merely decoded what it received. That is only
 * fair if what the encoder emitted is something the decoder can hold.
 *
 * THE DOMAIN ALONE DOES NOT ANSWER THIS, and getting that wrong is the defect
 * this function was rewritten twice for. A decoder's numeric behaviour is a
 * property of (implementation, TOKEN FORM), not of the implementation alone:
 * rust returns a plain integer outside its window as a lossless STRING, but
 * parses the same magnitude in exponent form as an f64 NUMBER. The split is
 * lexical, with no magnitude threshold of its own — `123456789012345678901e5`
 * is integer-valued and still takes the numeric path. So this function asks
 * what the encoder actually PUTS ON THE WIRE, then what that form does.
 *
 *   f64 encoder    — emits the nearest double, in exponent form at or above
 *                    1e21 and plain decimal below it (both measured). Every
 *                    decoder measured parses an exponent token numerically, so
 *                    the relay holds there; below the threshold the plain
 *                    token has to land in the decoder's window.
 *   i64u64 encoder — emits the exact digits as a lossless quoted string
 *                    (measured). The decoder then relays a string faithfully;
 *                    the type change is upstream, so the credit stands.
 *   bignum encoder — never out-of-domain, so this is unreachable.
 */
export function relayLandsInDomain(
  value: string,
  encoderDomain: NumericDomainTag,
  decoderDomain: NumericDomainTag,
): boolean {
  switch (encoderDomain) {
    case "bignum":
      return true; // never out-of-domain; caller only reaches here if it were
    case "i64u64": {
      // Lossless string on the wire — nothing numeric was lost to relay.
      return true;
    }
    case "f64": {
      const approx = f64Approximation(value);
      if (approx === null) return false; // no finite double to relay at all
      const mag = approx < 0n ? -approx : approx;
      // Exponent form on the wire: measured to take the numeric path in every
      // decoder in the matrix, so the decoder receives the encoder's double
      // and returns it. The loss is upstream and the relay credit holds.
      if (mag >= EXPONENT_FORM_THRESHOLD) return true;
      // Plain decimal on the wire: it has to be something the decoder holds.
      return inDomain(decoderDomain, approx.toString());
    }
  }
}

// ---------------------------------------------------------------------------
// Facts per implementation (derived from the adapters' single source)
// ---------------------------------------------------------------------------

export interface NumericImplFacts {
  domain: NumericDomainTag;
  /** §3+§2 encoder out-of-domain policy, or null if undocumented. */
  encoderPolicy: OutOfRangePolicy;
  /** §4 decoder out-of-range policy, or null if undocumented. */
  decoderPolicy: OutOfRangePolicy;
  /** Does the project affirmatively promise lossless round-trips in prose? */
  claimsLossless: boolean;
}

export type NumericFacts = Record<string, NumericImplFacts>;

function factsOf(id: keyof typeof IMPL_CLAIMS): NumericImplFacts {
  const n = IMPL_CLAIMS[id].numeric;
  return {
    domain: n.domain,
    encoderPolicy: n.encoderPolicy,
    decoderPolicy: n.decoderPolicy,
    claimsLossless: n.claimsLossless,
  };
}

export const NUMERIC_FACTS: NumericFacts = {
  ts: factsOf("ts"),
  python: factsOf("python"),
  rust: factsOf("rust"),
};

// ---------------------------------------------------------------------------
// Per-side verdicts
// ---------------------------------------------------------------------------

export type NumericVerdict =
  | "conformant" // nothing owed, or the obligation is met
  | "documented-lossless" // out-of-domain, documented quoted-lossless path (§2)
  | "documented-lossy" // out-of-domain, documented approximation (§3+§2)
  | "documented-policy" // out-of-range, documented decoder policy (§4)
  | "unattributed" // the model cannot fairly judge this side — see below
  | "violates"; // an obligation is unmet

export interface NumericSideResult {
  verdict: NumericVerdict;
  /** The clause this side is judged under, for citation. */
  clause: string;
  text: string;
}

/**
 * ENCODER side. §2's round-trip MUST binds only in-domain; out-of-domain the
 * obligation becomes documentation, under §3 (the host-type mapping) and §2
 * (the out-of-domain choice).
 */
export function encoderVerdict(value: string, e: NumericImplFacts): NumericSideResult {
  if (inDomain(e.domain, value)) {
    return {
      verdict: "conformant",
      clause: "§2",
      text: `${value} is exact in its ${e.domain} domain — the §2 round-trip MUST applies here and is met`,
    };
  }
  switch (e.encoderPolicy) {
    case "quoted-lossless":
      return {
        verdict: "documented-lossless",
        clause: "§2",
        text: `${value} is outside its ${e.domain} domain; the documented lossless quoted-string path applies (§2 permits it, and it is documented)`,
      };
    case "approximate":
      return {
        verdict: "documented-lossy",
        clause: "§3 + §2",
        text: `${value} is outside its ${e.domain} domain; the approximation is a documented host-type mapping (§3) and a documented §2 out-of-domain choice`,
      };
    case "reject":
      return {
        verdict: "documented-policy",
        clause: "§3 + §2",
        text: `${value} is outside its ${e.domain} domain; rejecting it is the documented policy`,
      };
    case null:
      return {
        verdict: "violates",
        clause: "§3 + §2",
        text:
          `${value} is outside its ${e.domain} domain, and neither the §3 host-type mapping nor a §2 out-of-domain policy is documented` +
          (e.claimsLossless
            ? " — while the docs affirmatively claim lossless round-trips"
            : ""),
      };
  }
}

/**
 * DECODER side. Reachable as faulted only when the encoder handed over the
 * value exactly; if the encoder was itself out-of-domain, the wire already
 * carries ITS approximation and the decoder is a faithful relay (see
 * domainsNest for why that is sound).
 */
export function decoderVerdict(
  value: string,
  e: NumericImplFacts,
  d: NumericImplFacts,
): NumericSideResult {
  if (!inDomain(e.domain, value)) {
    // The encoder was already out-of-domain, so the wire carries ITS output
    // and the loss is upstream — BUT only if what it emitted is something this
    // side can hold. That used to be guaranteed by domain nesting; since the
    // 2026-08-30 measurement removed the nesting, it is checked per value.
    if (relayLandsInDomain(value, e.domain, d.domain)) {
      return {
        verdict: "conformant",
        clause: "§4",
        text: `faithful relay — the encoder was out-of-domain, so the loss is upstream and this side decoded what it received`,
      };
    }
    return {
      verdict: "unattributed",
      clause: "§4",
      text:
        `the encoder is out-of-domain here, but what it emits for ${value} does not land inside this side's ${d.domain} domain either — ` +
        `so the relay credit is not sound and the model cannot say whose loss this is without seeing the wire`,
    };
  }
  if (inDomain(d.domain, value)) {
    return {
      verdict: "conformant",
      clause: "§4",
      text: `${value} is exact in its ${d.domain} domain — decoded without loss`,
    };
  }
  if (d.decoderPolicy === null) {
    return {
      verdict: "violates",
      clause: "§4",
      text:
        `${value} is outside its ${d.domain} domain and no out-of-range policy is documented, which §4 makes a MUST` +
        (d.claimsLossless
          ? " — while the docs affirmatively claim lossless round-trips"
          : "") +
        // WITHOUT THIS THE REPORT READS AS AN ACCUSATION OF DATA LOSS, and on
        // 2026-08-30 that would have been wrong: rust returns the exact digits
        // as a lossless quoted string, which is §4's RECOMMENDED behaviour,
        // and still lands here because it documents nothing. The unmet
        // obligation is the statement, not the handling.
        ` — note this is a DOCUMENTATION fault: §4 permits a higher-precision type, a string, an approximation, or rejection, so even an implementation already doing the RECOMMENDED lossless-first thing owes the written policy`,
    };
  }
  return {
    verdict: "documented-policy",
    clause: "§4",
    text: `${value} is outside its ${d.domain} domain; returning "${d.decoderPolicy}" is its documented §4 out-of-range policy`,
  };
}

/**
 * A self-pair (from === to) carries BOTH obligations on one implementation.
 * Report the first one that is not met — encoder first, since an encoder that
 * has already lost the value makes the decoder a faithful relay — and
 * conformant only when neither is breached.
 */
export function bothVerdict(value: string, f: NumericImplFacts): NumericSideResult {
  const enc = encoderVerdict(value, f);
  if (enc.verdict !== "conformant") return enc;
  return decoderVerdict(value, f, f);
}

/**
 * Pick the value that GOVERNS a pair: the first integer in the case that is
 * out-of-domain for at least one of the two sides. Returns null when the case
 * holds no such value — meaning the numeric-domain model does not explain this
 * divergence, which callers must surface rather than paper over with a row of
 * "conformant" verdicts.
 */
export function governingProbe(
  caseText: string,
  e: NumericImplFacts,
  d: NumericImplFacts,
): string | null {
  for (const v of integerProbes(caseText)) {
    if (!inDomain(e.domain, v) || !inDomain(d.domain, v)) return v;
  }
  return null;
}
