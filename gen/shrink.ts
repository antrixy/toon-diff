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
//   3. DDMIN   -- non-contiguous delta-min of any array (see below)
//   4. DELETE  -- drop an object key or array element
//   5. SIMPLIFY-- reduce a scalar toward the simplest value
// Each step returns the FIRST reduction that stays interesting; shrink() repeats
// until a full step finds nothing, which is exactly 1-minimality w.r.t. this set.
//
// Why NON-CONTIGUOUS ddmin (step 3). A giant list-array whose failure depends on a
// NON-MONOTONE invariant -- parity of the length, a checksum over the elements, a
// balanced/near-uniform group structure (exactly what GrowTable / PerturbUniformity
// manufacture) -- cannot be reduced by removing one element (that breaks the
// invariant) NOR by removing one contiguous run (its removable filler is scattered,
// or its removable group sits at a boundary no power-of-two split lands on). The old
// contiguous halving left such cases at full size: 0 steps, nothing cut. So step 3 is
// a proper ddmin over each array's elements:
//   * REDUCE-TO-SUBSET   -- keep just one of n partitions (the big 1/n collapse);
//   * REDUCE-TO-COMPLEMENT, ACCUMULATING -- within one granularity level, remove
//     every partition whose removal keeps `interesting`, committing as it goes, so
//     the net removed set is a NON-CONTIGUOUS UNION of partitions;
//   * a DOUBLING pre-pass (2,4,8,... -- cheap big cuts, monotone cases finish here in
//     O(log n) checks) followed by a LINEAR finish (2,3,4,... -- catches thirds,
//     fifths and every non-power-of-two group a doubling ladder can never align to),
//     looped to a fixpoint (ddmin-minimal for this array).
// It only ever keeps/drops existing element nodes, so a RawNum is never rebuilt --
// 9007199254740993 is not rounded while the array around it is being minimized.

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

// Partition [0, len) into up to n contiguous index-blocks of near-equal size.
function splitIndices(len: number, n: number): number[][] {
  const parts: number[][] = [];
  for (let i = 0; i < n; i++) {
    const s = Math.floor((i * len) / n), e = Math.floor(((i + 1) * len) / n);
    if (e > s) { const p: number[] = []; for (let j = s; j < e; j++) p.push(j); parts.push(p); }
  }
  return parts;
}

// ---- non-contiguous ddmin of ONE array -----------------------------------
// Reduce the array at `path` to a ddmin-minimal subset that keeps `ok` true, then
// return the whole tree with that array in place -- or null if nothing was cut.
// `ok(candidateTree)` is the shared predicate gate from reduceOnce (it enforces the
// check budget and "must be strictly smaller"); every candidate here has strictly
// fewer elements than the current array, so it is always a real reduction.
async function ddminArrayAt(
  root: GNode,
  path: Path,
  ok: (cand: GNode) => Promise<boolean>,
): Promise<GNode | null> {
  const arr0 = getAt(root, path);
  if (!isArray(arr0) || arr0.length < 2) return null;
  let kept: GNode[] = arr0.slice();
  let improved = false;

  // One granularity level at partition count n. Tries the big 1/n subset cut first,
  // then removes a NON-CONTIGUOUS union of partitions (accumulating over a snapshot
  // of `kept`: partitions are disjoint, so committing one never invalidates another).
  const level = async (n: number): Promise<boolean> => {
    const len = kept.length;
    const nn = Math.min(n, len);
    if (nn < 2) return false;
    const parts = splitIndices(len, nn);

    // (a) reduce to subset: keep exactly one partition.
    for (const part of parts) {
      if (part.length === len) continue;
      const subset = part.map((i) => kept[i]);
      if (subset.length >= 1 && (await ok(replaceAt(root, path, subset)))) {
        kept = subset; improved = true; return true;
      }
    }

    // (b) reduce to complement, accumulating -> non-contiguous removal.
    const mask = new Array(len).fill(false);
    let removed = false;
    for (const part of parts) {
      for (const i of part) mask[i] = true;
      const cand = kept.filter((_e, i) => !mask[i]);
      if (cand.length >= 1 && cand.length < len && (await ok(replaceAt(root, path, cand)))) {
        removed = true; // keep this partition removed; accumulate into the next
      } else {
        for (const i of part) mask[i] = false; // revert: this partition is load-bearing
      }
    }
    if (removed) { kept = kept.filter((_e, i) => !mask[i]); improved = true; return true; }
    return false;
  };

  for (;;) {
    const before = kept.length;
    // doubling pre-pass: cheap big cuts; monotone/aligned filler finishes here.
    for (let n = 2; n <= kept.length; n *= 2) { while (await level(n)) { /* keep cutting at n */ } }
    // linear finish: non-power-of-two group structure a doubling ladder can't align to.
    for (let n = 2; n <= kept.length; n++) { if (await level(n)) n = 1; }
    if (kept.length === before) break; // a whole round changed nothing -> ddmin-minimal
  }
  return improved ? replaceAt(root, path, kept) : null;
}

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

  // 3. DDMIN: non-contiguous delta-min of each array, largest arrays first. Each call
  //    reduces one array to ddmin-minimal (subset + accumulating complement, doubling
  //    then linear granularity); shrink()'s outer loop revisits the rest.
  const arrayPaths = paths.filter((p) => isArray(getAt(root, p)))
    .sort((a, b) => (getAt(root, b) as GNode[]).length - (getAt(root, a) as GNode[]).length);
  for (const p of arrayPaths) {
    if ((getAt(root, p) as GNode[]).length < 2) continue;
    const reduced = await ddminArrayAt(root, p, ok);
    if (reduced !== null) return reduced;
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
