// oracle/compare.ts
//
// Two responsibilities:
//   1. equal(a, b)         -> semantic equality under v1 policy (canonicalize.ts)
//   2. ingestionFidelity   -> the guard that decides whether a probe input can
//                             even be represented faithfully by this harness.
//
// (2) is the load-bearing idea. A differential oracle that silently lets its
// OWN JSON ingestion corrupt the test input produces false PASSes — the single
// worst failure mode for this tool. So before we ever compare, we self-check
// the input the same way ctxfold self-checks decode(encode(x)) === x: if native
// ingestion can't round-trip a number literal, the case is QUARANTINED, not
// quietly mis-tested.

import { canonical, type Json } from "./canonicalize.ts";

export function equal(a: Json, b: Json): boolean {
  return canonical(a) === canonical(b);
}

export interface Fidelity {
  faithful: boolean;
  reason?: string;
  offending?: string[];
}

/**
 * Decide whether native JSON ingestion preserves every number in `rawText`.
 *
 * Uses the ES2023 reviver source-text channel (ctx.source), which fires ONLY on
 * real JSON number tokens — never on digit runs inside strings (e.g. "e\u0301")
 * — so it has no string-interior false positives.
 *
 * A number literal is faithful iff its source lexeme survives parse -> serialize
 * at the value level. Catches exactly the three traps in the probe set:
 *   "-0"               sign dropped     (JSON.stringify(-0) === "0")
 *   "1.0"              form collapsed   (1.0 indistinguishable from 1 after parse)
 *   "9007199254740993" precision lost   (rounds to ...992)
 * and leaves the faithful ones (0, 123, 1.5, 9007199254740991, 9007199254740992)
 * testable.
 */
export function ingestionFidelity(rawText: string): Fidelity {
  const offending: string[] = [];
  JSON.parse(rawText, (_key, value, ctx?: { source?: string }) => {
    if (typeof value === "number" && ctx && typeof ctx.source === "string") {
      const src = ctx.source;
      if (Object.is(value, -0)) {
        offending.push(src); // sign loss
      } else if (canonicalNumber(src) !== canonicalNumber(String(value))) {
        offending.push(src); // form or precision loss
      }
    }
    return value;
  });
  return offending.length > 0
    ? {
        faithful: false,
        reason: "native JSON ingestion cannot preserve these number literals",
        offending,
      }
    : { faithful: true };
}

/** Canonical numeric form. "1.0" stays distinct from "1" on purpose, so 1.0 is flagged. */
function canonicalNumber(lit: string): string {
  return lit.replace(/^\+/, "");
}
