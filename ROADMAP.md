# Roadmap

## The filter

Every feature must strengthen one of these three goals. If it doesn't, it
doesn't belong here — no matter how appealing it is on its own. A feature that
only adds *capability*, without serving one of these, is the thing to be
skeptical of.

1. **Trust** — make the verdict more trustworthy.
   *(mechanism: an independent oracle, proven before any implementation runs.)*
2. **Understanding** — make a failure easier to understand and act on.
   *(mechanism: an informative verdict — what diverged, and which spec clause.)*
3. **Adoption** — make another implementation easier to put in the matrix.
   *(mechanism: the adapter experience — one small, text-in/text-out contract.)*

`toon-diff` is a conformance suite, not a testing framework. The scope is
deliberately narrow. Narrowness is the moat.

## Shipped

**v0.2 — make it a real fuzzer.** Probe generator (`gen/`): 10 structure-aware
operators mutating the seed corpus along documented fault lines, every case
deterministic and replayable byte-for-byte from `(seed, rngSeed, pipeline)`.
Failure shrinking (`gen/shrink*.ts`): 1-minimal reproducers by structure-aware
delta reduction, driven by a failure signature so reduction can't slip from one
bug to another. Rust adapter: a third number model (`i64/u64/f64`) turning the
matrix into 3×3.

**v0.3 — make failures teach.** Corpus organized by provenance, each case
carrying where it came from and what invariant it protects. A spec-rule registry
where every rule is citable and stubs are fenced. Explained failures mapping
each divergence to a rule, its clauses, and a per-side verdict. The N×N grid
report, so the *shape* of a failure reads at a glance. See `RETROSPECTIVE.md`
for what the v0.3 arc actually taught.

## Now — v0.4 (independent evidence)

**The blind spot.** Every wire in the matrix comes from some implementation's
encoder. If all implementations share the same wrong assumption — the usual way
being that ports copy the reference implementation's logic — then every
round-trip agrees, and toon-diff sees nothing. The tool's evidence is only as
independent as the implementations happen to be. 002 surfaced *because* the
ports did not copy TS; the cases where they do copy are exactly the ones this
design cannot reach.

That is not hypothetical. toon#329 (decoder silently approximates out-of-range
integers) is on track to be resolved by *documenting* the approximation. The
spec permits that. But once a loss is blessed by documentation on every side,
a pairwise round-trip fuzzer has nothing left to say about it — every pair
agrees. The only thing that can still say something true is an oracle built
from the specification's data model rather than from anyone's encoder.

> "evidence beats clause readings, but independent evidence beats consensus"
> — Viktor, on the v0.3 write-up. The blind spot above is his, named in a
> comment that also reported hitting it in practice: two parsers sharing a
> vendored tokenizer, agreeing with each other and with nothing else. The
> property-based layer below is his proposal. The `spec/` bucket is this
> project's answer built on top of it.

**The work.** Two pieces, both composing with the pairwise design rather than
replacing it. They differ in kind, and that difference is the point: the first
makes the *value* implementation-free, the second makes the *wire*
implementation-free — no encoder anywhere in the loop.

- **Property-based layer.** Generate values straight from the spec's data
  model, never through an implementation's encoder, so at least one side of
  every pair carries no inherited assumption. Cheapest of the two: it emits
  JSON values, which the existing corpus, matrix, and oracle already consume —
  the same shape `gen/` produces today. *(Trust.)*
- **Fill the `spec/` bucket.** Hand-built wire text derived directly from
  SPEC.md and checked decoder-side, so the input never passed through any
  encoder at all. Stronger evidence, and more work than "the bucket is wired
  and empty" suggests: today's case format is JSON-in/round-trip-out, so a
  wire-text case needs a second case shape, a per-implementation run path
  (N checks, not N×N), and a way to render a one-sided result. Modelling the
  spec itself as a pseudo-encoder makes that last part nearly free — the
  existing per-side verdict logic then applies unchanged. *(Trust.)*

**Shipped in v0.4 so far.** Per-side numeric-domain verdicts
(`probe/numeric-domain.ts`): §2's round-trip MUST is scoped to *in-domain*
values, and domain membership is per-implementation, so fault on 013 is now
attributed to the f64 side alone instead of indicting the two endpoints that
hold the value exactly. Encoder (§3+§2) and decoder (§4) documentation
obligations are judged independently — which is what lets the report say
"decoder satisfied, encoder still violating" after a decoder-only docs fix.
*(Understanding — and a prerequisite for the `spec/` bucket, since a
spec-derived case has only one implementation side to judge.)*

**Known fault line, not yet a case.** The u64 boundary separates rust
(`i64/u64` + f64 fallback) from python (arbitrary precision) — a real
divergence above 013's, and a natural first `spec/` resident.

## Later — conditional on actual use, not built on spec

Pull these forward only when someone using the tool asks for them. Building them
before there's demand is how a focused tool turns into an unfinished platform.

- Version axis: test multiple versions of each implementation, turning the
  matrix into when-did-this-break archaeology. Wants adapter version pinning and
  environment management — the expensive part.
- Fourth implementation (4×4 = 16 pairs). Survey community implementations by
  actual usage first.
- Spec-coverage tracking (which normative clauses have a probe exercising them).
- Historical conformance trend per implementation.
- Stable, documented adapter API (freeze it once a third party has written one).

## Not building

Recorded so the scope stays honest. Each of these fails the filter or the
solo-maintainer test.

- **Performance / profiling mode.** Encode speed and peak RSS are a different
  axis from conformance. Serves none of the three goals — pure capability.
- **Nightly ecosystem dashboard.** Cloning and running every implementation on a
  schedule is a second product with a permanent ops treadmill — the kind of
  thing an org runs, not a solo maintainer. Would consume the time that should
  go to the oracle.
- **Compatibility badges ("Verified by toon-diff").** An authority claim, not a
  feature. Only meaningful once the tool is already trusted, and it puts *your*
  credibility on the line if the oracle is ever wrong. Revisit post-1.0, if ever.
- **Auto-suggested fixes.** Prescribing the patch ("use BigInt") means being
  confidently wrong sometimes, which costs more than saying nothing. Explain the
  divergence; let the maintainer choose the fix.
- **Plugin system.** The domain is constrained on purpose. Keep it that way.

## The north star (an outcome, not a task)

Someday a new implementation's author asks not "did I implement TOON correctly?"
but "does it pass toon-diff?" That status is *earned* by being useful over time —
it can't be shipped as a feature. Everything above is in service of earning it.
