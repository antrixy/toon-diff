// gen/model.ts
//
// The generator's value model. Deliberately SEPARATE from the oracle's Node
// (oracle/ingest.ts), and for one reason: the oracle stores numbers in canonical
// VALUE form (it throws the source lexeme away, because for *comparison* -0, 1.0
// and 1 are the same value). A generator must do the opposite -- keep the exact
// lexeme -- so that:
//   * an untouched number round-trips BYTE-for-byte  (-0 stays -0, 1.0 stays 1.0,
//     9007199254740993 stays exactly itself, never an f64),
//   * a number-mutating operator can mint any lexeme it wants (1e2, -0, a 30-digit
//     integer) without laundering it through canonicalNumber.
//
// The number-corruption trap is the whole ballgame. If the generator ever routed
// a literal through a native JS number, it would round 9007199254740993 -> ...992
// on ingestion and then "discover" a divergence that it created itself -- a false
// finding, the single worst outcome for a differential tool. So parse() captures
// every number at ctx.source (ES2023), exactly as the oracle does, and stores the
// raw lexeme. No number ever touches an f64 as a stored value.
//
// The oracle is never modified. It is imported ONLY by the self-tests, where it
// acts as the independent judge that the generator's parse->emit substrate is
// value-faithful.

// A number is a Symbol-tagged node carrying its raw JSON lexeme. The Symbol tag
// means a real JSON object with a "lex" key can never be mistaken for a number,
// and Object.keys / JSON reviver output can never produce a Symbol key.
const LEX = Symbol("lex");
export interface RawNum {
  [LEX]: string; // exact JSON number lexeme, e.g. "-0", "1.0", "9007199254740993", "1e2"
}
export function rawNum(lexeme: string): RawNum {
  return { [LEX]: lexeme };
}
export function isRawNum(n: unknown): n is RawNum {
  return typeof n === "object" && n !== null && LEX in (n as object);
}
export function lexemeOf(n: RawNum): string {
  return n[LEX];
}

export type GNode =
  | null
  | boolean
  | string
  | RawNum
  | GNode[]
  | { [k: string]: GNode };

/**
 * Parse JSON text into a GNode tree, capturing every number at its exact source
 * lexeme (pre-rounding). Strings, booleans, null and structure pass through as
 * native values. No number is ever stored as an f64.
 *
 * Mirrors oracle/ingest.ts's use of the ctx.source reviver channel, but stores
 * the lexeme instead of the canonical value -- because the generator's contract
 * is faithfulness of REPRESENTATION, not of value.
 */
export function parse(rawText: string): GNode {
  return JSON.parse(rawText, (_key, value, ctx?: { source?: string }) => {
    if (typeof value === "number" && ctx && typeof ctx.source === "string") {
      return rawNum(ctx.source);
    }
    return value;
  }) as GNode;
}

// ---- structural helpers used by operators --------------------------------
export function isObject(n: GNode): n is { [k: string]: GNode } {
  return typeof n === "object" && n !== null && !Array.isArray(n) && !isRawNum(n);
}
export function isArray(n: GNode): n is GNode[] {
  return Array.isArray(n);
}

/** Deep structural clone of a GNode (RawNum is immutable-by-convention; reuse ok, but clone for safety). */
export function clone(n: GNode): GNode {
  if (n === null || typeof n === "boolean" || typeof n === "string") return n;
  if (isRawNum(n)) return rawNum(lexemeOf(n));
  if (isArray(n)) return n.map(clone);
  const out: { [k: string]: GNode } = {};
  for (const k of Object.keys(n)) out[k] = clone((n as { [k: string]: GNode })[k]);
  return out;
}
