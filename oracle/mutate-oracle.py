#!/usr/bin/env python3
"""Mutation pass for oracle/canonicalize.ts and oracle/compare.ts.

The oracle decides every PASS and every FAIL this tool reports. If equal() is
wrong, no divergence filed from this repo means anything -- so of all the modules
here, this is the one whose selftest most needs to be a tripwire rather than a
description.

Each mutation is a defect a reviewer could plausibly introduce. A mutation that
leaves the selftest GREEN is a hole in the selftest, not a harmless edit.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

TESTS = ["oracle/selftest.ts", "oracle/selftest-numbers.ts"]

# (name, file, old, new)
MUTATIONS = [
    # ---- canonicalize.ts: the comparison policy ---------------------------

    ("O1  sortKeys stops at an array boundary (keys inside arrays stay unsorted)",
     "canonicalize.ts",
     "  if (Array.isArray(value)) return value.map(sortKeys);",
     "  if (Array.isArray(value)) return value;"),

    ("O2  object keys no longer sorted (key order becomes significant)",
     "canonicalize.ts",
     "    for (const key of Object.keys(value).sort()) {",
     "    for (const key of Object.keys(value)) {"),

    ("O3  arrays sorted too (array order silently stops mattering)",
     "canonicalize.ts",
     "  if (Array.isArray(value)) return value.map(sortKeys);",
     "  if (Array.isArray(value)) return value.map(sortKeys).sort();"),

    ("O4  Unicode normalization applied (e+U+0301 collapses onto U+00E9)",
     "canonicalize.ts",
     "export function canonical(value: Json): string {\n  return JSON.stringify(sortKeys(value));",
     "export function canonical(value: Json): string {\n  return JSON.stringify(sortKeys(value)).normalize(\"NFC\");"),

    ("O5  null treated as an object (crashes, or worse, compares as {})",
     "canonicalize.ts",
     "  if (value !== null && typeof value === \"object\") {",
     "  if (typeof value === \"object\") {"),

    ("O6  equality loosened to a type-blind string compare",
     "compare.ts",
     "export function equal(a: Json, b: Json): boolean {\n  return canonical(a) === canonical(b);",
     "export function equal(a: Json, b: Json): boolean {\n  return String(canonical(a)).replace(/\"/g, \"\") === String(canonical(b)).replace(/\"/g, \"\");"),

    # ---- compare.ts: the ingestion fidelity guard -------------------------

    ("O7  fidelity guard disabled (every case reads as faithful)",
     "compare.ts",
     "  return offending.length > 0",
     "  return false"),

    ("O8  -0 detection uses === , which is also true for 0",
     "compare.ts",
     "      if (Object.is(value, -0)) {",
     "      if (value === -0) {"),

    # NOT A MUTATION: dropping the Object.is(value, -0) branch is EQUIVALENT.
    # Every lexeme that parses to -0 carries a minus sign, and String(-0) is "0",
    # so the lexeme comparison in the else-if always flags it first. The branch is
    # defense-in-depth against a future weakening of canonicalNumber, not an
    # independently reachable guard. Tried, survived, removed.

    ("O10 lexeme comparison dropped (1.0 and 2^53+1 read as faithful)",
     "compare.ts",
     "      } else if (canonicalNumber(src) !== canonicalNumber(String(value))) {",
     "      } else if (false) {"),

    ("O11 canonicalNumber also strips a trailing .0 (form collapse hidden)",
     "compare.ts",
     "  return lit.replace(/^\\+/, \"\");",
     "  return lit.replace(/^\\+/, \"\").replace(/\\.0$/, \"\");"),

    ("O12 source-text channel abandoned for the parsed value (guard is blind)",
     "compare.ts",
     "      const src = ctx.source;",
     "      const src = String(value);"),

    ("O13 number-token guard removed (string interiors become false positives)",
     "compare.ts",
     "    if (typeof value === \"number\" && ctx && typeof ctx.source === \"string\") {",
     "    if (ctx && typeof ctx.source === \"string\") {"),

    ("O14 offending literals collected but the verdict ignores them",
     "compare.ts",
     "  return offending.length > 0",
     "  return offending.length > 999999"),

    # ---- ingest.ts: the v2 oracle, the one gen/fuzz.ts actually imports ----
    # These carry the most weight in the file. compare.ts/canonicalize.ts are the
    # superseded v1 path; ingest.ts is what decides every live PASS and FAIL.

    ("I1  canonical stops recursing into arrays (table rows stop normalizing)",
     "ingest.ts",
     '  if (Array.isArray(node)) return "[" + node.map(canonical).join(",") + "]";',
     '  if (Array.isArray(node)) return "[" + node.join(",") + "]";'),

    ("I2  object keys no longer sorted (key order becomes a divergence)",
     "ingest.ts",
     "  const keys = Object.keys(obj).sort();",
     "  const keys = Object.keys(obj);"),

    # NOT A MUTATION: dropping the "#" number tag is EQUIVALENT, because strings
    # are already rendered quoted -- number 1 gives "1" and string "1" gives
    # "\"1\"", which never collide. The tag is defense-in-depth for the case where
    # quoting is lost, and THAT is killed independently by I4. Tried, survived,
    # removed: a check written to kill it would have to assert on a canonical
    # string shape rather than on an equality outcome, which pins the serializer's
    # private format instead of the comparison policy.

    ("I4  strings rendered unquoted (type strictness leans on the # tag alone)",
     "ingest.ts",
     "  if (typeof node === \"string\") return JSON.stringify(node); // quoted form",
     "  if (typeof node === \"string\") return node;"),

    ("I5  Symbol tag swapped for a string key (a real \"__num\" object collides)",
     "ingest.ts",
     'const NUM = Symbol("num");',
     'const NUM = "__num" as unknown as symbol;'),

    ("I6  exponent group dropped from the number grammar",
     "ingest.ts",
     "  const m = /^([+-]?)(\\d+)(?:\\.(\\d*))?(?:[eE]([+-]?\\d+))?$/.exec(lex.trim());",
     "  const m = /^([+-]?)(\\d+)(?:\\.(\\d*))?$/.exec(lex.trim());"),

    ("I7  trailing fractional zeros no longer stripped (1.50 != 1.5)",
     "ingest.ts",
     '  fracStr = fracStr.replace(/0+$/, ""); // strip trailing zeros',
     "  // trailing zeros kept"),

    ("I8  canonical zero keeps its sign (the policy flip, made silently)",
     "ingest.ts",
     '  if (intStr === "0" && fracStr === "") return "0"; // canonical zero, sign dropped',
     '  if (intStr === "0" && fracStr === "") return sign + "0";'),

    ("I9  sign dropped entirely (-1.5 canonicalizes as 1.5)",
     "ingest.ts",
     '  const sign = m[1] === "-" ? "-" : "";',
     '  const sign = "";'),

    ("I10 source lexeme abandoned for the parsed value (precision laundered by f64)",
     "ingest.ts",
     "      return numNode(canonicalNumber(ctx.source));",
     "      return numNode(canonicalNumber(String(value)));"),

    ("I11 leading-zero strip made greedy (canonical zero loses its digit)",
     "ingest.ts",
     '  intStr = intStr.replace(/^0+(?=\\d)/, ""); // strip leading zeros, keep one',
     '  intStr = intStr.replace(/^0+/, "");'),
]


def run_tests(cwd):
    fails = []
    for t in TESTS:
        r = subprocess.run(
            ["node", "--experimental-strip-types", t],
            cwd=cwd, capture_output=True, text=True)
        if r.returncode != 0:
            got = [l.strip() for l in r.stdout.splitlines() if l.startswith(" FAIL")]
            fails.extend(got or [f"({t} exited {r.returncode})"])
    return fails


def main():
    tree = os.getcwd()
    if run_tests(tree):
        print("BASELINE IS NOT GREEN -- fix that before mutating")
        return 1
    print("baseline: green\n")

    survivors = []
    for name, fname, old, new in MUTATIONS:
        with tempfile.TemporaryDirectory() as tmp:
            work = os.path.join(tmp, "tree")
            shutil.copytree(tree, work, ignore=shutil.ignore_patterns("node_modules", ".git"))
            path = os.path.join(work, "oracle", fname)
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
            fails = run_tests(work)
            if not fails:
                print(f"  SURVIVED  {name}")
                survivors.append(name)
            else:
                print(f"  killed    {name}")
                print(f"            {len(fails)} check(s) red, first: {fails[0][5:].strip()}")

    print()
    if survivors:
        print(f"MUTATION PASS INCOMPLETE: {len(survivors)} of {len(MUTATIONS)} survived")
        for s in survivors:
            print(f"  - {s}")
        return 1
    print(f"MUTATION PASS CLEAN: all {len(MUTATIONS)} mutations killed")
    return 0


sys.exit(main())
