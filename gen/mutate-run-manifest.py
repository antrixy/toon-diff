#!/usr/bin/env python3
"""Mutation pass for gen/run-manifest.ts.

Each mutation is a defect a reviewer could plausibly introduce, or the exact
pre-fix behaviour of gen/fuzz.ts. A mutation that leaves the selftest GREEN is a
hole in the selftest, not a harmless edit.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os, re

SRC = os.path.abspath("gen/run-manifest.ts")
TEST = "gen/selftest-run-manifest.ts"

MUTATIONS = [
    ("M1  zero-case guard weakened to negative-only",
     "  } else if (p.casesPlanned < 1) {",
     "  } else if (p.casesPlanned < 0) {"),

    ("M2  DID-NOT-RUN downgraded to exit 0",
     '  "DID-NOT-RUN": EXIT.UNTRUSTWORTHY,',
     '  "DID-NOT-RUN": EXIT.CLEAN,'),

    ("M3  incompleteness check dropped",
     "    when: (s) => !s.tally.capped && s.tally.casesGenerated !== s.plan.casesPlanned,",
     "    when: () => false,"),

    ("M4  cap treated as incompleteness",
     "    when: (s) => !s.tally.capped && s.tally.casesGenerated !== s.plan.casesPlanned,",
     "    when: (s) => s.tally.casesGenerated !== s.plan.casesPlanned,"),

    ("M5  divergences and errors merged into one counter",
     "  t.errors++;\n  if (from === to) t.selfPairErrors++;",
     "  t.divergences++;\n  if (from === to) t.selfPairErrors++;"),

    ("M6  dead-harness rule removed (the pre-fix behaviour)",
     "      s.tally.quarantined.length > 0 ||\n      (s.tally.checksAttempted > 0 && s.tally.checksCompleted === 0),",
     "      false,"),

    ("M7  verdict list gains a permissive fallthrough",
     '    verdict: "RAN-FOUND",\n    when: (s) => s.tally.divergences > 0 || s.tally.errors > 0,',
     '    verdict: "RAN-FOUND",\n    when: () => false,'),

    ("M8  NaN guard removed (the --size abc path)",
     "  if (!Number.isInteger(p.casesPlanned)) {",
     "  if (false) {"),

    ("M9  plan digest loses key sorting",
     "  const params = Object.fromEntries(Object.keys(p.params).sort().map((k) => [k, p.params[k]]));",
     "  const params = Object.fromEntries(Object.keys(p.params).map((k) => [k, p.params[k]]));"),

    ("M10 consecutive-error count allowed to quarantine on its own",
     "    if (ok) this.consecutive.set(adapter, 0);\n    else this.dead.add(adapter);",
     "    this.dead.add(adapter);"),

    ("M11 error signatures no longer group repeats",
     '    .replace(/\\d+/g, "#")',
     '    .replace(/\\d+/g, (m) => m)'),

    ("M13 DID-NOT-RUN re-collapsed over HARNESS-DEAD",
     '    verdict: "DID-NOT-RUN",\n    when: (s) => planProblems(s.plan).length > 0,',
     '    verdict: "DID-NOT-RUN",\n    when: (s) => planProblems(s.plan).length > 0 || s.tally.casesGenerated < 1,'),

    ("M14 canary preflight result ignored",
     "  return results.filter((r) => !r.ok).map((r) => r.adapter);",
     "  return [];"),

    ("M12 legacy finding total silently redefined",
     "  return t.divergences + t.errors;",
     "  return t.divergences;"),
]


def run_selftest(cwd):
    r = subprocess.run(
        ["node", "--experimental-strip-types", TEST],
        cwd=cwd, capture_output=True, text=True)
    fails = [l.strip() for l in r.stdout.splitlines() if l.startswith(" FAIL")]
    return r.returncode, fails


def main():
    tree = os.getcwd()
    base_rc, base_fails = run_selftest(tree)
    if base_rc != 0:
        print("BASELINE IS NOT GREEN -- fix that before mutating")
        return 1
    print(f"baseline: green\n")

    survivors = []
    for name, old, new in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            work = os.path.join(tmp, "tree")
            shutil.copytree(tree, work, ignore=shutil.ignore_patterns("node_modules", ".git"))
            path = os.path.join(work, "gen", "run-manifest.ts")
            src = open(path).read()
            if old not in src:
                print(f"  ??  {name}\n      ANCHOR NOT FOUND -- mutation did not apply")
                survivors.append(name)
                continue
            if src.count(old) != 1:
                print(f"  ??  {name}\n      anchor is not unique ({src.count(old)}x)")
                survivors.append(name)
                continue
            open(path, "w").write(src.replace(old, new))
            rc, fails = run_selftest(work)
            if rc == 0:
                print(f"  SURVIVED  {name}")
                survivors.append(name)
            else:
                caught = fails[0][5:].strip() if fails else "(compile/run error)"
                print(f"  killed    {name}")
                print(f"            {len(fails)} check(s) red, first: {caught}")

    print()
    if survivors:
        print(f"MUTATION PASS INCOMPLETE: {len(survivors)} of {len(MUTATIONS)} survived")
        for s in survivors:
            print(f"  - {s}")
        return 1
    print(f"MUTATION PASS CLEAN: all {len(MUTATIONS)} mutations killed")
    return 0


sys.exit(main())
