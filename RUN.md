# TOON differential fuzzer — run notes

Prereqs already done: .venv with toon_format installed, npm i @toon-format/toon, Node 22+.

From the project root (the folder this file is in):

1) Make sure the venv is active (prompt shows "(.venv)"):
     source .venv/bin/activate
2) Make sure the project is ESM:
     npm pkg set type=module
3) Prove the PURE SUITE (no external deps — no impls, no venv, no network).
   Fourteen files, 595 checks. Run all of them; the counts are promotion
   tripwires, so a moved number is a deliberate act or a regression.

     node --experimental-strip-types oracle/selftest.ts                #  18
     node --experimental-strip-types oracle/selftest-numbers.ts        #  37
     node --experimental-strip-types gen/selftest-emit.ts              #  31
     node --experimental-strip-types gen/selftest-operators.ts         #  30
     node --experimental-strip-types gen/selftest-shrink.ts            #  20
     node --experimental-strip-types gen/selftest-property.ts          #  45
     node --experimental-strip-types gen/selftest-cli-write.ts         #  20
     node --experimental-strip-types gen/selftest-run-manifest.ts      #  71
     node --experimental-strip-types probe/selftest-corpus.ts          #  37
     node --experimental-strip-types probe/selftest-grid.ts            #  40
     node --experimental-strip-types probe/selftest-explain.ts         #  48
     node --experimental-strip-types probe/selftest-numeric-domain.ts  #  53
     node --experimental-strip-types probe/selftest-spec-rules.ts      #  83
     node --experimental-strip-types adapters/selftest-claims.ts       #  62

   Each ends "... PROVEN ...". Any adapters/ commit runs the FULL suite, not
   just the touched directory's selftest — probe/ imports IMPL_CLAIMS, so an
   adapters/ change can turn probe/ red without touching a probe/ file.

3b) NOTE ON THE CORPUS (probe/selftest-corpus.ts, above). The corpus lives in
   provenance buckets under probe/cases/{seeds,spec,regressions,generated,community}/,
   each case as NNN-name.json + NNN-name.meta.json (origin + invariant).
   The mutation substrate is seeds/ only. Fuzz recipes name seeds by corpus
   key ("seeds/NNN-name.json"); replay-case also accepts pre-v0.3 flat names
   from archived sweep baselines.

3c) Re-run the mutation pass when gen/run-manifest.ts changes. It works on
   scratch copies and never touches the tree:
     python3 gen/mutate-run-manifest.py
   Expect: "MUTATION PASS CLEAN: all 14 mutations killed". A SURVIVED line is a
   hole in gen/selftest-run-manifest.ts, not a harmless edit.

4) Run the differential matrix:
     node --experimental-strip-types cli-v2.ts

What to expect: 13 cases tested, 0 quarantined. Case 013 (9007199254740993)
should DIVERGE on every TS-involving pair (ts->ts, ts->python, python->ts)
because JS rounds it at JSON.parse before TOON is involved; python->python
should pass. That asymmetry is the real finding, not a harness bug.

## v0.2 — the mutation generator (gen/)

The generator turns the 13 seeds into inputs nobody wrote, along documented fault
lines (flat/wide objects, large tables, boundary integers, delimiter strings).
See gen/DESIGN.md for the operator set and the non-corruption invariant.

Prove the generator: covered by the pure suite in step 3 (selftest-emit,
selftest-operators, selftest-shrink, selftest-property, selftest-cli-write).

See / persist generated cases (no TOON impls needed):
     node --experimental-strip-types gen/cli.ts preview --per 3
     node --experimental-strip-types gen/cli.ts write   --per 20   # -> probe/generated/{cases}.json + provenance.jsonl

Fuzz the differential matrix (FULL ENV — needs the TOON impls installed, same as
the Rust adapter track). ACTIVATE THE VENV FIRST; the first property run was
wasted on a dead python worker:
     node --experimental-strip-types gen/fuzz.ts --per 200                 # mutation cases
     node --experimental-strip-types gen/fuzz.ts --mode prop --size 40     # property cases

Every run ends with a RUN MANIFEST and one of five verdicts. READ THE VERDICT,
not the finding count:
     RAN-CLEAN     exit 0   ran as planned, nothing diverged
     RAN-FOUND     exit 1   ran as planned, divergences or errors
     DID-NOT-RUN   exit 3   the plan generated no cases (check numeric args)
     HARNESS-DEAD  exit 3   an adapter failed its canary (check the venv)
     INCOMPLETE    exit 3   generated fewer cases than planned, uncapped

Exit 3 is not a result. Exit 0 means the run happened and was clean, never that
it did not happen.

   Each divergence prints its recipe and a replay command. Reproduce any case:
     node --experimental-strip-types gen/replay-case.ts <seedFile> <rngSeed> [maxOps]
     node --experimental-strip-types gen/replay-case.ts "prop:v1/general@1000003/40"
