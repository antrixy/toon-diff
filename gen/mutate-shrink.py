#!/usr/bin/env python3
"""Mutation pass for gen/shrink.ts.

Every case filed upstream from this repo is a SHRUNK case. If the shrinker
reduces past the bug, or reports a reduction of something that never failed, the
minimal reproducer in the issue is wrong -- and it is wrong in the direction that
wastes a maintainer's time and costs the project its credibility. So the two
properties that matter most here are not "does it get small": they are

  * it never returns a case that stopped being interesting, and
  * it never claims to have shrunk a case that was not interesting to begin with.

Each mutation is a defect a reviewer could plausibly introduce. A mutation that
leaves the selftest GREEN is a hole in the selftest, not a harmless edit.

TIMEOUTS ARE TREATED AS KILLS, and reported separately. Several of these
mutations remove a termination guard, so the honest outcome is "the selftest
would have caught this, by never finishing" -- which is a real signal, but a
different one from a red check, so the two are not conflated in the output.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

SRC = "gen/shrink.ts"
TEST = "gen/selftest-shrink.ts"
TIMEOUT = 60  # baseline is well under a second; 60s is a hang, not slowness

MUTATIONS = [
    # ---- the two correctness obligations ---------------------------------

    ("S1  the entry guard is dropped (a case that never failed gets 'shrunk')",
     "  if (!(await interesting(caseText))) {",
     "  if (false) {"),

    ("S2  the predicate result is ignored (every candidate accepted)",
     "    return await interesting(t);",
     "    return true;"),

    ("S3  the predicate is inverted (keeps exactly the reductions that killed it)",
     "    return await interesting(t);",
     "    return !(await interesting(t));"),

    # ---- the reduction invariant -----------------------------------------

    ("S4  the strictly-smaller guard is dropped (non-reductions accepted)",
     "    if (t.length >= curSize) return false; // never accept a non-reduction",
     "    if (false) return false;"),

    ("S5  strictly-smaller weakened to non-larger (equal-size churn accepted)",
     "    if (t.length >= curSize) return false; // never accept a non-reduction",
     "    if (t.length > curSize) return false;"),

    # ---- the check budget -------------------------------------------------

    ("S6  the check budget is not enforced inside the gate",
     "    if (count.checks >= count.max) return false;",
     "    if (false) return false;"),

    # NOT A MUTATION: dropping the outer-loop budget break is EQUIVALENT. Once
    # count.checks reaches max, the gate inside ok() refuses every candidate, so
    # reduceOnce returns null and the loop breaks on its own -- verified to
    # terminate at exactly the ceiling for max = 1, 5 and 25. The outer break is
    # defense-in-depth against a future ok() that stops enforcing the budget, and
    # THAT is killed independently by S6. Tried, survived, removed.

    ("S8  checks are counted but never incremented (the budget is decorative)",
     "    count.checks++;",
     "    // count.checks++;"),

    # ---- ddmin: the non-contiguous machinery ------------------------------

    ("S9  ddmin reverts nothing, so load-bearing partitions stay removed",
     "        for (const i of part) mask[i] = false; // revert: this partition is load-bearing",
     "        // no revert"),

    ("S10 ddmin complement pass removed (contiguous-subset cuts only)",
     "    const mask = new Array(len).fill(false);",
     "    const mask = new Array(len).fill(false); if (parts.length >= 0) return false;"),

    ("S11 ddmin linear finish removed (the old power-of-two-only behaviour)",
     "    for (let n = 2; n <= kept.length; n++) { if (await level(n)) n = 1; }",
     "    // linear finish removed"),

    ("S12 ddmin linear finish never restarts (no fixpoint at a level)",
     "    for (let n = 2; n <= kept.length; n++) { if (await level(n)) n = 1; }",
     "    for (let n = 2; n <= kept.length; n++) { await level(n); }"),

    # NOT MUTATIONS: relaxing either ddmin length floor (>= 1 to >= 0) is
    # EQUIVALENT with respect to output. The floors stop DDMIN from emptying an
    # array, but step 4 (DELETE) empties one element at a time regardless, so a
    # predicate that accepts [] lands on [] either way. The floors change the
    # path, not the result. Both tried, both survived, both removed: a check
    # written to kill them would have to assert on check counts, which pins the
    # shrinker's private mechanics rather than its output.

    ("S15 ddmin reports a reduction it never made",
     "  return improved ? replaceAt(root, path, kept) : null;",
     "  return replaceAt(root, path, kept);"),

    ("S16 ddmin never reports a reduction it did make",
     "  return improved ? replaceAt(root, path, kept) : null;",
     "  return null;"),

    # ---- the strategy ladder ----------------------------------------------

    ("S17 HOIST removed (layers never peel)",
     "  for (const p of paths) {\n    if (p.length === 0) continue;\n    const child = getAt(root, p);\n    if (await ok(child)) return child;\n  }",
     "  // hoist removed"),

    ("S18 NULL collapse removed",
     "    const cand = replaceAt(root, p, null);\n    if (await ok(cand)) return cand;",
     "    void replaceAt(root, p, null);"),

    ("S19 DELETE removed (keys and elements never drop individually)",
     "    const cand = deleteAt(root, p);\n    if (await ok(cand)) return cand;",
     "    void deleteAt(root, p);"),

    ("S20 SIMPLIFY targets cut to null only",
     '  const simplest: GNode[] = [null, false, ""];',
     "  const simplest: GNode[] = [null];"),

    ("S21 SIMPLIFY loses its already-simplest guard (churns on equal forms)",
     '      if (emit(n) === emit(s)) break; // already at/simpler than this target',
     "      // no guard"),

    # ---- the outer loop and the report ------------------------------------

    ("S22 shrink returns the ORIGINAL text rather than the reduced tree",
     "  const text = emit(cur);",
     "  const text = caseText;"),

    ("S23 the outer loop stops after one reduction (never reaches 1-minimality)",
     "    if (next === null) break;\n    cur = next;\n    steps++;",
     "    if (next === null) break;\n    cur = next;\n    steps++;\n    if (steps >= 1) break;",),

    ("S24 endBytes reported from the input, not the result",
     "  return { text, startBytes, endBytes: size(text), steps, checks: count.checks };",
     "  return { text, startBytes, endBytes: startBytes, steps, checks: count.checks };"),

    # ---- lexeme fidelity during reduction ---------------------------------
    # The module's headline claim: a RawNum is kept/dropped, never rebuilt, so
    # 9007199254740993 is not rounded while the array around it is minimized.

    # Mutated at ddmin's single EXIT point rather than in the subset branch. A
    # subset-only version of this is maskable: corrupting that branch just makes
    # every subset candidate fail the predicate, and the complement branch -- which
    # filters existing nodes -- recovers the same reduction. The exit point is the
    # one place both branches must pass through.
    ("S25 the reduced array is rebuilt through JSON (Symbol-tagged lexeme destroyed)",
     "  return improved ? replaceAt(root, path, kept) : null;",
     "  return improved ? replaceAt(root, path, JSON.parse(JSON.stringify(kept))) : null;"),
]


# KNOWN OPEN HOLES -- kept in the list, deliberately, so the pass reports them
# every run rather than letting them fade:
#
#   S10  the accumulating COMPLEMENT branch of ddmin can be removed entirely and
#        the suite stays green. The giant-array case is satisfied by the subset
#        branch plus linear granularity alone, so the non-contiguous accumulation
#        -- the feature the module header spends fifteen lines justifying -- is
#        the one part of ddmin nothing exercises. Closing it needs a case whose
#        removable filler is scattered such that NO single partition is droppable
#        but a union of them is.
#
#   S12  the linear finish never restarting (no fixpoint at a level) is likewise
#        invisible: the existing cases reach minimal without needing the restart.
#
# Both are quality-of-reduction, not correctness: a shrinker missing them returns
# a larger reproducer, never a wrong one. That is why they are recorded here
# rather than blocking, but they are real and they are unproven.


def run_selftest(cwd):
    """Returns (status, detail). status in {'green','red','timeout'}."""
    try:
        r = subprocess.run(
            ["node", "--experimental-strip-types", TEST],
            cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return "timeout", f"no termination within {TIMEOUT}s"
    if r.returncode == 0:
        return "green", ""
    fails = [l.strip() for l in r.stdout.splitlines() if l.startswith(" FAIL")]
    return "red", (fails[0][5:].strip() if fails else "(compile/run error)"), 


def main():
    tree = os.getcwd()
    status, *_ = run_selftest(tree)
    if status != "green":
        print(f"BASELINE IS NOT GREEN ({status}) -- fix that before mutating")
        return 1
    print("baseline: green\n")

    survivors, hangs = [], []
    for name, old, new in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            work = os.path.join(tmp, "tree")
            shutil.copytree(tree, work, ignore=shutil.ignore_patterns("node_modules", ".git"))
            path = os.path.join(work, SRC)
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
            res = run_selftest(work)
            status, detail = res[0], (res[1] if len(res) > 1 else "")
            if status == "green":
                print(f"  SURVIVED  {name}")
                survivors.append(name)
            elif status == "timeout":
                print(f"  hung      {name}")
                print(f"            {detail} -- caught, but by non-termination, not by a check")
                hangs.append(name)
            else:
                print(f"  killed    {name}")
                print(f"            first red: {detail}")

    print()
    if hangs:
        print(f"{len(hangs)} mutation(s) caught only by non-termination:")
        for h in hangs:
            print(f"  ~ {h}")
        print()
    if survivors:
        print(f"MUTATION PASS INCOMPLETE: {len(survivors)} of {len(MUTATIONS)} survived")
        for s in survivors:
            print(f"  - {s}")
        return 1
    print(f"MUTATION PASS CLEAN: all {len(MUTATIONS)} mutations killed")
    return 0


sys.exit(main())
