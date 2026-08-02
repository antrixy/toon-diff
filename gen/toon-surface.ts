// gen/toon-surface.ts
//
// TOON wire-syntax productions. This module exists to mint STRING CONTENTS that
// are complete structural tokens -- the toon#324 class -- so the property layer
// can manufacture them from the grammar instead of drawing from a hand-written
// palette.
//
// CONTAINMENT (deliberate, see gen/DESIGN.md). This is the ONLY place in the
// project that knows TOON syntax. The oracle knows nothing about TOON;
// shrink.ts advertises that it knows nothing about TOON; the matrix and the
// judge are unchanged. This module:
//   * mints strings and nothing else -- it never builds structure, never sees a
//     GNode, and never participates in a verdict;
//   * imports only ./prng.ts;
//   * knows nothing about channels, fuel, identity or the corpus.
// property.ts owns the weights and decides where a token is placed.
//
// WHY THIS IS NOT A PALETTE. Uniform draws from the JSON string grammar would
// never produce "[2]{a,b}:" -- structural tokens are measure-zero there. But
// reusing operators.ts's twelve LOOKALIKE_PAYLOADS would make every finding
// trace back to twelve strings a human wrote. So tokens are assembled from the
// spec's own productions: the region is reached by construction, and the
// payloads are disjoint from the twelve by nature rather than by exclusion.
//
// BASIS IS RECORDED PER FAMILY, not claimed in bulk. SPEC.md v4.1 §6 carries a
// real RFC 5234 ABNF block (header, keyed-header, bracket-seg, keyed-seg,
// fields-seg, field-entry, length, delimsym, key) and §7.1 a second one
// (quoted-char). Five families below are transcribed from that ABNF. Three are
// prose-derived -- stated precisely enough to generate from, but prose. A single
// "spec-derived" label spanning both would be the kind of overclaim this project
// files against others, so FAMILY_BASIS carries the distinction.

import type { Rng } from "./prng.ts";

/**
 * The spec revision these productions model. Compared against SPEC_CURRENT by
 * selftest-property.ts: golden outputs prove the MODULE did not move, and cannot
 * detect that the SPEC moved while the module stood still. The comparison lives
 * in the self-test so this module still imports nothing from probe/.
 *
 * The two dates below disagree upstream and that is not a transcription error:
 * SPEC.md v4.1's header reads 2026-07-26 while toon's acc1bed sets
 * $spec.date = '2026-07-25'. `date` records the spec repo's own header.
 */
export const TOON_SURFACE_SPEC = {
  version: "4.1",
  date: "2026-07-26",
} as const;

export const FAMILIES = [
  "array-header",
  "tabular-header",
  "nested-field-group",
  "keyed-tabular-header",
  "list-marker",
  "key-value-line",
  "comment-line",
  "empty-array-token",
] as const;
export type Family = (typeof FAMILIES)[number];

/** What each family is transcribed from, and from where. */
export const FAMILY_BASIS: Record<Family, { basis: "abnf" | "prose"; clauses: string[] }> = {
  "array-header":         { basis: "abnf",  clauses: ["§6 header", "§6 bracket-seg", "§9.1"] },
  "tabular-header":       { basis: "abnf",  clauses: ["§6 header", "§6 fields-seg", "§9.3"] },
  "nested-field-group":   { basis: "abnf",  clauses: ["§6 field-entry", "§9.3"] },
  "keyed-tabular-header": { basis: "abnf",  clauses: ["§6 keyed-header", "§6 keyed-seg", "§9.5"] },
  "key-value-line":       { basis: "abnf",  clauses: ["§6 key", "§7.3", "§7.4"] },
  "list-marker":          { basis: "prose", clauses: ["§5.2 cl.2", "§9.2", "§9.4", "§10"] },
  "comment-line":         { basis: "prose", clauses: ["§5.1", "§7.2"] },
  "empty-array-token":    { basis: "prose", clauses: ["§9.1", "§9.3", "§9.5", "§4"] },
};

// ---- shared productions ---------------------------------------------------

// §6: delimsym = HTAB / "|" ; absence means comma. The bracket segment's symbol
// declares the active delimiter for the WHOLE header, and §6 requires the field
// list to use that same delimiter at every nesting level -- so it is drawn once
// per header and threaded through, never re-drawn per field.
const DELIMS = [
  { sym: "", sep: "," },     // absent -> comma
  { sym: "\t", sep: "\t" },  // HTAB
  { sym: "|", sep: "|" },    // pipe
] as const;

const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";

/** §6: length = "0" / ( %x31-39 *DIGIT ) -- no leading zeros. */
function length(rng: Rng): string {
  if (rng.int(8) === 0) return "0";
  const digits = 1 + rng.int(4);
  let out = DIGIT[1 + rng.int(9)];
  for (let i = 1; i < digits; i++) out += DIGIT[rng.int(10)];
  return out;
}

/** §6/§7.3: unquoted-key = ( ALPHA / "_" ) *( ALPHA / DIGIT / "_" / "." ) */
function unquotedKey(rng: Rng): string {
  const head = ALPHA + "_";
  const tail = ALPHA + DIGIT + "_.";
  let out = head[rng.int(head.length)];
  const n = rng.int(10);
  for (let i = 0; i < n; i++) out += tail[rng.int(tail.length)];
  return out;
}

