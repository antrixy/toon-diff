# gen/ — the v0.2 mutation generator

Turns the 13 hand-written seeds into inputs nobody wrote, while keeping the same
proven judge (`oracle/ingest.ts`). Mutation-first: every generated case is a seed
with an ordered pipeline of operators applied. From-scratch generation is deferred.

## The one invariant that matters

A differential tool's worst failure is a **false finding** — reporting a
divergence it created itself. For this oracle that means: never let a number get
corrupted on the way in. `9007199254740993` routed through a JS `number` becomes
`…992`, and the tool would then "discover" a precision bug that is its own.

So the generator has its own value model (`model.ts`) that captures every number
at its exact source lexeme via the ES2023 `ctx.source` channel — the same trick
the oracle uses — and stores the **lexeme**, not a value. `emit.ts` writes that
lexeme back verbatim. An untouched number round-trips byte-for-byte; a minted
number is a lexeme the operator controls directly. No number ever passes through
an f64.

`selftest-emit.ts` proves this against the oracle: for all 13 seeds,
`equalRaw(emit(parse(s)), s)`, plus byte-exact survival of `9007199254740993`,
`-0`, and `1.0`. The oracle is never modified — it is imported only as the
independent judge in the self-tests.

## Operator set (designed against the 13 seeds)

Priority follows the payload-density fault line surfaced externally (toon#310):
the ecosystem over-tests **deep nesting** and under-tests **flat / wide /
highly-repetitive / large-table** shapes. Tier 1 exists to manufacture those.

| Tier | Operator | Fault line | Seeds it acts on |
|------|----------|-----------|------------------|
| 1 | `WidenObject` | flat/wide objects (many keys, shallow) | 001, 007, 010 |
| 1 | `ScaleArray` | long, highly-repetitive arrays | 002, 004, 005 |
| 1 | `GrowTable` | large row-count tabular path | 004, 005 |
| 1 | `WidenRow` | wide tables | 004, 005 |
| 1 | `PerturbUniformity` | near-uniform trap, scaled (005 generalized) | 004 |
| 1 | `EmptyContainerMix` | empty-array encoding (a bug already filed upstream) | 001, 002 |
| 2 | `BumpNumber` | boundary/overflow integers (2^53±k, i64/u64 max, 10^30) | 010–013 |
| 2 | `NumberForm` | representational number traps (-0, 1.0, 1e2) | 010 |
| 3 | `DelimiterInject` | delimiter/inline-vs-quoted string stress + lookalikes | 006, 007, 009 |
| 4 | `NestDeep` | deep nesting — the *over-tested* region; kept only for contrast | 003 |

Every operator: structure-aware (acts on a `GNode` tree, not text surgery),
deterministic (driven by `prng.ts` — mulberry32, never `Math.random`), and
guaranteed to emit valid JSON (asserted in bulk in `selftest-operators.ts`).

`emit` deliberately **preserves object key order** (does not sort). Key order is
a fault line: the oracle's equality ignores it (two orderings are value-equal),
but a TOON *encoder* may make a different tabular-vs-nested decision based on the
order it sees. `PerturbUniformity` hunts in exactly that gap.

## Reproducibility & provenance

A case's identity is `(seed file, rngSeed, maxOps)`. `generateCase` is pure over
those, so `replay-case.ts` reproduces the exact bytes in a fresh process — the
basis for a fileable upstream issue. Each case carries a provenance record
`{seed, rngSeed, pipeline:[{op,detail}]}`. That record is load-bearing twice over:
the **shrinker** (next milestone) reduces a failure by pruning this pipeline, and
v0.3's provenance-grouped corpus consumes it directly.

## Files

- `model.ts` — lexeme-faithful value tree (`GNode`, `RawNum`) + `parse`.
- `emit.ts` — `GNode` → valid JSON text, number- and key-order-faithful.
- `prng.ts` — deterministic mulberry32.
- `operators.ts` — the 10 operators + path addressing.
- `generate.ts` — recipe/provenance + pure `generateCase` / `replay`.
- `cli.ts` — `preview` / `write` (no adapters needed; runs anywhere).
- `fuzz.ts` — streams generated cases through the differential matrix
  (**full env**: needs the TOON impls, like the Rust adapter track).
- `replay-case.ts` — reproduce one case from its identity.
- `selftest-emit.ts`, `selftest-operators.ts` — proofs, judged by the oracle.

## Run

```
# proofs (no external deps — the oracle is pure):
node --experimental-strip-types gen/selftest-emit.ts
node --experimental-strip-types gen/selftest-operators.ts

# see / persist generated cases (no adapters needed):
node --experimental-strip-types gen/cli.ts preview --per 3
node --experimental-strip-types gen/cli.ts write   --per 20   # -> probe/generated/

# fuzz the matrix (full env: TOON impls installed):
node --experimental-strip-types gen/fuzz.ts --per 200
```

## Not in this milestone

- **Shrinker** — delta-reduction of a failing case to a minimal reproducer, with
  its own self-test proving reduction preserves the failure. Next.
- **From-scratch generation** — deferred; mutation-first covers the fault lines.
- **Rust adapter** — separate track (needs cargo + network; run in a Codespace).
