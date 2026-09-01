# TOON differential fuzzer — run notes

Prereqs already done: .venv with toon_format installed, npm i @toon-format/toon, Node 22+.

From the project root (the folder this file is in):

1) Make sure the venv is active (prompt shows "(.venv)"):
     source .venv/bin/activate
2) Make sure the project is ESM:
     npm pkg set type=module
3) Prove the PURE SUITE (no external deps — no impls, no venv, no network).
   Sixteen files, 853 checks. Run all of them; the counts are promotion
   tripwires, so a moved number is a deliberate act or a regression.

     node --experimental-strip-types oracle/selftest.ts                #  18
     node --experimental-strip-types oracle/selftest-numbers.ts        #  37
     node --experimental-strip-types gen/selftest-emit.ts              #  31
     node --experimental-strip-types gen/selftest-operators.ts         #  30
     node --experimental-strip-types gen/selftest-shrink.ts            #  20
     node --experimental-strip-types gen/selftest-property.ts          #  60
     node --experimental-strip-types gen/selftest-cli-write.ts         #  20
     node --experimental-strip-types gen/selftest-run-manifest.ts      #  90
     node --experimental-strip-types gen/selftest-finding-log.ts       #  50
     node --experimental-strip-types probe/selftest-corpus.ts          #  58
     node --experimental-strip-types probe/selftest-grid.ts            #  84
     node --experimental-strip-types probe/selftest-explain.ts         #  48
     node --experimental-strip-types probe/selftest-spec-run.ts        #  25
     node --experimental-strip-types probe/selftest-numeric-domain.ts  #  83
     node --experimental-strip-types probe/selftest-spec-rules.ts      #  83
     node --experimental-strip-types adapters/selftest-claims.ts       #  66

   Each ends "... PROVEN ...". Any adapters/ commit runs the FULL suite, not
   just the touched directory's selftest — probe/ imports IMPL_CLAIMS, so an
   adapters/ change can turn probe/ red without touching a probe/ file.

3b) NOTE ON THE CORPUS (probe/selftest-corpus.ts, above). The corpus lives in
   provenance buckets under probe/cases/{seeds,spec,regressions,generated,community}/,
   each case as NNN-name.json + NNN-name.meta.json (origin + invariant).
   The mutation substrate is seeds/ only. Fuzz recipes name seeds by corpus
   key ("seeds/NNN-name.json"); replay-case also accepts pre-v0.3 flat names
   from archived sweep baselines.

   probe/cases/generated/ OPENED 2026-08-09 with the toon-rust#78 witness,
   {"Np":null," .":null}. The bucket split is about PROVENANCE: a hand-written seed
   and a fuzz-found case promoted into the corpus are different kinds of evidence
   and must not be counted as one. Ids are unique PER BUCKET, so generated/ numbers
   from 001 rather than continuing the seeds sequence.

   PROMOTING A CASE MOVES MORE COUNTS THAN YOU EXPECT. This one fired THREE
   tripwires, not the one predicted: probe/selftest-corpus.ts (case count, and the
   separate "other buckets are empty" check) and probe/selftest-grid.ts (case count,
   pair-check arithmetic, AND the rendered header string). Add the case first and
   read what goes red; do not go looking for the counts by hand.

