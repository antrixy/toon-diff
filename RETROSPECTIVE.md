# Retrospective: three implementations, seven divergences, one moving spec

*toon-diff v0.1 → v0.3, June–July 2026*

[TOON](https://github.com/toon-format/spec) promises lossless round-trips and
has official implementations in TypeScript, Python, and Rust — three codebases,
three number models (f64, arbitrary-precision int, i64/u64/f64), one
fast-moving spec (v1.0 → v3.0 in roughly a month; v3.3 at time of writing).
toon-diff asks the only question that setup demands:

```
decode_Y( encode_X( value ) )  ==  value      for every ordered pair (X, Y)
```

No blessed fixtures, no opinion about which implementation is right. Just: do
they agree? This document is the honest record of what that question surfaced
over three releases — the bugs, the harness bugs, and the process that kept
the two distinguishable.

## The current picture, one screen

13 hand-designed seed cases × 9 ordered pairs = 117 round-trip checks. Seven
divergences, every one explained:

```
GRID (encoder row → decoder col): divergent cases per pair, of 13
  enc\dec  ts  python  rust
  ts        1       2     2
  python    1       ·     ·
  rust      1       ·     ·

BY CASE (✗ value-mismatch, E error):
  seeds/002-empty-array.json
    enc\dec  ts  python  rust
    ts        ·       ✗     E
  seeds/013-precision-loss-2pow53plus1.json
    enc\dec  ts  python  rust
    ts        ✗       ✗     ✗
    python    ✗       ·     ·
    rust      ✗       ·     ·
```

Two shapes, visible at a glance. Case 013 (`2^53+1`) divergences form a cross
through the TS row and column — the JS f64 path rounds `9007199254740993` to
`…992` at `JSON.parse`, so every pair touching TS loses the integer, while
python↔rust round-trips it cleanly. Case 002 (`[]`) divergences sit only in the
python and rust *decoder* columns — and the two failures differ in kind: the
Python decoder silently returns the corrupted string `"[]"`
([toon-python#61](https://github.com/toon-format/toon-python/issues/61)), the
Rust decoder rejects loudly with a parse error. Silent corruption and loud
rejection are different severities, and the report says which is which.

Beyond the curated matrix, a mutation fuzzer runs the same invariant over
generated inputs: at the default `--per 30`, 403 cases / 806 checks / 0
mismatches across the python and rust bridges — the divergences above are the
real disagreement surface, not noise.

## Lesson one: the harness is an implementation too

The v0.1 comparator corrupted numbers *while comparing them*. Native
`JSON.parse` rounds `2^53+1` the same way the TS implementation under test
does — so the most important case in the corpus would have compared equal for
the wrong reason, a false PASS on exactly the bug the tool exists to find.
v0.1 shipped with that case quarantined rather than mistested.

The v2 oracle ingests numbers at their exact source lexeme (ES2023
`ctx.source`), never through an f64, and is proven by a selftest
(`oracle/selftest-numbers.ts`) that requires no TOON implementation at all —
the oracle must be trusted before any cross-implementation claim built on it.
`cli-v2` still prints which cases v1 would have quarantined, as a permanent
reminder that the harness lies the same way implementations do unless you
prove otherwise.

## The findings, with their upstream trails

Every finding below was surfaced by the differential matrix or the mutation
operators, minimized, and filed or escalated upstream with reproduction and
spec citations.

**Empty arrays, and a spec that moved
([toon#322](https://github.com/toon-format/toon/issues/322)).** Filed against
spec v3.0, where §9.1 required the `[0]:` zero-length-header form; the TS
encoder emitted bare `[]`, which the Python decoder silently corrupted and the
Rust decoder rejected. The issue's cross-implementation table — one input,
three official implementations, three different outcomes — became the
load-bearing evidence in the thread. Then the spec moved underneath the issue:
v3.1 introduced `[]` as a canonical form, and v3.3 blessed it as the SHOULD
form with decoders required to accept both. The issue closed in July 2026 as
resolved-by-spec: the encoder was legitimized, the decoder obligation
hardened, and the cross-impl concern explicitly stands until the ports catch
up ([toon-python#61](https://github.com/toon-format/toon-python/issues/61);
Rust via [toon-rust PR #71](https://github.com/toon-format/toon-rust/pull/71)).
A finding can be correct and still be resolved by the spec choosing the other
side of the wire. Differential evidence survives that outcome; a clause-based
argument alone would not have.

**An encoder its own decoder rejects
([toon-rust#74](https://github.com/toon-format/toon-rust/issues/74)).** The
Rust encoder emits a tabular header with an empty field list (`[1]{}:`) for
arrays of empty objects — grammar its own strict decoder refuses. Same-
implementation round-trip failure, found by crossing it anyway.

**Silent key drop
([toon-python#64](https://github.com/toon-format/toon-python/issues/64)).**
The Python encoder silently drops an empty-string key when its value is
non-primitive. No error, one key fewer.

**Quoted-scalar lookalikes and the count-match variant
([toon#324](https://github.com/toon-format/toon/issues/324)).** A quoted
string whose content *looks like* an array header breaks the TS decoder's
scan of the encoder's own output — with a silent-corruption variant when the
fake header's item count happens to match the comma-split count, so the
mis-parse raises no error at all. The escalation argued from the spec's own
text (quoted content is never structural, §4/§6; count checks may not
adjudicate syntax, §14.2; the quoting rules are the spec's stated injection
mitigation, §15 — inverted by scanning inside quotes). Maintainer triage
adopted that framing: the fix direction is quote-aware opacity superseding the
existing heuristics, and the count-matching variant now has its own
regression-test acceptance criterion.

**Claimed-version skew
([toon-python#76](https://github.com/toon-format/toon-python/issues/76),
[toon-rust#76](https://github.com/toon-format/toon-rust/issues/76)).** Both
decoders reject the `[]` form introduced in spec v3.1 — but they claim
different things. Rust pins v3.0, which *predates* the rule; Python claims no
version at all. That difference matters for what the divergence means, which
is the subject of the next section.

## Lesson two: a divergence is evidence, not a verdict

v0.3's thesis. Two implementations disagreeing tells you something is wrong;
it does not tell you *who* is wrong, or wrong *by whose standard*. The
explained-failures layer answers that with machinery instead of vibes:

Each corpus case may reference spec rules in a registry
(`probe/spec-rules.ts`). A rule carries the spec sections that govern it, the
CHANGELOG entry that introduced it, and which side it constrains — a decoder
rule never indicts the encoder. Implementations carry their own claimed spec
versions with evidence and browser-verification dates (`IMPL_CLAIMS`). The
verdict for each constrained side is then a total function: an implementation
claiming a version *older* than the rule is **behind** it, not violating it;
claiming a version that includes the rule **violates its own claim**; claiming
nothing is measured against the **current spec**.

On the real matrix that yields: for 002, Rust (claims 3.0) is *behind* the
v3.1 `[]` rule — defensible strict-mode behavior, which is why toon-rust#74
was explicitly scoped as not-a-bug-report against the decoder — while Python
(claims nothing) *violates current spec 3.3*. Same divergence, different
verdicts, both cited to sections and changelog dates.

Two honesty mechanisms keep the citations trustworthy. Rules whose sections
haven't been verified against the live spec are stubs: legal in the registry,
fenced from citation, rendered as `PENDING`. And claims are a *parameter* —
the post-PR-#71 world (Rust at 3.3, its verdict flipping to violates-claimed)
is tested today, before the merge exists.

## Lesson three: operators find classes, not cases

The v0.2 generator mutates the 13 seeds along documented fault lines, every
case deterministic and replayable
(`gen/replay-case.ts <seed> <rngSeed> [maxOps]`), with a non-contiguous ddmin
shrinker that reduces failures without slipping between bugs. The proof it
earns its keep: the structural-lookalike operators (`LookalikeInject`,
`EmptyKeyNonPrimitive`) autonomously rediscover the toon#324 and
toon-python#64 fault classes from scratch. That's the difference between a
regression test (this input stays fixed) and a regression *detector* (this
class of input stays fixed) — the count-match silent-corruption variant that
anchored the #324 escalation came out of exactly that loop.

## Lesson four: verification is a workflow, not a virtue

Two recon errors happened in this project, and the interesting part is how
differently they were caught.

The first: Rust's claimed spec version was recorded as 3.2 from early recon.
Browser verification of the actual README said v3.0. The fix introduced
`IMPL_CLAIMS` — every claim now carries its evidence string and the date it
was last verified in a browser, and a selftest pins the derivation so the
adapter-facing shape can never drift from the source of truth.

The second: the integer-precision rule's refs pointed at toon#322 — which
browser verification (during the issue's closure, of all moments) revealed to
be the *empty-array* issue. A copy-paste slip. No upstream issue for the
2^53+1 finding exists at all. The correction moved the ref where it belonged
and — because two selftests deliberately pin every ref — could not land
without flipping those pins in the same change. The tripwires exist precisely
because the first error proved recon errors recur.

The standing rules that fell out of this, all learned the expensive way:
automated fetches of GitHub and spec content silently return stale or empty
results, so issue state and spec text are only trusted from a browser; file
sync is done by curling individual committed files with line-count
verification against the staged originals; selftest counts are pinned and
treated as promotion tripwires, so a stub becoming citable or a ref changing
is a deliberate, visible act.

## What's watched, what's next

Open threads with defined outcomes: [toon-rust PR
#71](https://github.com/toon-format/toon-rust/pull/71) merging should clear
002's two divergences (new baseline: 5, all 013) and trip the `IMPL_CLAIMS`
selftest until Rust's claim is re-verified; the toon#324 fix landing changes
the lookalike fault class in TS, with its minimal case queued for promotion
into `probe/cases/regressions/`. The 2^53+1 finding is now filed as
[toon#329](https://github.com/toon-format/toon/issues/329) — anchored, per
the #322 lesson, to observed round-trip corruption. The spec deep-dive that
shaped it found §2/§4 *permit* documented approximation; the nonconformance
is the absence of a documented decoder out-of-range policy, which §4 makes a
MUST — while the implementation's own docs claim lossless round-trips and its
encoder already handles the same values losslessly.

And one external signal worth recording: the toon#324 thread is now cited by
an independent fixtures corpus
([reddb-io/toon#84](https://github.com/reddb-io/toon/issues/84)) as
complementary evidence — the findings have started to be load-bearing for
work that isn't this project.

## The through-line

Every serious finding here is silent: an integer that rounds without an
error, a string that comes back subtly different, a key that vanishes, a
quoted scalar that parses as structure when the counts happen to agree. Loud
failures get fixed because they announce themselves. Silent ones get fixed
when something crosses two implementations and checks. That's the whole tool.

---

*Versions at time of writing: `@toon-format/toon` 2.3.0 (TS), `toon_format`
0.9.0b1 (Python, git e475c82), `toon-format` 0.5.0 (Rust crate). Spec v3.3.
Matrix baseline: 13 cases, 117 pair-checks, 7 divergences, 7 explained.*
