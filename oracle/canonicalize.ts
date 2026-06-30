// oracle/canonicalize.ts
//
// Produces a comparison-stable canonical form of a parsed JSON value.
//
// v1 policy — normalize ONLY what the spec deems semantically irrelevant:
//   - object key order      -> sorted (JSON objects are unordered)
//   - JSON serialization ws  -> removed (we re-stringify ourselves)
// Everything else is preserved exactly:
//   - array order            -> kept (arrays are ordered)
//   - string code points     -> kept verbatim (NO Unicode NFC/NFD)
//   - value types            -> kept (string "123" is NOT number 123)
//
// Deliberately NOT handled here: -0 vs 0, 1.0 vs 1, integers > 2^53.
// Those are not a *comparison* problem, they are an *ingestion* problem,
// and are caught upstream by the fidelity guard in compare.ts. Keeping the
// number model out of the comparator keeps the comparator honest.

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

/** Recursively sort object keys; leave everything else structurally intact. */
export function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys((value as { [k: string]: Json })[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical string form used for equality. Two values are semantically equal
 * (under v1 policy) iff their canonical strings are byte-identical.
 *
 * Note: JSON.stringify is code-point faithful for strings and does not apply
 * Unicode normalization, which is exactly what we want — comparing "e\u0301"
 * to "\u00e9" must report NOT equal.
 */
export function canonical(value: Json): string {
  return JSON.stringify(sortKeys(value));
}