3c) MUTATION PASSES. Nine modules carry one, and each must be re-run when its
   module changes. All nine work on scratch copies and never touch the tree:

     python3 gen/mutate-run-manifest.py   # all 23 mutations killed
     python3 gen/mutate-finding-log.py    # all 18 mutations killed
     python3 gen/mutate-property.py       # all 14 mutations killed
     python3 oracle/mutate-oracle.py      # all 23 mutations killed
     python3 gen/mutate-emit.py           # all 12 mutations killed
     python3 gen/mutate-shrink.py         # all 21 mutations killed
     python3 probe/mutate-spec-run.py     # all 19 mutations killed
     python3 probe/mutate-numeric-domain.py # all 27 killed, 1 equivalent (M9)
     python3 probe/mutate-grid.py         # all 24 mutations killed

   A NOTE ON JUDGES, from gen/mutate-emit.py. gen/selftest-emit.ts is judged by
   the ORACLE, whose equality ignores object key order and JSON whitespace -- so
   no check in it could ever see emit's key-order invariant break. Sorting emit's
   keys passed the suite. When a selftest borrows a judge, check what that judge
   is entitled to ignore, because that set is exactly the set of properties the
   selftest cannot prove no matter how many cases it runs.

   oracle/mutate-oracle.py covers BOTH oracle paths and runs both oracle
   selftests: canonicalize.ts + compare.ts (the superseded v1 path) and
   ingest.ts (v2 — the one gen/fuzz.ts imports, and therefore the one that
   decides every live PASS and FAIL).

   A SURVIVED line is a hole in the corresponding selftest, not a harmless edit.
   A SKIPPED line means a mutation's anchor text no longer exists in the module,
   so that mutation has silently stopped testing anything — treat it as a hole.

   These are committed rather than kept local because a mutation pass nobody can
   re-run is a claim, not a check.

4) Run the differential matrix:
     node --experimental-strip-types cli-v2.ts

What to expect: 16 cases loaded — 14 PAIRWISE (126 pair-checks) plus 2 SPEC
(6 spec-checks). Case 013 (9007199254740993) should DIVERGE on every
TS-involving pair (ts->ts, ts->python, python->ts) because JS rounds it at
JSON.parse before TOON is involved; python->python should pass. That asymmetry
is the real finding, not a harness bug.

THE TWO COUNTERS ARE SEPARATE AND MUST STAY SEPARATE. A pairwise case costs
N x N checks; a spec case costs N. Folding spec cases into pair-checks would
report 2 x 3 x 3 = 18 for work that is 2 x 3 = 6, which turns the arithmetic
from a tripwire into a fudge. probe/selftest-grid.ts pins both.

### THE spec/ BUCKET (v0.4) — wire-in, one-sided

probe/cases/spec/ cases are a TRIPLE, not a pair:

     NNN-name.json    the SPEC-MANDATED EXPECTED DECODE (the oracle value)
     NNN-name.toon    HAND-BUILT TOON WIRE TEXT, derived from SPEC.md
     NNN-name.meta.json

The wire never passed through any implementation's encoder, which is the whole
point: every wire in the pairwise matrix came from someone's encoder, so if all
implementations share one wrong assumption the matrix sees nothing. The run
path (probe/spec-run.ts) checks decode_X(wire) against the body once per
implementation and records `from: "spec"` — a synthetic name that is
deliberately NOT an adapter and never enters the N x N grid.

Loading is all-or-nothing here too: a spec case without its .toon, an orphan
.toon, an empty wire, or a .toon in any other bucket all refuse the WHOLE
corpus. Wire text keeps leading indentation (it is structure, per SPEC §12) and
drops only trailing whitespace.

OBSERVED 2026-08-30 in the frozen environment (Node 24.4.1, toon 2.3.0,
toon_format 0.9.0-beta.1, crate 0.5.0, rustc 1.96.1). These are results, not
predictions; the predictions they replaced are in the session handoff.

  spec/001-u64-boundary                 ts  python  rust
                                         X     .      X
  spec/002-legacy-empty-array-root       .     .      .

001: python decodes 18446744073709551617 EXACTLY (bignum) and agrees. ts returns
18446744073709552000 -- JSON.stringify's shortest round-tripping form of the
nearest double -- and is judged "documented-policy" under its post-#331 §4 docs.
RUST RETURNS THE EXACT DIGITS AS A LOSSLESS QUOTED STRING, {"n":"1844...617"},
which is §4's "return a string" option and the LOSSLESS-FIRST behaviour §4
RECOMMENDS. It is still judged "violates" -- but purely for documenting no
out-of-range policy, which §4 makes a MUST. A filing here reads "your decoder
already does the recommended thing, please say so", NOT "your decoder loses
data". This DISCHARGED the old rust caveat: nothing is lost, so the divergence
is not an artifact of our arbitrary_precision-OFF bridge choice.

