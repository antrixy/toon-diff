# Roadmap

## The filter

Every feature must strengthen one of these three pillars. If it doesn't, it
doesn't belong here — no matter how appealing it is on its own.

1. **Independent oracle** — make the verdict more *trustworthy*.
2. **Informative verdict** — make a failure more *useful* to whoever has to fix it.
3. **Adoption** — make it *easier* to put another implementation in the matrix.

`toon-diff` is a conformance suite, not a testing framework. The scope is
deliberately narrow. Narrowness is the moat.

## Now — v0.2 (make it a real fuzzer)

- **Probe generator.** Mutate the seed corpus along documented fault lines
  (boundary integers, delimiter-adjacent strings, near-uniform tables, empty
  containers). Turns "inputs a person hand-wrote" into "inputs nobody wrote."
  *(pillar: trustworthy oracle — wider input space, same judge.)*
- **Failure shrinking.** Reduce any failing case to a minimal reproducer via
  delta reduction, with a self-test proving the shrinker preserves the failure.
  A 600 KB failure should collapse to `{"value": 9007199254740993}`.
  *(pillar: informative verdict.)*
- **Rust adapter (`serde_toon`).** A third number model (`i64/u64/f64`) turns
  the matrix into 3×3 and adds a whole row/column of handoffs where divergences
  hide. *(pillar: adoption + trustworthy oracle.)*
- **Tagline, stated in the README:**
  *Independent implementations. Independent oracle. Deterministic verdict.*

## Next — v0.3 (make failures teach)

- **Categorized corpus.** `probe/cases/{integers,unicode,arrays,limits,malformed,
  regression}/` so contributors know exactly where to add a case, and a
  regression file per fixed upstream bug so it can never silently return.
  *(pillar: adoption.)*
- **Explained failures.** Report *what* diverged and *which spec section* it
  touches — e.g. "numeric precision, §2, encoder-side, IEEE-754 truncation."
  State the observation and the clause; do **not** prescribe a fix (see below).
  *(pillar: informative verdict.)*
- **Full N×N matrix report.** Render the per-pair grid so the *shape* of the
  failures reads at a glance (diagonal fail = capability limit; single
  off-diagonal = handoff bug). *(pillar: informative verdict.)*

## Later — conditional on actual use, not built on spec

Pull these forward only when someone using the tool asks for them. Building them
before there's demand is how a focused tool turns into an unfinished platform.

- Spec-coverage tracking (which normative clauses have a probe exercising them).
- Historical conformance trend per implementation.
- Stable, documented adapter API (freeze it once a third party has written one).

## Not building

Recorded so the scope stays honest. Each of these fails the filter or the
solo-maintainer test.

- **Performance / profiling mode.** Encode speed and peak RSS are a different
  axis from conformance. Strengthens none of the three pillars.
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
