# toon-diff

A differential conformance tester for [TOON](https://github.com/toon-format/spec)
(Token-Oriented Object Notation) implementations.

TOON promises **lossless** round-trips: `JSON → TOON → JSON` should return what
you started with. Independent implementations exist in 25+ languages. This tool
checks whether they actually agree — by running data through one implementation's
encoder and a *different* implementation's decoder, and verifying the round-trip
survived.

```
decode_Y( encode_X( value ) )  ==  value     for every ordered pair (X, Y)
```

It is **not** a fixtures/conformance suite (which checks one implementation
against blessed expected outputs). It checks implementations against *each other*,
on inputs no fixture anticipated — which is where silent disagreements hide.

## Why this catches what conformance suites miss

Every implementation round-trips its *own* output fine, so single-implementation
testing looks green. The bugs live at the boundary between implementations, and
they tend to be **silent** — wrong data with no error raised. Findings from
running the three official implementations against each other:

| Case | What happens | Upstream trail |
|---|---|---|
| Integer `2^53 + 1` | TS path silently rounds `9007199254740993` → `…992` at `JSON.parse`; Python and Rust preserve it. Every TS-involving pair loses the integer; each side round-trips its own value fine | no issue filed yet — spec §2 permits precision loss *if documented*; filing under consideration |
| Empty array `[]` | TS emits bare `[]` (now the spec-v3.3 SHOULD form); Python's decoder silently returns the *string* `"[]"`, Rust's rejects with a parse error. Each decoder reads its own encoder's output fine | encoder: [toon#322](https://github.com/toon-format/toon/issues/322) (closed — resolved by spec v3.3) · decoders: [toon-python#61](https://github.com/toon-format/toon-python/issues/61), [toon-rust PR #71](https://github.com/toon-format/toon-rust/pull/71) |
| Quoted structural lookalikes | A quoted string shaped like an array header (`"[2]:"`) breaks the TS decoder's scan of its own encoder's output — silently, when the fake header's item count matches | [toon#324](https://github.com/toon-format/toon/issues/324) (escalated; quote-aware fix direction adopted in triage) |

More findings — a Rust encoder emitting grammar its own decoder rejects
([toon-rust#74](https://github.com/toon-format/toon-rust/issues/74)), a Python
encoder silently dropping an empty-string key
([toon-python#64](https://github.com/toon-format/toon-python/issues/64)) —
with full trails in [RETROSPECTIVE.md](./RETROSPECTIVE.md).

All of it is **silent corruption** — the through-line of the project. A wrong value
that flows downstream with no signal is more dangerous than a thrown error, and
it is exactly what a differential cross-decode surfaces and a same-implementation
test cannot.

## The oracle is the hard part

A naive comparator corrupts numbers while comparing them (native `JSON.parse`
rounds `2^53+1`), and would report a false PASS on the most important case. The
oracle here:

- ingests numbers at their **exact source lexeme** (ES2023 `ctx.source`), never
  via an `f64`, so arbitrary-precision integers survive the comparison;
- compares by **value** (`1.0 == 1`, `-0 == 0`) with exact integer precision
  (`2^53+1 != 2^53`);
- is **type-strict** (`"123" != 123`), order-sensitive for arrays, distinguishes
  missing-key from explicit-null, and applies **no** Unicode normalization
  (`e + U+0301 != U+00E9`).

It is proven independent of any TOON implementation by a self-test
(`oracle/selftest-numbers.ts`) before any cross-implementation comparison runs.

## Layout

```
cli-v2.ts              # runs the N×N differential matrix: grid overview,
                       #   divergence detail, spec-cited explanations
oracle/
  ingest.ts            # v2 lossless number-faithful ingestion + canonical compare
  selftest-numbers.ts  # proves the v2 oracle, no implementation needed
adapters/
  contract.ts          # one text-in/text-out protocol per implementation, plus
                       #   IMPL_CLAIMS: each impl's claimed spec version, with
                       #   evidence and browser-verification date
  ts.ts / python.ts / rust.ts        # the three official implementations
gen/                   # deterministic mutation generator, fuzz loop over the
                       #   matrix, non-contiguous ddmin shrinker, case replay
probe/
  cases/               # corpus by provenance: seeds/ spec/ regressions/
                       #   generated/ community/ — each case NNN-name.json +
                       #   NNN-name.meta.json (origin + invariant + spec rules)
  spec-rules.ts        # rule registry: spec sections, changelog entry that
                       #   introduced the rule, which side it constrains
  explain.ts           # divergence -> rule -> citation -> per-side verdict
  grid.ts              # N×N grid report (aggregate + per divergent case)
```

Adding an implementation is one `Adapter` (text in, text out). More
implementations with different number/string models = more divergences surfaced;
TS (f64), Python (arbitrary-precision int), and Rust (i64/u64/f64) span three
distinct number models, which is where round-trip bugs concentrate.

## Run

```bash
npm install @toon-format/toon
pip install git+https://github.com/toon-format/toon-python.git   # use a venv
npm pkg set type=module
node --experimental-strip-types oracle/selftest-numbers.ts       # prove the oracle
node --experimental-strip-types cli-v2.ts                        # run the matrix
```

The Rust adapter needs its bridge built once (cargo); full environment and
selftest walkthrough in [RUN.md](./RUN.md).

## Status

v0.3. The corpus lives in provenance buckets with 13 hand-designed seeds as
the mutation substrate; a deterministic generator with a ddmin shrinker fuzzes
the matrix (v0.2); divergences are *explained* — spec-rule citations,
changelog dates, and a per-side verdict (behind / violates-claimed /
violates-current, computed from each implementation's own claimed spec
version) — and summarized in an N×N grid (v0.3).

Current baseline: 13 cases, 117 pair-checks, 7 divergences, 7 explained.
Watched upstream: [toon-rust PR #71](https://github.com/toon-format/toon-rust/pull/71)
(clears the empty-array divergences on merge) and
[toon#324](https://github.com/toon-format/toon/issues/324) (quoted-scalar fix
direction adopted in triage).

The full story — findings, upstream trails, and the lessons — is in
[RETROSPECTIVE.md](./RETROSPECTIVE.md).

## License

MIT — see [LICENSE](./LICENSE).