002: ALL THREE AGREE -- and the interesting part is next to it in the same run.
On seeds/002 (the CANONICAL []) python decodes the string "[]" and rust ERRORS,
while both accept the LEGACY [0]: here. So the legacy form is the better
supported one, the opposite of what the case was authored expecting. That turns
seeds/002's "rust is behind the rule, not violating it" from version arithmetic
into an evidenced statement: rust genuinely implements the pre-3.1 world, where
the legacy form was the only form. A spec case that produces no divergence still
earned its place. It also bounds toon-python#61 to the canonical form alone.

THE MEASURED DOMAINS (probe-numeric-boundary, 14-value ladder, same session):
rust decodes every plain integer token in [-2^63, 2^64) as an exact number and
EVERYTHING outside it as a lossless string -- 2^100 included, though it is an
exact double. THERE IS NO f64 FALLBACK. numeric-domain.ts previously modelled
rust's domain as the window UNION the exactly-representable doubles, read off
serde_json's model and never checked against the binary; selftest-numeric-domain
asserted "2^100 is in-domain via the f64 fallback", a check that could not fail.
Corrected 2026-08-30: the tag is now i64u64, the domains NO LONGER NEST (f64 and
i64u64 are incomparable in both directions), and the decoder's faithful-relay
credit is COMPUTED per value by relayLandsInDomain() instead of resting on the
nesting that is gone. The 013 verdicts are unchanged, which is pinned.

THE PATH IS CHOSEN BY TOKEN FORM, NOT VALUE (token-form ladder, same session).
A PLAIN integer token outside rust's window returns a lossless string, but an
EXPONENT token takes the f64 numeric path at EVERY magnitude tested, and the
split is purely lexical -- 123456789012345678901e5 is integer-valued and still
parsed as a float. The TS encoder emits plain decimal below 1e21 and exponent
form at or above it (SPEC §2 permits the switch), so a ts->rust round trip has
TWO BANDS:

  [2^64, 1e21)  ts emits plain decimal, rust stringifies  -> relay UNSOUND
  >= 1e21       ts emits exponent, rust returns a number  -> relay sound

relayLandsInDomain() models exactly that, and the first version of it was WRONG:
it ignored the wire form and called ts->rust unsound at 2^100+1, where ts in fact
emits exponent notation. That error was made INSIDE the commit correcting the
previous unmeasured assumption, which is the lesson worth keeping -- a model
corrected from one measurement can still hold a second unmeasured assumption,
and the correction is when you are least likely to look for it. Both bands are
now pinned from measured ts wire values, negatives included.

NEW DIVERGENCE, RECORDED BUT NOT YET A CASE: on `1e400` -- a token §4's number
grammar accepts, with no finite double -- rust ERRORS while python returns the
STRING "1e400". §4 permits rejection and returning a string, IF documented;
neither documents anything. A real rust/python fault line ABOVE the u64 one, and
a natural spec/003. Books to v0.5 under the scope rule.

## v0.2 — the mutation generator (gen/)

The generator turns the 13 SEEDS into inputs nobody wrote, along documented fault
lines (flat/wide objects, large tables, boundary integers, delimiter strings).
See gen/DESIGN.md for the operator set and the non-corruption invariant.

Prove the generator: covered by the pure suite in step 3 (selftest-emit,
selftest-operators, selftest-shrink, selftest-property, selftest-cli-write).

See / persist generated cases (no TOON impls needed):
     node --experimental-strip-types gen/cli.ts preview --per 3
     node --experimental-strip-types gen/cli.ts write   --per 20   # -> probe/generated/{cases}.json + provenance.jsonl

   MIND THE TWO "generated" DIRECTORIES — THEY ARE NOT THE SAME PLACE.
     probe/generated/         SCRATCH. Gitignored, regenerable, not corpus.
     probe/cases/generated/   CORPUS BUCKET. Promoted cases, with sidecars.
   A promotion written to the first one lands in a GITIGNORED directory the corpus
   loader never looks in, so the case is simply invisible — the loader reports the
   old count with no complaint, and only the selftest tripwires go red. This
   happened on 2026-08-09. The web UI commits into gitignored paths quite happily,
   so the usual safety net does not apply to a browser-only workflow. Verify a
   promoted case at the path the LOADER reads, not just that it exists.

