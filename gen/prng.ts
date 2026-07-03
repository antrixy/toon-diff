// gen/prng.ts
//
// A tiny, deterministic PRNG. The point is reproducibility, not cryptographic
// quality: a finding is only actionable if it replays byte-for-byte, so the
// generator NEVER touches Math.random. A case's entire identity is (seed file,
// integer rngSeed, operator pipeline) -- feed those back in and you get the exact
// same bytes, which is what makes the case fileable upstream and shrinkable.
//
// mulberry32: 32-bit state, one multiply-xorshift step per draw. Well-distributed
// enough to spread mutations across a tree; small enough to read in one sitting.

export interface Rng {
  next(): number;              // float in [0, 1)
  int(nExclusive: number): number; // integer in [0, n)
  pick<T>(arr: readonly T[]): T;   // uniform element
  bool(): boolean;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return {
    next,
    int,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    bool: () => next() < 0.5,
  };
}