/**
 * §6 quoted-key / §7.1 quoted-char. Kept to the escapes §7.1 actually defines --
 * an invalid escape would make the token a decode error rather than a lookalike,
 * which is a different test.
 */
function quotedKey(rng: Rng): string {
  const safe = ALPHA + DIGIT + " -#[]{}|";
  const escapes = ["\\\\", '\\"', "\\n", "\\r", "\\t"];
  let out = "";
  const n = 1 + rng.int(8);
  for (let i = 0; i < n; i++) {
    out += rng.int(6) === 0 ? rng.pick(escapes) : safe[rng.int(safe.length)];
  }
  return `"${out}"`;
}

function key(rng: Rng): string {
  return rng.int(4) === 0 ? quotedKey(rng) : unquotedKey(rng);
}

/** §6 fields-seg, with nested groups when `nest` is set (§6 field-entry, §9.3). */
function fieldsSeg(rng: Rng, sep: string, nest: boolean): string {
  const count = 1 + rng.int(3);
  const entries: string[] = [];
  for (let i = 0; i < count; i++) {
    let e = key(rng);
    // A field entry MAY carry its own field list; the nested group uses the SAME
    // active delimiter as the enclosing header (§6).
    if (nest && i === 0) e += fieldsSeg(rng, sep, false);
    entries.push(e);
  }
  return "{" + entries.join(sep) + "}";
}

/** Optional key prefix. Keyless headers are valid at root / as list items (§6). */
function optKey(rng: Rng): string {
  return rng.bool() ? key(rng) : "";
}

// ---- the eight families ---------------------------------------------------

export const PRODUCTIONS: Record<Family, (rng: Rng) => string> = {
  // §6: header = [ key ] bracket-seg ":"   e.g. "[3]:", "items[12|]:"
  "array-header": (rng) => {
    const d = rng.pick(DELIMS);
    return `${optKey(rng)}[${length(rng)}${d.sym}]:`;
  },

  // §6: header with fields-seg   e.g. "[2]{a,b}:", "items[3\t]{x\ty}:"
  "tabular-header": (rng) => {
    const d = rng.pick(DELIMS);
    return `${optKey(rng)}[${length(rng)}${d.sym}]${fieldsSeg(rng, d.sep, false)}:`;
  },

  // §6 field-entry / §9.3   e.g. "[2]{id,customer{name,country}}:"
  "nested-field-group": (rng) => {
    const d = rng.pick(DELIMS);
    return `${optKey(rng)}[${length(rng)}${d.sym}]${fieldsSeg(rng, d.sep, true)}:`;
  },

  // §6 keyed-header = [ key ] keyed-seg fields-seg ":" -- the colon after the
  // length is what marks the keyed tabular form (§9.5). The field list is
  // REQUIRED, so this production never omits it.
  "keyed-tabular-header": (rng) => {
    const d = rng.pick(DELIMS);
    return `${optKey(rng)}[${length(rng)}:${d.sym}]${fieldsSeg(rng, d.sep, false)}:`;
  },

  // §5.2 cl.2: the bare marker "-", or content beginning with "- ". §12's
  // trailing-space rule makes "-" plus spaces the bare marker too. Leading
  // indentation is part of the lookalike (§9.2, §9.4, §10).
  "list-marker": (rng) => {
    const indent = " ".repeat(2 * rng.int(3));
    switch (rng.int(4)) {
      case 0: return `${indent}-`;
      case 1: return `${indent}- `;
      case 2: return `${indent}- ${unquotedKey(rng)}`;
      default: return `${indent}- ${key(rng)}: ${unquotedKey(rng)}`;
    }
  },

  // §5.2 cl.4 / §7.4: a key token, its colon, and an optional value. "key:" with
  // nothing after opens an object scope (§8); "key: value" is a primitive field.
  "key-value-line": (rng) => {
    const k = key(rng);
    switch (rng.int(3)) {
      case 0: return `${k}:`;
      case 1: return `${k}: ${unquotedKey(rng)}`;
      default: return `${k}: ${length(rng)}`;
    }
  },

  // §5.1: a comment line is one whose first character after zero or more SPACES
  // is "#". Only spaces may precede it -- a leading tab disqualifies it, so this
  // production emits spaces only. §7.2 requires encoders to quote any string
  // starting with "#", which is what makes an unquoted one a lookalike.
  "comment-line": (rng) => {
    const indent = " ".repeat(rng.int(5));
    const body = rng.bool() ? ` ${unquotedKey(rng)}` : unquotedKey(rng);
    return `${indent}#${body}`;
  },

  // The two bytes whose meaning FLIPS by position: "[]" is an empty array in
  // field and root position (§9.1) but decodes as the string "[]" inside a
  // tabular row or keyed entry row (§9.3, §9.5, §4). No other family in this
  // module is position-dependent, and the operator palette has no equivalent.
  "empty-array-token": (rng) => {
    switch (rng.int(4)) {
      case 0: return "[]";
      case 1: return `${key(rng)}: []`;
      case 2: return "- []";
      default: return `${key(rng)}[${length(rng)}]: []`;
    }
  },
};

/** One token from a named family. */
export function token(rng: Rng, family: Family): string {
  return PRODUCTIONS[family](rng);
}
