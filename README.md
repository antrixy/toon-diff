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
they tend to be **silent** — wrong data with no error raised. From the first real
run against two published implementations, two such bugs:

| Case | What happens | Filed upstream |
|---|---|---|
| Integer `2^53 + 1` | TS path silently rounds `9007199254740993` → `…992`; Python preserves it. Each side round-trips its own value; only crossing them reveals the loss | spec §2 permits precision loss for out-of-range numbers *if documented* — tracked, not yet filed |
| Empty array `[]` | TS encodes `[]` (non-canonical); Python's decoder returns the string `'['`, dropping a char; canonical is `[0]:`. Each decoder reads its own encoder's output fine | encoder: [toon#322](https://github.com/toon-format/toon/issues/322) · decoder: [toon-python#61](https://github.com/toon-format/toon-python/issues/61) |

Both are **silent corruption** — the through-line of the project. A wrong value
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
cli-v2.ts              # runs the N×N differential matrix over the corpus
oracle/
  ingest.ts            # v2 lossless number-faithful ingestion + canonical compare
  compare.ts           # v1 comparator + ingestionFidelity (used for the v1-vs-v2 note)
  canonicalize.ts      # v1 canonical form (key sort, type-strict equality)
  selftest.ts          # proves the v1 oracle
  selftest-numbers.ts  # proves the v2 oracle, no implementation needed
adapters/
  contract.ts          # one text-in/text-out protocol per implementation
  ts.ts                # @toon-format/toon (reference TS/JS)
  python.ts            # toon_format (official Python)
probe/cases/           # 13 hand-designed cases targeting known fault lines
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

## Status

Early. The corpus is 13 hand-designed probes, not yet a generative fuzzer; the
roadmap is a mutation-based generator with shrinking, plus Rust and additional
adapters. Findings are filed upstream against the individual implementations
([toon#322](https://github.com/toon-format/toon/issues/322),
[toon-python#61](https://github.com/toon-format/toon-python/issues/61)).

## License

MIT — see [LICENSE](./LICENSE).
