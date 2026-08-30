#!/usr/bin/env python3
"""Mutation pass for probe/spec-run.ts -- the one-sided spec comparison.

WHY THIS FILE IS NOT OPTIONAL. A spec case that passes against a decoder that
ignores it is worthless, and a comparison that cannot fail reports as coverage.
The v0.4 mutation sessions found five real defects, and three of them were
guarantees stated in a comment that the harness structurally could not see --
so a NEW check on a NEW path gets the same treatment before it is trusted.

THE CENTRAL MUTATION IS M1. If the comparison goes through a double anywhere,
18446744073709551617 and 18446744073709551616 become the same value and the
u64 case -- the entire reason the spec bucket opens with this fault line --
reports GREEN against a decoder that lost the value. That is compare.ts's
named worst failure mode: a false PASS.

THE JUDGE RULE APPLIES HERE TOO. selftest-spec-run.ts is oracle-judged, and the
oracle ignores key order and whitespace, so this pass cannot prove anything
about those. It does not try; the key-order case is an ASSERTED behavior in the
selftest instead. What is mutated here is what the oracle CAN see: the operands
of the comparison, the counter, the record's identity, and the guards.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

SRC = os.path.abspath("probe/spec-run.ts")
TEST = "probe/selftest-spec-run.ts"

MUTATIONS = [
    # ---- the comparison must be LOSSLESS ----------------------------------
    ("M1  comparison routed through JSON (a double), so 2^64+1 == 2^64",
     "        if (!equal(ingest(got), expected)) {",
     "        if (JSON.stringify(JSON.parse(got)) !== JSON.stringify(JSON.parse(c.text))) {"),

    ("M2  comparison is string equality (key order becomes a false finding)",
     "        if (!equal(ingest(got), expected)) {",
     "        if (got !== c.text) {"),

    # ---- the comparison must have two DIFFERENT operands ------------------
    ("M3  expected compared to itself -- every decoder always agrees",
     "        if (!equal(ingest(got), expected)) {",
     "        if (!equal(expected, expected)) {"),

    ("M4  decoder output compared to itself -- same tautology, other side",
     "        if (!equal(ingest(got), expected)) {",
     "        if (!equal(ingest(got), ingest(got))) {"),

    ("M5  comparison inverted (agreement recorded, divergence dropped)",
     "        if (!equal(ingest(got), expected)) {",
     "        if (equal(ingest(got), expected)) {"),

    # ---- the input must be the WIRE, and the oracle the BODY --------------
    ("M6  decodes the expected JSON instead of the wire text",
     "        const got = await X.decode(c.wire);",
     "        const got = await X.decode(c.text);"),

    ("M7  oracle taken from the wire instead of the spec-mandated body",
     "    const expected = ingest(c.text);",
     "    const expected = ingest(c.wire!);"),

    # ---- errors are evidence, not noise -----------------------------------
    ("M8  a throwing decoder is swallowed instead of recorded",
     "      } catch (e) {\n        records.push({\n          file: c.key,\n          from: SPEC_SIDE,\n          to: X.name,\n          expected: c.text,\n          actual: \"\",\n          error: e instanceof Error ? e.message : String(e),\n        });\n      }",
     "      } catch {\n        // swallowed\n      }"),

    ("M9  the error text is dropped, so a record cannot be triaged",
     "          error: e instanceof Error ? e.message : String(e),",
     "          error: \"\",".replace("\"\"", "undefined")),

    # ---- the record's identity -------------------------------------------
    ("M10 records name the DECODER as encoder (spec lane becomes a self-pair)",
     "          records.push({\n            file: c.key,\n            from: SPEC_SIDE,",
     "          records.push({\n            file: c.key,\n            from: X.name,"),

    ("M11 the expected side is filled from the decoder's own output",
     "            expected: c.text,\n            actual: got,",
     "            expected: got,\n            actual: got,"),

    # ---- the counter is a tripwire, not decoration ------------------------
    ("M12 checks counted per CASE instead of per (case, decoder)",
     "      specChecks++;",
     "      if (X === decoders[0]) specChecks++;"),

    ("M13 the counter is never incremented (a run that compared nothing)",
     "      specChecks++;",
     "      void 0;"),

    ("M14 the counter is inflated to N x N (pairwise arithmetic leaks in)",
     "      specChecks++;",
     "      specChecks += decoders.length;"),

    # ---- coverage: every case, every decoder ------------------------------
    ("M15 only the first decoder is ever run",
     "    for (const X of decoders) {",
     "    for (const X of decoders.slice(0, 1)) {"),

    ("M16 the loop stops at the first divergence",
     "            actual: got,\n          });",
     "            actual: got,\n          });\n          break;"),

    # ---- the guards -------------------------------------------------------
    ("M17 a non-spec case is accepted (pairwise case judged one-sided)",
     "    if (c.bucket !== \"spec\") {",
     "    if (false) {"),

    ("M18 a wireless case is skipped instead of throwing (silent no-coverage)",
     "    if (c.wire === undefined) {\n      throw new Error(`spec-run: spec case \"${c.key}\" has no wire text — harness bug`);\n    }",
     "    if (c.wire === undefined) {\n      continue;\n    }"),

    ("M19 SPEC_SIDE renamed to a real adapter name",
     "export const SPEC_SIDE = \"spec\";",
     "export const SPEC_SIDE = \"ts\";"),
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

        target = os.path.join(work, "probe", "spec-run.ts")
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
                red = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL")]
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
