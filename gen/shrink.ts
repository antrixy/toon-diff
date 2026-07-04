// gen/shrink.ts
//
// Delta reduction of a failing case to a 1-minimal reproducer. Adapter-agnostic:
// it takes a boolean `interesting(text)` predicate and shrinks the JSON tree,
// keeping only reductions that keep `interesting` true, until no single further
// reduction does. The predicate is where "same failure" is enforced (see
// failure-signature.ts); this file only knows how to make a case structurally
// smaller.
//
// Operates on the generator's own lexeme-faithful tree (model.parse / emit), so a
// number is never corrupted during reduction -- the same guarantee the generator
// relies on. A shrinker that rounded 9007199254740993 while reducing would change
// the very bug it's trying to isolate.
//
// Strategy order per step (biggest cut first, so huge irrelevant structure
// collapses before we bother with fine deletions):
//   1. HOIST   -- replace the whole tree with one of its descendants (peel layers)
//   2. NULL    -- replace any subtree with null (collapse irrelevant subtrees)
//   3. DDMIN   -- remove chunks of any array (halving), then single elements
//   4. DELETE  -- drop an object key or array element
//   5. SIMPLIFY-- reduce a scalar toward the simplest value
// Each step returns the FIRST reduction that stays interesting; shrink() repeats
// until a full step finds nothing, which is exactly 1-minimality w.r.t. this set.

import type { GNode } from "./model.ts";
import { parse, isRawNum, isArray, isObject } from "./model.ts";
import { emit } from "./emit.ts";

export interface ShrinkResult {
  text: string;
  startBytes: number;
  endBytes: number;
  steps: number;   // successful reductions committed
  checks: number;  // predicate evaluations (each = 1..N adapter round-trips)
}

type Step = string | number;
type Path = Step[];

// ---- immutable path ops ---------------------------------------------------
function getAt(root: GNode, path: Path): GNode {
  let cur: GNode = root;
  for (const s of path) cur = typeof s === "number" ? (cur as GNode[])[s] : (cur as Record<string, GNode>)[s];
  return cur;
}
function replaceAt(root: GNode, path: Path, val: GNode): GNode {
  if (path.length === 0) return val;
  const [h, ...rest] = path;
  if (typeof h === "number") {
    const a = (root as GNode[]).slice(); a[h] = replaceAt(a[h], rest, val); return a;
  }
  const o = { ...(root as Record<string, GNode>) }; o[h] = replaceAt(o[h], rest, val); return o;
}
function deleteAt(root: GNode, path: Path): GNode {
  const [h, ...rest] = path;
  if (rest.length === 0) {
    if (typeof h === "number") { const a = (root as GNode[]).slice(); a.splice(h, 1); return a; }
    const o = { ...(root as Record<string, GNode>) }; delete o[h]; return o;
  }
  if (typeof h === "number") { const a = (root as GNode[]).slice(); a[h] = deleteAt(a[h], rest); return a; }
  const o = { ...(root as Record<string, GNode>) }; o[h] = deleteAt(o[h], rest); return o;
}

// pre-order paths, shallowest first (so hoisting cuts the most)
function allPaths(root: GNode, includeRoot = true): Path[] {
  const out: Path[] = [];
  const walk = (n: GNode, p: Path) => {
    if (p.length > 0 || includeRoot) out.push(p);
    if (isArray(n)) n.forEach((c, i) => walk(c, [...p, i]));
    else if (isObject(n)) for (const k of Object.keys(n)) walk(n[k], [...p, k]);
  };
  walk(root, []);
  return out;
}

const isLeaf = (n: GNode) => n === null || typeof n === "boolean" || typeof n === "string" || isRawNum(n);
const size = (t: string) => t.length;

// ---- one reduction step ---------------------------------------------------
// Returns a strictly-smaller interesting tree, or null if none exists.
async function reduceOnce(
  root: GNode,
  interesting: (t: string) => boolean | Promise<boolean>,
  count: { checks: number; max: number },
): Promise<GNode | null> {
  const curText = emit(root);
  const curSize = size(curText);
  const ok = async (cand: GNode): Promise<boolean> => {
    if (count.checks >= count.max) return false;
    const t = emit(cand);
    if (t.length >= curSize) return false; // never accept a non-reduction
    count.checks++;
    return await interesting(t);
  };

  const paths = allPaths(root, true);

  // 1. HOIST: replace whole tree with a descendant (shallowest descendants first).
  for (const p of paths) {
    if (p.length === 0) continue;
    const child = getAt(root, p);
    if (await ok(child)) return child;
  }

  // 2. NULL: replace any non-null subtree with null.
  for (const p of paths) {
    const n = getAt(root, p);
    if (n === null) continue;
    const cand = replaceAt(root, p, null);
    if (await ok(cand)) return cand;
  }

  // 3. DDMIN on arrays: remove chunks (halves, quarters, ...), largest arrays first.
  const arrayPaths = paths.filter((p) => isArray(getAt(root, p)))
    .sort((a, b) => (getAt(root, b) as GNode[]).length - (getAt(root, a) as GNode[]).length);
  for (const p of arrayPaths) {
    const arr = getAt(root, p) as GNode[];
    const n = arr.length;
    if (n === 0) continue;
    for (let chunks = 2; chunks <= n; chunks *= 2) {
      const csz = Math.ceil(n / chunks);
      for (let start = 0; start < n; start += csz) {
        const reduced = arr.slice(0, start).concat(arr.slice(start + csz));
        if (reduced.length === n) continue;
        const cand = replaceAt(root, p, reduced);
        if (await ok(cand)) return cand;
      }
    }
  }

  // 4. DELETE a single object key or array element.
  for (const p of paths) {
    if (p.length === 0) continue;
    const cand = deleteAt(root, p);
    if (await ok(cand)) return cand;
  }

  // 5. SIMPLIFY a scalar toward the simplest value.
  const simplest: GNode[] = [null, false, ""];
  for (const p of paths) {
    const n = getAt(root, p);
    if (!isLeaf(n)) continue;
    for (const s of simplest) {
      if (emit(n) === emit(s)) break; // already at/simpler than this target
      const cand = replaceAt(root, p, s);
      if (await ok(cand)) return cand;
    }
  }

  return null;
}

/**
 * Reduce `caseText` to a 1-minimal case that still satisfies `interesting`.
 * `interesting(caseText)` MUST be true on entry (the caller verifies the case
 * fails before shrinking); shrink() asserts it and returns the input unchanged if
 * not, rather than producing a misleading "reduction" of a non-failing case.
 */
export async function shrink(
  caseText: string,
  interesting: (t: string) => boolean | Promise<boolean>,
  opts: { maxChecks?: number } = {},
): Promise<ShrinkResult> {
  const startBytes = size(caseText);
  const count = { checks: 0, max: opts.maxChecks ?? 200_000 };
  let cur = parse(caseText);
  let steps = 0;

  if (!(await interesting(caseText))) {
    return { text: caseText, startBytes, endBytes: startBytes, steps: 0, checks: 0 };
  }

  for (;;) {
    const next = await reduceOnce(cur, interesting, count);
    if (next === null) break;
    cur = next;
    steps++;
    if (count.checks >= count.max) break;
  }

  const text = emit(cur);
  return { text, startBytes, endBytes: size(text), steps, checks: count.checks };
}
