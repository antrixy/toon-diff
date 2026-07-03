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

## Now — v0.2 (make it a real fuzzer)

- **Probe generator. [DONE — gen/]** Mutates the seed corpus along documented
  fault lines via 10 structure-aware operators, prioritizing the flat/wide/
  large-table shapes the ecosystem under-tests (toon#310). Numbers are captured
  at their exact lexeme, so nothing is corrupted on ingestion — proven against the
  oracle in gen/selftest-*.ts. Every case is deterministic and carries provenance
  `(seed, rngSeed, pipeline)`, replayable byte-for-byte via gen/replay-case.ts.
  Turns "inputs a person hand-wrote" into "inputs nobody wrote."
  *(Trust — wider input space, same proven judge.)*
- **Failure shrinking. [NEXT]** Reduce any failing case to a minimal reproducer
  via delta reduction, with a self-test proving the shrinker preserves the
  failure. A 600 KB failure should collapse to `{"value": 9007199254740993}`.
  The generator's recorded pipeline is the reduction axis. *(Understanding.)*
- **Rust adapter (`serde_toon`).** A third number model (`i64/u64/f64`) turns
  the matrix into 3×3 and adds a whole row/column of handoffs where divergences
  hide. *(Adoption + Trust.)*
- **Tagline, stated in the README:**
  *Independent implementations. Independent oracle. Deterministic verdict.*

## Next — v0.3 (make failures teach)

- **Corpus organized by provenance.** Group cases by where they came from —
  `probe/cases/{spec,regressions,generated,community}/` — and have each case
  carry a one-line note answering: where did it come from, and what invariant
  does it protect? A spec example, a preserved past bug, and a fuzz-generated
  case are different things, and a contributor should be able to tell which they
  are adding. Over time this makes the corpus a historical record of the
  specification, and gives every fixed upstream bug a regression that can never
  silently return. *(Adoption + Understanding.)*
- **Explained failures.** Report *what* diverged and *which spec section* it
  touches — e.g. "numeric precision, §2, encoder-side, IEEE-754 truncation."
  State the observation and the clause; do **not** prescribe a fix (see below).
  *(Understanding.)*
- **Full N×N matrix report.** Render the per-pair grid so the *shape* of the
  failures reads at a glance (diagonal fail = capability limit; single
  off-diagonal = handoff bug). *(Understanding.)*

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
