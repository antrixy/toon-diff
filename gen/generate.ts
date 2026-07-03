// gen/generate.ts
//
// Turns a seed + an integer rngSeed into a generated case, and records exactly
// how it was made. The provenance record is not decoration -- it is the seam the
// rest of v0.2/v0.3 hangs on:
//   * the SHRINKER reduces a failing case by pruning THIS operator pipeline and
//     re-running, so a divergence collapses to its minimal reproducer;
//   * v0.3's provenance-grouped corpus consumes {seed, ops} directly.
//
// generateCase is a PURE function of (seedText, rngSeed): same inputs -> identical
// bytes. That is the whole reproducibility contract. No Math.random, no clock.

import type { GNode } from "./model.ts";
import { parse } from "./model.ts";
import { emit } from "./emit.ts";
import { makeRng } from "./prng.ts";
import type { Rng } from "./prng.ts";
import { OPERATORS } from "./operators.ts";
import type { Operator } from "./operators.ts";

export interface OpStep { op: string; detail: string; }
export interface Provenance {
  seed: string;      // seed file name (or "<inline>")
  rngSeed: number;   // the integer that replays this case
  pipeline: OpStep[]; // ordered operators actually applied
}
export interface GeneratedCase {
  text: string;        // valid JSON, ready for the matrix
  provenance: Provenance;
}

/** Weighted pick among applicable operators. */
function pickOperator(root: GNode, rng: Rng): Operator | null {
  const usable = OPERATORS.filter((o) => o.applicable(root));
  if (usable.length === 0) return null;
  const total = usable.reduce((s, o) => s + o.weight, 0);
  let r = rng.next() * total;
  for (const o of usable) {
    r -= o.weight;
    if (r < 0) return o;
  }
  return usable[usable.length - 1];
}

/**
 * Apply a pipeline of 1..maxOps operators to the seed, deterministically.
 * The rng is seeded once from rngSeed; the pipeline length is itself drawn from
 * it, so the whole run is a pure function of (seedText, rngSeed).
 */
export function generateCase(
  seedText: string,
  rngSeed: number,
  opts: { seedName?: string; maxOps?: number } = {},
): GeneratedCase {
  const rng = makeRng(rngSeed);
  const maxOps = opts.maxOps ?? 3;
  const steps = 1 + rng.int(maxOps); // 1..maxOps operators
  let node = parse(seedText);
  const pipeline: OpStep[] = [];
  for (let i = 0; i < steps; i++) {
    const op = pickOperator(node, rng);
    if (!op) break;
    const { node: next, detail } = op.apply(node, rng);
    node = next;
    pipeline.push({ op: op.name, detail });
  }
  return {
    text: emit(node),
    provenance: { seed: opts.seedName ?? "<inline>", rngSeed, pipeline },
  };
}

/**
 * Replay a case from its provenance is trivial precisely because generateCase is
 * pure: generateCase(seedText, provenance.rngSeed, {maxOps: pipeline.length}) is
 * NOT how replay works (pipeline length was itself drawn) -- instead, replay by
 * re-running generateCase(seedText, rngSeed) with the SAME maxOps used originally.
 * Keep maxOps fixed per run so rngSeed alone identifies the case.
 */
export function replay(seedText: string, rngSeed: number, maxOps = 3): string {
  return generateCase(seedText, rngSeed, { maxOps }).text;
}
