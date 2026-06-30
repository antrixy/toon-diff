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
