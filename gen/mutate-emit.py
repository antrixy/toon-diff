#!/usr/bin/env python3
"""Mutation pass for gen/emit.ts.

emit() is the substrate the whole generator stands on: every case the fuzzer
produces, every candidate the shrinker tests, and every byte sent to an adapter
goes through it. Its selftest closes with "safe to mutate on top of it", which is
a strong claim to leave unexercised.

The structural risk in that selftest is worth naming, because it is not obvious:
its judge is the ORACLE, and the oracle's equality deliberately IGNORES object key
order. So no oracle-judged check can ever see emit's second invariant (keys emit
in insertion order, unsorted) break. A value-equality harness is exactly the wrong
instrument for a representation guarantee, and the mutations below are what make
that visible instead of theoretical.

A mutation that leaves the selftest GREEN is a hole in the selftest, not a
harmless edit.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

SRC = "gen/emit.ts"
TEST = "gen/selftest-emit.ts"
TIMEOUT = 60

MUTATIONS = [
    # ---- invariant 2: key order is a fault line, not noise -----------------

    ("E1  object keys sorted on emit (the fault line PerturbUniformity hunts)",
     "  for (const k of Object.keys(obj)) {",
     "  for (const k of Object.keys(obj).sort()) {"),

    ("E2  object keys reversed on emit",
     "  for (const k of Object.keys(obj)) {",
     "  for (const k of Object.keys(obj).reverse()) {"),

    # ---- invariant 1: number faithfulness ---------------------------------

    ("E3  RawNum reconstructed through a JS number (f64 rounding returns)",
     "  if (isRawNum(node)) return lexemeOf(node); // exact lexeme, no reconstruction",
     "  if (isRawNum(node)) return String(Number(lexemeOf(node)));"),

    ("E4  RawNum normalised through JSON (drops -0 and 1.0 form)",
     "  if (isRawNum(node)) return lexemeOf(node); // exact lexeme, no reconstruction",
     "  if (isRawNum(node)) return JSON.stringify(JSON.parse(lexemeOf(node)));"),

    # ---- structural correctness -------------------------------------------

    ("E5  strings emitted unquoted (output stops being JSON)",
     '  if (typeof node === "string") return JSON.stringify(node);',
     "  if (typeof node === \"string\") return node;"),

    ("E6  object keys emitted unquoted",
     '    parts.push(JSON.stringify(k) + ":" + emit(obj[k]));',
     '    parts.push(k + ":" + emit(obj[k]));'),

    ("E7  booleans inverted",
     '  if (typeof node === "boolean") return node ? "true" : "false";',
     '  if (typeof node === "boolean") return node ? "false" : "true";'),

    ("E8  null emitted as an empty string",
     '  if (node === null) return "null";',
     '  if (node === null) return "";'),

    ("E9  array elements stringified rather than emitted (recursion lost)",
     '  if (isArray(node)) return "[" + node.map(emit).join(",") + "]";',
     '  if (isArray(node)) return "[" + node.map(String).join(",") + "]";'),

    ("E10 array separator gains whitespace (valid JSON, different bytes)",
     '  if (isArray(node)) return "[" + node.map(emit).join(",") + "]";',
     '  if (isArray(node)) return "[" + node.map(emit).join(", ") + "]";'),

    ("E11 object separator gains whitespace (valid JSON, different bytes)",
     '  return "{" + parts.join(",") + "}";',
     '  return "{" + parts.join(", ") + "}";'),

    ("E12 key/value separator gains whitespace",
     '    parts.push(JSON.stringify(k) + ":" + emit(obj[k]));',
     '    parts.push(JSON.stringify(k) + ": " + emit(obj[k]));'),
]


def run_selftest(cwd):
    try:
        r = subprocess.run(
            ["node", "--experimental-strip-types", TEST],
            cwd=cwd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return "timeout", f"no termination within {TIMEOUT}s"
    if r.returncode == 0:
        return "green", ""
    fails = [l.strip() for l in r.stdout.splitlines() if l.startswith(" FAIL")]
    return "red", (fails[0][5:].strip() if fails else "(compile/run error)")


def main():
    tree = os.getcwd()
    status, _ = run_selftest(tree)
    if status != "green":
        print(f"BASELINE IS NOT GREEN ({status}) -- fix that before mutating")
        return 1
    print("baseline: green\n")

    survivors = []
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
            status, detail = run_selftest(work)
            if status == "green":
                print(f"  SURVIVED  {name}")
                survivors.append(name)
            elif status == "timeout":
                print(f"  hung      {name}\n            {detail}")
                survivors.append(name)
            else:
                print(f"  killed    {name}\n            first red: {detail}")

    print()
    if survivors:
        print(f"MUTATION PASS INCOMPLETE: {len(survivors)} of {len(MUTATIONS)} survived")
        for s in survivors:
            print(f"  - {s}")
        return 1
    print(f"MUTATION PASS CLEAN: all {len(MUTATIONS)} mutations killed")
    return 0


sys.exit(main())
