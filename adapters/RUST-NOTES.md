# Rust adapter track

Adds a third number model (`i64/u64/f64`) to the matrix, turning 2×2 into 3×3
and adding a whole row/column of handoffs where round-trip bugs hide. Targets the
official implementation: **`toon-format/toon-rust`** (crate `toon-format`, import
`toon_format`), MIT, same org as the TS reference and the Python impl.

## Pieces (mirror the Python two-file pattern)

- `rust-bridge/` — a small Cargo binary, the analogue of `adapter.py`. Two modes:
  one-shot (`toon-bridge encode|decode`) and `serve` (NDJSON loop). It depends on
  the `toon-format` crate and does the text↔`serde_json::Value`↔TOON conversions.
- `rust.ts` — one-shot adapter, spawns the compiled binary per call (analogue of
  `python.ts`).
- `rust-persistent.ts` — one `toon-bridge serve` process for a whole sweep
  (analogue of `python-persistent.ts`), same FIFO-queue / line-buffer / lifecycle
  machinery.
- `selftest-parity-rust.ts` — proves persistent == one-shot byte-for-byte before
  any big run trusts the persistent path (analogue of `selftest-parity.ts`).

## Two deliberate `serde_json` feature choices

The bridge builds `serde_json` with **`preserve_order` ON** and
**`arbitrary_precision` OFF**. Both matter for harness integrity:

- **`preserve_order` ON.** Default `serde_json` backs objects with a `BTreeMap`
  and *sorts keys* on `from_str`. That would feed toon-format's encoder sorted
  keys while the TS/Python adapters feed insertion order — contaminating the exact
  key-order fault line `PerturbUniformity` targets (see `gen/DESIGN.md`: the oracle
  treats key orderings as value-equal, but an *encoder* may pick tabular-vs-nested
  differently based on the order it sees). With `preserve_order`, input order
  reaches the encoder intact, matching the other two adapters.

- **`arbitrary_precision` OFF.** `i64/u64/f64` *is* the Rust number model we want
  in the matrix (the README's whole reason for adding Rust). A number beyond u64
  range loses precision at `serde_json::from_str` — which is exactly what a real
  `from_str → encode_default` user's pipeline does, and is symmetric to the TS
  adapter losing `> 2^53` at `JSON.parse`. Turning `arbitrary_precision` on to
  "protect" the boundary would (a) hide the real model difference and (b) perturb
  toon-format's own internals via Cargo feature unification. The oracle and
  shrinker already attribute input-parse loss correctly, so this loss is a real,
  reportable finding — not a harness artifact.

## Decode posture

The bridge decodes with `decode_default` = `DecodeOptions::default()` =
`strict=true, coerce_types=true`, the spec-faithful decoder — the same "library
default, no options" posture the TS and Python adapters use. Coercion
(unquoted `true`→bool, `"true"`→string) is what the oracle's type-strictness is
meant to catch when quoting diverges across impls.

Expect one category of finding from strictness: if TS/Python decode leniently by
default and Rust strict-rejects a slightly off-spec TOON string, that surfaces as
`ts→rust` / `py→rust` errors. That is a legitimate strictness divergence, not a
harness bug. Eyeball the first sweep's rejections before deciding whether to add a
`--no-strict` Rust variant (`DecodeOptions::new().with_strict(false)`); it's
deferred on purpose because the decision depends on real output.

## Calibration: real conformance divergence vs stale-impl noise

`toon-format/toon-rust` v0.5.0 badges **spec v3.0** and vendors the spec as a
submodule pinned at commit `57d713a`. The current published spec is **v3.3
(2026-05-20)**; the TS reference and Python impl track newer. So a Rust-involving
matrix divergence can be a real bug OR just the version skew. The spec's
language-agnostic fixtures are the tiebreaker — run them via toon-rust's own
`spec_fixtures` test, OUTSIDE toon-diff (they're single-impl conformance; toon-diff
stays differential per the ROADMAP):

```bash
git clone https://github.com/toon-format/toon-rust && cd toon-rust
git submodule update --init --recursive
git -C spec rev-parse HEAD                 # confirm 57d713a…
grep -m1 -i version spec/SPEC.md           # spec version it targets
cargo test --test spec_fixtures -- --nocapture   # (1) passes its OWN target spec?
cd spec && git fetch origin main
git diff --stat HEAD origin/main -- tests/fixtures/   # (2) what changed since?
```

Bucketing a shrunk finding:

- fails `spec_fixtures` at `57d713a` → real toon-rust bug even vs its own target → fileable against toon-rust.
- passes at `57d713a`, but the fixture changed between `57d713a` and `main` → version skew (stale-impl noise); not a toon-rust defect.
- passes at both, matrix still diverges → genuine cross-impl behavior the fixtures don't pin down — the interesting differential zone.

## Build & run (macOS, Node 24, stable Rust)

```bash
# 1. build the bridge (the gate that confirms v0.5.0's API surface)
(cd adapters/rust-bridge && cargo build --release)

# 2. smoke test both modes
echo '{"a":1}' | adapters/rust-bridge/target/release/toon-bridge encode
printf '%s' 'a: 1' | adapters/rust-bridge/target/release/toon-bridge decode
printf '%s\n' '{"op":"encode","data":"{\"a\":1}"}' | adapters/rust-bridge/target/release/toon-bridge serve

# 3. prove persistent == one-shot before trusting sweeps
node --experimental-strip-types adapters/selftest-parity-rust.ts

# 4. run the matrix (after wiring rust into cli-v2.ts / gen/fuzz.ts)
node --experimental-strip-types cli-v2.ts
node --experimental-strip-types gen/fuzz.ts --per 200
```

`$TOON_RUST_BRIDGE` overrides the binary path if you build elsewhere.
