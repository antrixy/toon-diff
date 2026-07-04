// gen/failure-signature.ts
//
// Turns "this case fails" into "this case fails THIS way", so the shrinker can't
// slip from one bug to another while reducing. A case can carry several bugs at
// once (the fuzz run had cases with both a big integer and an empty array); a
// shrinker that only checked "still fails" could keep the wrong one. So every
// failure is captured as a SIGNATURE, and a reduction is kept only if it still
// reproduces one of the original signatures.
//
// signature = (from, to, kind, fingerprint)
//   kind        : "mismatch" (round-trip value differs) | "error" (encode/decode threw)
//   fingerprint : for mismatch, HOW the trees differ, categorized (number-changed,
//                 container->string, array->object, ...); for error, the message
//                 with digits normalized to '#', so "Expected 500 items" and
//                 "Expected 2 items" match and the array can actually shrink.
//
// Adapter-agnostic: pass real adapters (shrink-cli) or mock ones (the self-test).

import { ingest, equal, canonicalNumber } from "../oracle/ingest.ts";
import type { Node } from "../oracle/ingest.ts";
import type { GNode } from "./model.ts";
import { parse, isRawNum, isArray, isObject, lexemeOf } from "./model.ts";
import type { Adapter } from "../adapters/contract.ts";

export interface Signature {
  from: string;
  to: string;
  kind: "mismatch" | "error";
  fp: string;
}

export function normalizeError(msg: string): string {
  return msg.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Categorize HOW two value trees differ, at the first divergence (pre-order).
 * Walks the LEXEME-FAITHFUL tree (model.parse) and compares numbers by canonical
 * value -- never native JSON.parse, which would round big integers on both sides
 * and hide the very difference we're classifying.
 */
export function fingerprintMismatch(expectedText: string, actualText: string): string {
  let expTree: Node, actTree: Node;
  try { expTree = ingest(expectedText); } catch { return "expected-invalid"; }
  try { actTree = ingest(actualText); } catch { return "actual-invalid-json"; }
  if (equal(expTree, actTree)) return "none";

  const e = parse(expectedText);
  const a = parse(actualText);
  const kindOf = (v: GNode): string =>
    v === null ? "null" : isRawNum(v) ? "number" : isArray(v) ? "array" : isObject(v) ? "object" : typeof v;

  let result = "value-changed";
  const walk = (x: GNode, y: GNode): boolean => {
    const kx = kindOf(x), ky = kindOf(y);
    if (kx !== ky) {
      if ((kx === "array" || kx === "object") && ky === "string") { result = "container->string"; return true; }
      if (kx === "array" && ky === "object") { result = "array->object"; return true; }
      if (kx === "object" && ky === "array") { result = "object->array"; return true; }
      if (kx === "number" || ky === "number") { result = "number-changed"; return true; }
      result = `type:${kx}->${ky}`; return true;
    }
    if (kx === "number") {
      if (canonicalNumber(lexemeOf(x as never)) !== canonicalNumber(lexemeOf(y as never))) { result = "number-changed"; return true; }
      return false;
    }
    if (kx === "string" || kx === "boolean") { if (x !== y) { result = "scalar-changed"; return true; } return false; }
    if (kx === "null") return false;
    if (kx === "array") {
      const ax = x as GNode[], ay = y as GNode[];
      if (ax.length !== ay.length) { result = "array-length"; return true; }
      for (let i = 0; i < ax.length; i++) if (walk(ax[i], ay[i])) return true;
      return false;
    }
    const ox = x as Record<string, GNode>, oy = y as Record<string, GNode>;
    const kxs = Object.keys(ox), kys = new Set(Object.keys(oy));
    for (const k of kxs) {
      if (!kys.has(k)) { result = "key-dropped"; return true; }
      if (walk(ox[k], oy[k])) return true;
    }
    if (Object.keys(oy).length !== kxs.length) { result = "key-added"; return true; }
    return false;
  };
  walk(e, a);
  return result;
}

const sigKey = (s: Signature) => `${s.from}->${s.to}|${s.kind}|${s.fp}`;

/** Run every ordered adapter pair; return the signatures of all that fail. */
export async function captureSignatures(caseText: string, adapters: Adapter[]): Promise<Signature[]> {
  const expected = ingest(caseText);
  const sigs: Signature[] = [];
  const seen = new Set<string>();
  for (const X of adapters) {
    for (const Y of adapters) {
      let sig: Signature | null = null;
      try {
        const back = await Y.decode(await X.encode(caseText));
        if (!equal(ingest(back), expected)) {
          sig = { from: X.name, to: Y.name, kind: "mismatch", fp: fingerprintMismatch(caseText, back) };
        }
      } catch (e) {
        sig = { from: X.name, to: Y.name, kind: "error", fp: normalizeError(e instanceof Error ? e.message : String(e)) };
      }
      if (sig) { const k = sigKey(sig); if (!seen.has(k)) { seen.add(k); sigs.push(sig); } }
    }
  }
  return sigs;
}

/**
 * Build an `interesting(caseText)` predicate for the shrinker: the candidate must
 * be valid JSON and must still reproduce AT LEAST ONE of the target signatures.
 */
export function makeInteresting(targets: Signature[], adapters: Adapter[]): (t: string) => Promise<boolean> {
  const wanted = new Set(targets.map(sigKey));
  return async (caseText: string): Promise<boolean> => {
    try { ingest(caseText); } catch { return false; } // must stay valid JSON
    const sigs = await captureSignatures(caseText, adapters);
    return sigs.some((s) => wanted.has(sigKey(s)));
  };
}
