# I filed a bug. The spec moved. The bug closed as "resolved" — and the finding still mattered.

*Published at https://dev.to/maverickyadav/differential-testing-found-bugs-in-all-three-official-toon-implementations-and-outlived-a-moving-1mp8 (2026-07-16) under the title "Differential testing found bugs in all three official TOON implementations — and outlived a moving spec" — that page is canonical.*

In late June I filed [toon#322](https://github.com/toon-format/toon/issues/322)
against the reference TypeScript implementation of
[TOON](https://github.com/toon-format/spec), a serialization format that
promises lossless round-trips. The bug: the encoder emitted a bare `[]` for
empty arrays, where spec v3.0 §9.1 required an explicit zero-length header,
`[0]:`. Clean report — spec quote, failing test case, versions.

Two weeks later the issue closed. Not because the encoder changed. Because the
*spec* did: v3.1 introduced `[]` as a canonical form, v3.3 blessed it as the
SHOULD form. My clause citation was mooted by two spec revisions filed after
the report.

Here's the part that makes this a story worth telling instead of a complaint:
the finding survived anyway — because the report didn't rest on the clause.

## Differential evidence outlives clause readings

The bug came out of [toon-diff](https://github.com/antrixy/toon-diff), a
differential conformance fuzzer I've been building. It has no opinion about
what's correct. It runs data through one implementation's encoder and a
*different* implementation's decoder, for every ordered pair, and checks the
round-trip survived:

```
decode_Y( encode_X( value ) )  ==  value
```

So the #322 report carried, alongside the clause citation, a
cross-implementation table: the same input `[]` through all three official
implementations. TS→TS round-trips. TS→Python silently returns the corrupted
*string* `"[]"`. TS→Rust throws a parse error. One input, three official
implementations, three different outcomes.

When the spec moved, the clause argument evaporated — but that table didn't.
The closure itself says so: the encoder is now compliant, *and* the cross-impl
concern "stands until the ports catch up." The spec legitimized one side of
the wire and hardened the obligation on the other (decoders MUST now accept
both forms). The evidence determined which side got fixed; a clause reading
alone would have just been wrong twice.

For a fast-moving format — TOON went v1.0 → v3.0 in about a month — that's
the durable way to file bugs: anchor to observed round-trip corruption, cite
clauses as supporting context.

## What the matrix actually found

Thirteen hand-designed seed cases, nine ordered pairs, 117 checks, seven
divergences. The whole disagreement surface fits on one screen:

```
GRID (encoder row → decoder col): divergent cases per pair, of 13
  enc\dec  ts  python  rust
  ts        1       2     2
  python    1       ·     ·
  rust      1       ·     ·
```

That cross through the TS row and column is `2^53+1`: JavaScript's f64 rounds
`9007199254740993` to `…992` at `JSON.parse`, so every pair touching TS
silently loses the integer — while Python↔Rust round-trips it perfectly. Each
implementation round-trips its *own* output fine. That's why
single-implementation test suites stay green while this class of bug ships:
the failures live at the boundary between implementations, and they're
silent. A wrong value with no error is worse than a crash, and it's exactly
what crossing implementations surfaces. (That finding is now filed as
[toon#329](https://github.com/toon-format/toon/issues/329) — a spec
deep-dive showed the sharpest form is decoder-side: `decode()` silently
approximates valid wire tokens with no documented out-of-range policy,
which the spec makes a MUST.)

Other findings from the same loop, all filed upstream with minimized repros:
a Rust encoder emitting grammar its own decoder rejects
([toon-rust#74](https://github.com/toon-format/toon-rust/issues/74)), a
Python encoder silently dropping a key
([toon-python#64](https://github.com/toon-format/toon-python/issues/64)), and
a TS decoder that parses *quoted string content* as structure when a fake
array header's item count happens to match — silent corruption with no error
raised ([toon#324](https://github.com/toon-format/toon/issues/324)). That
last escalation argued from the spec's own security model, and the
maintainers' triage adopted the framing: quote-aware opacity as the fix
direction, with the count-match variant getting its own regression-test
acceptance criterion.

## A divergence is evidence, not a verdict

The subtle discipline: two implementations disagreeing doesn't tell you who's
wrong, or wrong by whose standard. Rust's decoder rejects `[]` — but Rust
pins spec v3.0, which *predates* the `[]` rule. It isn't violating its claim;
it's behind it. Python claims no version at all, so it's measured against the
current spec — and violates it. Same divergence, different verdicts.

toon-diff encodes that distinction as machinery: implementations carry their
claimed spec versions with evidence and verification dates; spec rules carry
the sections and changelog entries that introduced them; verdicts —
*behind*, *violates-claimed*, *violates-current* — are computed per
constrained side, and a decoder rule never indicts the encoder. Rules whose
sections I haven't verified against the live spec render as
citation-`PENDING` rather than pretending. The tool doesn't just find
disagreements; it says what they mean, and shows its work.

## Two bugs in my own harness

Honesty section. The v0.1 comparator corrupted `2^53+1` the same way the TS
implementation does — native `JSON.parse` — so the most important case in the
corpus would have false-PASSed. The fix was a lossless oracle that ingests
numbers at their exact source lexeme, proven by a selftest before any
cross-implementation claim runs. Your test harness is an implementation too,
and it lies the same way until you prove otherwise.

And twice I recorded upstream facts wrong from early recon — a claimed spec
version, an issue reference. Both were caught by browser verification, and
both fixes added tripwires: every upstream claim in the codebase now carries
its evidence and verification date, and selftests pin every reference so a
correction can't land halfway. Verification is a workflow, not a virtue.

## The through-line

Every serious finding here is silent: an integer that rounds without an
error, a string that comes back subtly different, a key that vanishes, quoted
data that parses as structure when the counts happen to agree. Loud failures
get fixed because they announce themselves. Silent ones get fixed when
something crosses two implementations and checks.

The full retrospective — with every finding's upstream trail, the verdict
machinery, and the fuzzing operators that rediscover known bug classes from
scratch — is in the repo:
[toon-diff/RETROSPECTIVE.md](https://github.com/antrixy/toon-diff/blob/main/RETROSPECTIVE.md).
