# TOON differential fuzzer — run notes

Prereqs already done: .venv with toon_format installed, npm i @toon-format/toon, Node 22+.

From the project root (the folder this file is in):

1) Make sure the venv is active (prompt shows "(.venv)"):
     source .venv/bin/activate
2) Make sure the project is ESM:
     npm pkg set type=module
3) Prove the oracle (no external deps needed):
     node --experimental-strip-types oracle/selftest-numbers.ts
   Expect: "V2 ORACLE PROVEN: all checks pass."
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

Prove the generator (no external deps — judged by the oracle, so runs anywhere):
     node --experimental-strip-types gen/selftest-emit.ts        # substrate never corrupts a case
     node --experimental-strip-types gen/selftest-operators.ts   # operators + determinism + coverage
   Expect both to end "... PROVEN ...".

See / persist generated cases (no TOON impls needed):
     node --experimental-strip-types gen/cli.ts preview --per 3
     node --experimental-strip-types gen/cli.ts write   --per 20   # -> probe/generated/{cases}.json + provenance.jsonl

Fuzz the differential matrix (FULL ENV — needs the TOON impls installed, same as
the Rust adapter track):
     node --experimental-strip-types gen/fuzz.ts --per 200
   Each divergence prints its recipe and a replay command. Reproduce any case:
     node --experimental-strip-types gen/replay-case.ts <seedFile> <rngSeed> [maxOps]
