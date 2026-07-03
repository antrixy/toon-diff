// gen/emit.ts
//
// GNode -> valid JSON text, losslessly.
//
// Two invariants that make this the load-bearing primitive of the generator:
//
//   1. NUMBER FAITHFULNESS. A RawNum emits its stored lexeme verbatim. The
//      generator never reconstructs a number from a JS value, so 9007199254740993
//      leaves as exactly those digits, -0 leaves as "-0", 1.0 leaves as "1.0".
//      This is what lets the parse->emit substrate be proven non-corrupting.
//
//   2. KEY ORDER PRESERVED. Objects emit keys in insertion order -- emit does NOT
//      sort. This is deliberate: object key order is a *fault line*, not noise.
//      The oracle's equality ignores key order (two orderings are value-equal),
//      but a TOON *encoder* may make a different tabular-vs-nested decision based
//      on the order it sees. The gap between "value-equal to the judge" and
//      "encoded differently by an impl" is exactly where PerturbUniformity hunts.
//      So the generator must be free to emit rows in any key order.
//
// Strings go through JSON.stringify (code-point faithful; escapes only what JSON
// requires). Everything emitted here re-parses as valid JSON -- asserted in bulk
// by the operator self-test, because an invalid case would crash the matrix.

import type { GNode } from "./model.ts";
import { isRawNum, isArray, lexemeOf } from "./model.ts";

export function emit(node: GNode): string {
  if (node === null) return "null";
  if (typeof node === "boolean") return node ? "true" : "false";
  if (typeof node === "string") return JSON.stringify(node);
  if (isRawNum(node)) return lexemeOf(node); // exact lexeme, no reconstruction
  if (isArray(node)) return "[" + node.map(emit).join(",") + "]";
  // object: insertion order preserved on purpose (see header)
  const obj = node as { [k: string]: GNode };
  const parts: string[] = [];
  for (const k of Object.keys(obj)) {
    parts.push(JSON.stringify(k) + ":" + emit(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}
