#!/usr/bin/env python3
"""Mutation pass for gen/property.ts -- the digit prior and the archetype rules.

Each mutation is either a defect a reviewer could plausibly introduce, or one of
the distributions RULE 1 exists to forbid. A mutation that leaves the selftest
GREEN is a hole in the selftest, not a harmless edit.

The rule-1 mutations are the point of this file. The generator may not name a
numeric limit, and the constraint is SYMMETRIC: a distribution that PEAKS near the
region where implementations diverge smuggles that region in as a weight, and one
that NOTCHES there is the same violation with the opposite sign. Both must die.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

SRC = os.path.abspath("gen/property.ts")
TEST = "gen/selftest-property.ts"

MUTATIONS = [
    # ---- RULE 1: the shapes that must be unreachable ----------------------
    ("M1  digit prior PEAKS at 15-17 (smuggles the boundary in as a weight)",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1); w.push(x); tot += x; }",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1) * (d >= 15 && d <= 17 ? 12 : 1); w.push(x); tot += x; }"),

    ("M2  digit prior NOTCHES at 15-19 (aiming AWAY is the same violation)",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1); w.push(x); tot += x; }",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1) * (d >= 15 && d <= 19 ? 0.05 : 1); w.push(x); tot += x; }"),

    ("M3  uniform prior restored (the v1 defect: mean 20.5 digits)",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1); w.push(x); tot += x; }",
     "  for (let d = 1; d <= n; d++) { const x = 1; w.push(x); tot += x; }"),

    ("M4  harmonic 1/d substituted (decays hardest at the head, guts the middle)",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1); w.push(x); tot += x; }",
     "  for (let d = 1; d <= n; d++) { const x = 1 / d; w.push(x); tot += x; }"),

    ("M5  a single digit weight hand-tuned (the general form of the above)",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1); w.push(x); tot += x; }",
     "  for (let d = 1; d <= n; d++) { const x = Math.pow(lo, d - 1) * (d === 16 ? 3 : 1); w.push(x); tot += x; }"),

    ("M6  digitMean silently retuned",
     "  digitMean: 10,",
     "  digitMean: 6,"),

    ("M7  maxDigits cut to 20, which is exactly u64-max's length",
     "    maxDigits: 40,",
     "    maxDigits: 20,"),

    # ---- the table is not the draw ----------------------------------------
    ("M8  drawDigitCount ignores the table and draws uniform",
     "  const u = rng.next();\n  for (let i = 0; i < DIGIT_CDF.length; i++) if (u < DIGIT_CDF[i]) return i + 1;\n  return DIGIT_CDF.length;",
     "  return 1 + rng.int(CONFIG.caps.maxDigits);"),

    ("M9  drawDigitCount off by one",
     "  for (let i = 0; i < DIGIT_CDF.length; i++) if (u < DIGIT_CDF[i]) return i + 1;",
     "  for (let i = 0; i < DIGIT_CDF.length; i++) if (u < DIGIT_CDF[i]) return i + 2;"),

    ("M10 the mean solver stops early, so digitMean is approximate",
     "  for (let i = 0; i < 200; i++) {",
     "  for (let i = 0; i < 3; i++) {"),

    # ---- archetype rules ---------------------------------------------------
    ("M11 added key OVERWRITES on collision (near-uniform silently goes uniform)",
     "export function addedKeyName(row: Readonly<Record<string, unknown>>, first: string): string {\n  let k = `x${first}`, n = 0;\n  while (k in row) k = `x${first}${++n}`;\n  return k;\n}",
     "export function addedKeyName(row: Readonly<Record<string, unknown>>, first: string): string {\n  void row;\n  return `x${first}`;\n}"),

    ("M12 version left at 1 after a grammar change",
     "export const PROPERTY_GEN_VERSION = 2;",
     "export const PROPERTY_GEN_VERSION = 1;"),

    ("M13 digitMean dropped from the canonical config (invisible to run metadata)",
     "  digitMean: 10,",
     "  digitMean: 10, __unused: 0,"),

    # ---- the no-boundary-constant invariant itself -------------------------
    ("M14 a boundary constant introduced into the generator",
     "const DIGITS = \"0123456789\";",
     "const DIGITS = \"0123456789\";\nconst MAX_SAFE = 9007199254740991;"),
]


def run(cwd):
    r = subprocess.run(["node", "--experimental-strip-types", TEST],
                       cwd=cwd, capture_output=True, text=True)
    return r.stdout + r.stderr


def main():
    base = os.path.abspath(".")
    survived = []
    with tempfile.TemporaryDirectory() as tmp:
        work = os.path.join(tmp, "tree")
        shutil.copytree(base, work, ignore=shutil.ignore_patterns("node_modules", ".git"))
        original = open(SRC, encoding="utf8").read()

        out = run(work)
        if "PROVEN" not in out:
            print("BASELINE NOT GREEN — fix that before mutating.")
            print(out[-2000:])
            return 1
        print(f"baseline green: {out.strip().splitlines()[-1]}\n")

        target = os.path.join(work, "gen", "property.ts")
        for name, old, new in MUTATIONS:
            if old not in original:
                print(f"  SKIPPED   {name}   <-- anchor not found, mutation is stale")
                survived.append(name)
                continue
            open(target, "w", encoding="utf8").write(original.replace(old, new, 1))
            out = run(work)
            if "PROVEN" in out:
                print(f"  SURVIVED  {name}   <-- HOLE")
                survived.append(name)
            else:
                red = [l.strip() for l in out.splitlines() if l.startswith(" FAIL")]
                first = red[0].replace("FAIL", "").strip() if red else "crashed"
                print(f"  killed    {name}")
                print(f"            {len(red)} check(s) red, first: {first}")
        open(target, "w", encoding="utf8").write(original)

    print()
    if survived:
        print(f"{len(survived)} MUTATION(S) SURVIVED — the selftest has holes:")
        for s in survived:
            print(f"  {s}")
        return 1
    print(f"MUTATION PASS CLEAN: all {len(MUTATIONS)} mutations killed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
