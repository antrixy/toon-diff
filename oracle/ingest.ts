// oracle/ingest.ts
//
// v2 oracle core: lossless, number-faithful ingestion + canonical comparison.
//
// WHY THIS EXISTS
// ---------------
// v1 (canonicalize.ts + compare.ts) routed every number through JSON.parse,
// which silently collapses -0 -> 0, 1.0 -> 1, and 2^53+1 -> 2^53. Because the
// comparison VALUE was lossy, the only honest move was to QUARANTINE such cases
// (the fidelity guard). That benched exactly the inputs where TS (f64), Python
// (arbitrary-precision int), and Rust (i64/u64/f64) are GUARANTEED to disagree
// -- i.e. the strongest differential evidence the tool can produce.
//
// v2 removes the lossy step. Numbers are captured at their EXACT source lexeme
// via the ES2023 reviver `ctx.source` channel, then reduced to a canonical
// *value* form using arbitrary-precision string arithmetic -- never an f64.
// Result: nothing needs quarantining on numeric grounds, and 010 / 013 graduate
// from "benched" to "tested".
//
// COMPARISON POLICY (the one real judgment call -- see canonicalNumber):
//   Numbers compare by mathematical VALUE, not representation:
//     1.0 == 1        (value-equal; RFC 8259 says these denote the same number)
//     -0  == 0        (value-equal; JSON has no signed zero in its value model)
//     2^53+1 != 2^53  (DIFFERENT integers -> precision loss is a real divergence)
//   This is the correct default for a "did the round-trip stay lossless?" oracle.
//   If you instead want to FLAG value-preserving representational drift (e.g.
//   surface that one impl keeps -0 and another normalizes it), that is a
//   deliberate policy flip -- see the note at the bottom of canonicalNumber.

// ---- value tree ----------------------------------------------------------
// Numbers become a Symbol-tagged node so they can NEVER collide with a real
// JSON object that happens to have a "__num" key. JSON.parse cannot produce a
// Symbol key, and Object.keys never enumerates one, so the tag is collision-proof.
const NUM = Symbol("num");
export interface NumNode {
  [NUM]: string; // canonical VALUE form of the number
}
export type Node =
  | null
  | boolean
  | string
  | NumNode
  | Node[]
  | { [k: string]: Node };

function numNode(canon: string): NumNode {
  return { [NUM]: canon };
}
export function isNum(n: unknown): n is NumNode {
  return typeof n === "object" && n !== null && NUM in (n as object);
}

// ---- ingestion -----------------------------------------------------------
/**
 * Parse JSON text into a value tree, capturing every number at its exact source
 * lexeme (pre-rounding) and storing its canonical value form. No number ever
 * passes through an f64, so 9007199254740993 survives as itself.
 */
export function ingest(rawText: string): Node {
  return JSON.parse(rawText, (_key, value, ctx?: { source?: string }) => {
    if (typeof value === "number" && ctx && typeof ctx.source === "string") {
      return numNode(canonicalNumber(ctx.source));
    }
    return value; // strings/bools/null/structure untouched
  }) as Node;
}

// ---- canonical numeric value form (arbitrary precision, no float) --------
/**
 * Reduce a JSON number lexeme to a canonical decimal string denoting its exact
 * mathematical value. Pure string/integer arithmetic -- never parseFloat.
 *
 *   "0" "-0" "0.0"            -> "0"
 *   "1" "1.0" "1.00" "1e0"    -> "1"
 *   "1.50" "1.5"              -> "1.5"
 *   "1e2" "100"              -> "100"
 *   "1e-2"                   -> "0.01"
 *   "9007199254740993"       -> "9007199254740993"   (exact; != ...992)
 */
export function canonicalNumber(lex: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(lex.trim());
  if (!m) return lex; // not a well-formed JSON number; fail safe, never throw

  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2];
  const fracPart = m[3] ?? "";
  const exp = m[4] ? parseInt(m[4], 10) : 0;

  // All significant digits, and where the decimal point sits within them.
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp; // count of digits left of the point

  // Split into integer-part / fraction-part strings by shifting the point,
  // padding with zeros when the point falls outside the digit run.
  let intStr: string;
  let fracStr: string;
  if (pointPos <= 0) {
    intStr = "0";
    fracStr = "0".repeat(-pointPos) + digits;
  } else if (pointPos >= digits.length) {
    intStr = digits + "0".repeat(pointPos - digits.length);
    fracStr = "";
  } else {
    intStr = digits.slice(0, pointPos);
    fracStr = digits.slice(pointPos);
  }

  intStr = intStr.replace(/^0+(?=\d)/, ""); // strip leading zeros, keep one
  fracStr = fracStr.replace(/0+$/, ""); // strip trailing zeros

  if (intStr === "0" && fracStr === "") return "0"; // canonical zero, sign dropped
  return fracStr ? `${sign}${intStr}.${fracStr}` : `${sign}${intStr}`;

  // POLICY FLIP: to treat representational drift as a divergence (so -0 != 0 and
  // 1.0 != 1 are flagged), return a representation-preserving form here instead
  // -- e.g. keep the trailing ".0" and the leading "-" on zero. Integers still
  // compare exact either way; only the value-vs-representation stance changes.
}

// ---- canonical serialization + equality ----------------------------------
/**
 * Comparison-stable string for a value tree. Preserves every v1 invariant:
 *   - object key order normalized (sorted); array order significant
 *   - type-strict: string "123" can't equal number 123 (quoted vs #-tagged)
 *   - NO Unicode normalization (JSON.stringify is code-point faithful)
 * and adds exact-value numbers.
 */
export function canonical(node: Node): string {
  if (node === null) return "null";
  if (typeof node === "boolean") return node ? "true" : "false";
  if (typeof node === "string") return JSON.stringify(node); // quoted form
  if (isNum(node)) return "#" + node[NUM]; // unquoted #-token; can't be a string
  if (Array.isArray(node)) return "[" + node.map(canonical).join(",") + "]";
  const obj = node as { [k: string]: Node };
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

/** Semantic equality under v2 policy: canonical strings byte-identical. */
export function equal(a: Node, b: Node): boolean {
  return canonical(a) === canonical(b);
}

/** Convenience: ingest two raw JSON texts and compare. Used by the CLI matrix. */
export function equalRaw(aRaw: string, bRaw: string): boolean {
  return canonical(ingest(aRaw)) === canonical(ingest(bRaw));
}
