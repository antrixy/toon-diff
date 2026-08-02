# gen/ — the generators

Produces inputs nobody wrote, while keeping the same proven judge
(`oracle/ingest.ts`). Two generators, added in different milestones and answering
different questions:

- **Mutation (v0.2)** — every case is one of the 13 hand-written seeds with an
  ordered pipeline of operators applied.
- **Property (v0.4)** — every case is built from grammar productions, with no
  seed involved. Added for thesis D; see [The property layer](#the-property-layer-v04).

Both share `model.ts`, `emit.ts` and `prng.ts`, so the no-f64 invariant below is
one invariant, not two.

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
| 3 | `DelimiterInject` | delimiter/inline-vs-quoted string stress + partial lookalikes | 006, 007, 009 |
| 3 | `LookalikeInject` | COMPLETE structural-lookalike tokens in quoted scalars (toon#324 class) | 006, 007 + any string/object seed |
| 3 | `EmptyKeyNonPrimitive` | empty-string key over a non-primitive value (toon-python#64 class) | any object seed |
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
`{seed, rngSeed, pipeline:[{op,detail}]}`. That record is load-bearing for the
**shrinker** (shipped in v0.2, below), which reduces a failure by pruning this
pipeline and re-running.

Note what it is **not**. v0.3's corpus does **not** consume this record.
`probe/corpus.ts` validates a `.meta.json` sidecar of free-text `origin` /
`invariant` (plus optional `refs` / `specRules`), never imports `gen/`, and has
no field for a seed, an rngSeed or a pipeline. Corpus provenance is carried by
the bucket directory plus that prose line. Earlier text in this file, in
`generate.ts` and in `cli.ts` claimed direct consumption; it was never true.

## Files

- `model.ts` — lexeme-faithful value tree (`GNode`, `RawNum`) + `parse`.
- `emit.ts` — `GNode` → valid JSON text, number- and key-order-faithful.
- `prng.ts` — deterministic mulberry32.
- `operators.ts` — the 12 operators + path addressing.
- `generate.ts` — recipe/provenance + pure `generateCase` / `replay`.
- `cli.ts` — `preview` / `write` (no adapters needed; runs anywhere).
- `fuzz.ts` — streams generated cases through the differential matrix
  (**full env**: needs the TOON impls, like the Rust adapter track).
- `replay-case.ts` — reproduce one case from its identity (dispatches on the
  `mut:` / `prop:` prefix).
- `property.ts` — the v0.4 from-scratch generator: channels, archetypes, fuel,
  and the canonical weight configuration.
- `toon-surface.ts` — the eight TOON wire-syntax families as productions, plus
  `TOON_SURFACE_SPEC` and per-family basis. Mints string contents only; imports
  only `prng.ts`; imported by `property.ts`'s `surface-toon` channel and nothing
  else. The single place in the project that knows TOON syntax.
- `selftest-emit.ts`, `selftest-operators.ts`, `selftest-property.ts` — proofs,
  judged by the oracle.
- `selftest-cli-write.ts` — proves the `write` batch path: flat filenames,
  determinism, and replay of every manifest line to its written bytes. Spawns
  the real CLI rather than importing it.

## Run

```
# proofs (no external deps — the oracle is pure):
node --experimental-strip-types gen/selftest-emit.ts
node --experimental-strip-types gen/selftest-operators.ts
node --experimental-strip-types gen/selftest-cli-write.ts
node --experimental-strip-types gen/selftest-property.ts

# see / persist generated cases (no adapters needed):
node --experimental-strip-types gen/cli.ts preview --per 3
node --experimental-strip-types gen/cli.ts write   --per 20   # -> probe/generated/ (scratch)

# fuzz the matrix (full env: TOON impls installed):
node --experimental-strip-types gen/fuzz.ts --per 200
```

## The write path: one defect fixed, two deliberate

`write` persists a batch to gitignored scratch. It is **not** a corpus promotion
path, and never was.

- **FIXED — `write` crashed on the first case.** `seed.name` was the corpus
  `key`, which became bucket-prefixed in v0.3 (`seeds/001-empty-object.json`);
  `mkdirSync` created only the out dir, not the `seeds/` subdir that slash
  implies, so the first `writeFileSync` failed with ENOENT. The repair carries
  the loader's already-parsed `id` and `name` alongside `key`, so the replay
  identity and the output filename stop sharing a field. Covered by
  `selftest-cli-write.ts`, which spawns the real CLI — the defect lived in the
  entry point, so an in-process test of an imported function would not have
  caught it.
- **BY DESIGN — filenames are not corpus-legal.** `NNN-name-gNNNN.json` reuses
  the seed's three-digit id, and `loadCorpus` enforces per-bucket unique ids
  all-or-nothing. Scratch output does not need corpus-legal ids; the promotion
  command owns allocation, for both generators, once it exists.
- **OPEN — `provenance.jsonl` is write-only.** Nothing reads it: `fuzz.ts`
  generates in memory and `shrink-cli.ts --batch` reads a fuzz *output* file. It
  is a second metadata format that the `.meta.json` sidecar superseded. Retire it
  or give it a reader; the selftest currently pins it as a batch manifest whose
  `(seed, rngSeed, maxOps)` lines replay byte-for-byte.

## Shrinker (gen/shrink.ts, failure-signature.ts, shrink-cli.ts)

Reduces a failing case to a 1-minimal reproducer.

- **`shrink.ts`** — adapter-agnostic delta reduction over the lexeme-faithful tree
  (a number is never corrupted mid-reduction). Strategies, biggest-cut first:
  hoist a descendant up (peel layers), null out a subtree, ddmin arrays (chunk
  removal), delete a key/element, simplify a scalar. Repeats to a fixpoint, which
  is 1-minimality w.r.t. the strategy set. Takes an awaitable `interesting(text)`
  predicate and knows nothing about TOON.
- **`failure-signature.ts`** — defines what "same failure" means, so reduction
  can't slip between bugs when a case carries several. Signature = `(from, to,
  kind, fingerprint)`; the fingerprint categorizes HOW they diverge
  (`number-changed`, `container->string`, `array->object`, `key-dropped`, …) or,
  for errors, the message with digits normalized to `#` (so `Expected 500 items`
  and `Expected 2 items` match and the array can shrink). It compares numbers by
  canonical value on the lexeme-faithful tree — never `JSON.parse`, which would
  round big integers on both sides and hide the difference. A reduction is kept
  only if it still reproduces one of the original signatures.
- **`shrink-cli.ts`** (full env) — shrink one case (`--seed/--rng`, `--file`, or
  `--json`), or `--batch fuzz-out.txt` to collapse a run to one minimal case per
  distinct signature.

Proven in `selftest-shrink.ts` (no Python): a needle in a 6 KB structure reduces
to just the needle and is 1-minimal; a mock-f64 predicate reduces a bloated case
to the bare number; a 500-element array ddmins to length 2; and a case with TWO
planted bugs, shrunk against one signature, keeps that bug and never switches.

## The property layer (v0.4)

From-scratch generation, deferred in v0.2 as "mutation-first covers the fault
lines". Thesis D is what gives it a reason to exist.

### What it claims, and what it does not

Every value in the v0.3 matrix traces to one of 13 hand-written seeds through 12
operators designed against those seeds, with fault lines taken from toon#310.
That is a human-and-ecosystem prior on the value space.

The property layer does **not** remove that prior. It relocates it — out of
individual example values and into grammar productions, archetypes, weights and
fuel policy. Humans still define the distribution over the input space. The
honest claim is therefore narrower than "values nobody wrote":

> Deterministic evidence, independent of implementation behaviour and of
> hand-authored example values, generated under explicit and reviewable priors.

That is the wording the v0.4 write-up uses. Anything stronger is an overclaim.

### Three channels, kept apart

Because the channels differ in how targeted they are, they are separate in the
identity string and in reports rather than aggregated under "property
generated". This is the same refusal-to-collapse as the per-side numeric-domain
verdicts: two things with different epistemic status do not share one label.

| Channel | What it is | Independence claim |
|---------|-----------|--------------------|
| `general` | Broad recursive JSON grammar | Strongest — seed-independent exploration |
| `shape-*` | Coverage-directed structural archetypes | Model-based fuzzing; encodes known fault lines |
| `surface-toon` | Strings drawn from TOON's own wire syntax | Spec-directed; targeted at the lookalike class |

Only `general` carries the strong independence language.

### Shape: archetype, then fuel

Two-phase. Draw a shape archetype, then fill it under a fuel budget. A plain
recursive grammar spends nearly all its probability mass on small nondescript
values and would essentially never land a 200-row uniform table — the region
toon#310 says the ecosystem under-tests. Depth/breadth caps make everything the
same middling shape.

Archetypes: flat-wide object, long repetitive array, uniform table, near-uniform
table, deep nest, plus the unconstrained recursive draw that is the `general`
channel.

Fuel, not sampling, is what guarantees termination — every recursive step
receives strictly less fuel, every emitted node costs at least one unit, and a
zero-fuel call can emit only a terminal. The bulk selftest catches implementation
mistakes; it does not constitute the proof.

A node budget does not bound output size — one node can hold a million-character
string or a hundred-thousand-digit number — so keys and scalar lexemes carry
their own bounded-length budgets and output has an independent hard byte cap.
`size` means **maximum total value nodes**, which is stable enough to be part of
a case's identity.

### Numbers: grammar-driven, no boundary constants

Number lexemes are assembled from the JSON number grammar — draw a digit count,
a sign, optionally a fraction, optionally an exponent, build the string. **No
constant in the property generator names 2^53, i64/u64 max, or any other
boundary.** Reusing `BumpNumber`'s palette would make this a re-parameterisation
of the operator set wearing a different hat.

The generator reaches large-integer regions because the digit-count distribution
covers them — a chosen broad-region prior, not a prior-free accident. The
defensible advantage is that it explores those regions **without encoding
implementation-specific numeric limits or exact regression constants**.

A lexeme assembled from digits as a string never touches a JS number, so the
no-f64 invariant holds by construction. Numeric content is carried only as
branded lexeme strings; no production in the number path accepts or returns JS
number content.

A selftest may contain the 2^53 threshold in order to check that generated values
cross it. The constraint is on the generator, not on its judge.

### Strings: three weighted sources

Ordinary text, delimiter-stress text (the 008/009 regions), and complete
structural tokens.

Structural tokens are measure-zero in the JSON string grammar — uniform character
draws will never produce `[2]{a,b}:` — so the numbers approach does not transfer.
They are instead generated from TOON's own surface grammar, which yields tokens
like `[7]{q,z,r}:` that no human wrote, rather than reusing the twelve-element
`LOOKALIKE_PAYLOADS` list in `operators.ts`.

**Containment.** This puts TOON syntax knowledge inside `gen/` for the first
time, crossing a line held on purpose elsewhere: the oracle knows nothing about
TOON and `shrink.ts` knows nothing about TOON. The rule is therefore: the
production lives in one clearly-named module, mints **string contents only**, and
never touches structure or judging. Nothing that decides a verdict learns TOON.
The `general` channel does not import it.

**Spec relationship.** TOON *does* publish normative grammar. SPEC.md v4.1 §6
carries an RFC 5234 ABNF block defining `header`, `keyed-header`, `bracket-seg`,
`keyed-seg`, `fields-seg`, `field-entry`, `length`, `delimsym` and `key`; §7.1
adds a second block for `quoted-char`. So the module models a published grammar
rather than interpreting prose, and the independence claim for this channel is
correspondingly stronger. (An earlier revision of this file asserted the
opposite. It was written without reading §6 and was wrong.)

The coverage is not uniform, so the module declares its basis PER FAMILY rather
than as one blanket statement:

| Family | Example | Basis |
|--------|---------|-------|
| Array header | `[3]:` | §6 ABNF (`header`) |
| Tabular header | `[2]{a,b}:`, `items[2]{x}:` | §6 ABNF (`header` + `fields-seg`) |
| Nested field group | `[2]{id,customer{name,country}}:` | §6 ABNF (`field-entry`) |
| Keyed tabular header | `[2:]{age,city}:` | §6 ABNF (`keyed-header`) |
| List marker | `- `, `- item`, `  - nested` | §5.2 cl.2, §9.2, §9.4, §10 — prose, precise |
| Key-value line | `key:`, `key: value` | §5.2 cl.4, §7.4 — prose |
| Comment / `#`-leading | `# text` | §5.1 — prose, and §7.2's quoting rule |
| Empty-array token | `[]`, `key: []`, `- []` | §9.1, §9.3, §9.5, §4 — prose |

Five of these are ABNF-derived; three are prose-derived but stated precisely
enough to generate from. The module records which, because a claim of
"spec-derived" that quietly spans both would be the kind of overclaim this
project files against others.

**Three families the operator palette never reaches.** `LOOKALIKE_PAYLOADS` has
no keyed-tabular token, no `#`-leading string, and no bare `[]`. The last is the
sharpest: §9.1 makes `[]` an empty array in field position, while §9.3 and §9.5
make the same two bytes decode as the *string* `[]` inside rows and entry rows. A
lookalike whose meaning flips by position is exactly the class this channel
exists to manufacture. The `#` family independently covers the toon#328 class.

**Terminology follows the spec, not our earlier usage.** In §6 and §9.5 a *keyed
header* is `key[N:<delim?>]{…}:` — the colon after the length marks the keyed
tabular form. `LOOKALIKE_PAYLOADS` uses "keyed" to mean key-prefixed
(`items[2]{x}:`), which is a different thing. This module uses the spec's sense
throughout and says "key-prefixed" for the other. The comment in `operators.ts`
still carries the old usage and should be corrected when something next touches
that file.

**Staleness.** Golden outputs cannot detect that the *spec* moved while the
module stood still, so the module declares the version it models and
`selftest-property.ts` compares that against `SPEC_CURRENT` in
`probe/spec-rules.ts`, going red on a bump. The comparison lives in the selftest,
not in the module, so `gen/` still imports nothing from `probe/`.

**Date skew, confirmed from the primary source.** SPEC.md v4.1's header reads
`Date: 2026-07-26`; toon's `acc1bed` sets `$spec.date = '2026-07-25'`. Two repos,
two dates, one version — logged in backlog, not actioned here.

### Identity, versioning and replay

A property case's identity is `(channel, rngSeed, size)` under a generator
version, written as one line in the corpus sidecar:

```
prop:v1/general@1000003/40
prop:v1/shape-uniform-table@1000003/400
mut:seeds/010-numbers.json@1000003/3
```

`replay-case.ts` dispatches on the prefix. The recipe lives in a validated
optional `replay` field on `CaseMeta`, not smuggled into free-text `origin` —
replayability is a truth claim, and schema rigour follows the importance of the
claim rather than the number of files.

The grammar is part of the identity: change a weight or a production and the same
triple yields different bytes. `PROPERTY_GEN_VERSION` labels that, and three
things enforce it, because pinned end-to-end outputs alone would miss a weight
change that happens not to affect the pinned seeds:

1. Golden byte-exact outputs, per archetype and per scalar production family.
2. Direct tests of individual productions and branches.
3. A canonical, deterministically serialised weight/production configuration —
   one exported object, not literals scattered through constructors — which is
   included in the version review, printed in fuzz-run metadata, and summarised
   in reports.

**Replay policy: stored case bytes are authoritative.** A promoted case's
`replay` line is diagnostic provenance, not a permanent reconstruction recipe,
and old generator versions are not preserved. This is already true of `mut:`
recipes, which depend on `operators.ts` never changing.

### Proof obligations for `selftest-property.ts`

Thirteenth pure selftest — a deliberate count move, named in the commit body.
(`selftest-cli-write.ts` took twelfth.)

1. **Deterministic construction** — version, channel, seed and size reproduce
   identical value, text and metadata.
2. **Golden outputs** — pinned per archetype and per scalar production family.
3. **Lossless round trip** — generated value → emitted text → independent ingest
   preserves exact value and numeric lexemes, judged by `oracle/ingest.ts`. Bulk
   well-formedness alone is not sufficient: it establishes syntax acceptance, not
   fidelity.
4. **Numeric-path integrity** — numeric content is represented only by branded
   lexeme strings; every number-form production is exercised.
5. **Structural budget** — fuel strictly decreases, node count stays within
   budget, output stays within the byte cap.
6. **Direct shape validation** — each archetype constructor is invoked directly
   and produces its promised structure, with no reliance on probabilistic
   selection. The test path and the production path share one constructor.
7. **Sampler validation** — channel and production selection match the canonical
   weight configuration.
8. **Dependency separation** — `property.ts` imports neither the seed corpus nor
   `operators.ts`; the TOON surface module does not import `LOOKALIKE_PAYLOADS`;
   a deterministic sample produces payloads absent from those twelve.
9. **Spec relationship** — declared TOON version matches `SPEC_CURRENT`.
10. **Cross-runtime determinism** — the golden suite passes on both supported
    Node versions.

Obligation 10 is not ceremony. Goldens are pinned in the sandbox (Node 22) while
sweeps run on the Mac (Node 24.4.1). mulberry32 is integer-exact — `Math.imul` is
spec-defined and division by 2^32 is exact — so stability is expected, but a
tripwire that fires depending on which machine ran it would be worse than no
tripwire, and the expectation is unverified.

An earlier draft proposed an eleventh obligation: grep `property.ts` for boundary
constants and lookalike payloads. Dropped as theatre. It proves a property of the
file rather than of the generator, is defeated by a constant assembled at
runtime, and trips on an innocent comment. Obligation 8 is the durable form.

### Open before implementation

- Fuel cost model — per-node cost and the container split policy.
- Whether an archetype promises a minimum viable shape. A "uniform table" at
  size 4 is not a table; either reject sizes below each archetype's minimum,
  scale down and weaken the guarantee, or treat `size` as a target rather than a
  cap. The choice affects replay semantics.
- All weights: archetype, string-source, number-form.
- Generated-case id allocation, and a promotion command that replays, verifies,
  shrinks, allocates the next bucket id, writes case and sidecar atomically,
  revalidates the corpus, and refuses duplicate content or duplicate recipes.
  This fixes the v0.3 id collision once, for both generators.

## Not in this milestone

- **Generation driven by the ABNF itself.** §6's grammar is transcribed by hand
  into productions rather than parsed and interpreted at runtime. A real ABNF
  interpreter would make the module track the spec automatically instead of via
  the declared-version tripwire; it is a larger piece of work than v0.4 needs,
  and backlog 4.5a's deterministic clause extraction is the nearer step.