Fuzz the differential matrix (FULL ENV — needs the TOON impls installed, same as
the Rust adapter track). ACTIVATE THE VENV FIRST; the first property run was
wasted on a dead python worker:
     node --experimental-strip-types gen/fuzz.ts --per 200                 # mutation cases
     node --experimental-strip-types gen/fuzz.ts --mode prop --size 40     # property cases

Every run ends with a RUN MANIFEST and one of six verdicts. READ THE VERDICT,
not the finding count:
     RAN-CLEAN     exit 0   ran as planned, nothing diverged
     RAN-FOUND     exit 1   ran as planned, divergences or errors
     DID-NOT-RUN   exit 3   the plan generated no cases (check numeric args)
     HARNESS-DEAD  exit 3   an adapter failed its canary (check the venv)
     NO-EVIDENCE   exit 3   cases generated but no pair-check ran (check the
                            generator-malformed count; a generator emitting
                            invalid JSON skips every case)
     INCOMPLETE    exit 3   generated fewer cases than planned, uncapped

Exit 3 is not a result. Exit 0 means the run happened and was clean, never that
it did not happen.

   Each divergence prints its recipe and a replay command. Reproduce any case:
     node --experimental-strip-types gen/replay-case.ts <seedFile> <rngSeed> [maxOps]
     node --experimental-strip-types gen/replay-case.ts "prop:v2/general@1000003/40"

## Reading a run, and shrinking what it found

The manifest groups BOTH kinds of finding, so a dominant cause is a count rather
than an impression:

     divergence signatures:      how the trees differed (number-changed, ...)
     error signatures:           how a call failed, one line per distinct failure

A line reading

     defect:    N divergence(s) the oracle judges EQUAL.

is NOT a thin result. It means the harness called something a divergence that the
oracle calls equal — the two disagree, and that must be fixed before anything in
the run is triaged, let alone filed.

Each divergence line also carries its CLASS in brackets, after the label and after
any skew note:

     ts → rust   ✗   prop:v2/general@1000003/40   [claimed-spec skew 3.3 vs 3.0]   [key-dropped]

so a log is greppable by class without re-running the adapters. This matters more
than it looks: expected/actual are truncated at 200 bytes, so before this the class
was recoverable from a log only when the difference fell inside that window — in
the first v2 run, 7 of 71. Logs written before this change still parse, with no
class rather than being dropped.

READ THE CLASS AS THE HARNESS'S HYPOTHESIS, NOT THE FINDING. "key-dropped" is what
the fingerprinter calls a key that came back different; toon-rust#78 wears that
label and the key is CORRUPTED, not dropped. Read the wire text before believing
the name.

Shrink a finding to a minimal reproducer (FULL ENV, needs the impls):

     node --experimental-strip-types gen/shrink-cli.ts --recipe "prop:v2/general@1059844/40"
     node --experimental-strip-types gen/shrink-cli.ts --seed seeds/004-uniform-table.json --rng 7029941
     node --experimental-strip-types gen/shrink-cli.ts --batch fuzz-out.txt [--limit 40]

--batch reads BOTH mutation and property findings. A property case that diverges
on nine pairs is ONE shrink target, not nine: the same bytes fail on every pair
and captureSignatures already captures all of them from a single case.

A recipe from another generator version is REFUSED AND REPORTED, never replayed —
the grammar is part of a case's identity, so the bytes would not match. After a
PROPERTY_GEN_VERSION bump an old fuzz-out.txt is entirely stale recipes, and the
refusal report is what keeps that from looking like a run with no findings.
