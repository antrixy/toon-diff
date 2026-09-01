#!/usr/bin/env python3
"""Mutation pass for probe/grid.ts -- both geometries and the v0.4 vocabulary.

WHY NOW. grid.ts is one of the four modules in probe/ that has never carried a
mutation pass, and v0.4 just changed load-bearing code in it: the renderers took
vocabulary parameters and the one-sided lane took an oracle name, so that 4.5b's
consumers are not stuck with TOON's words.

A PARAMETER THAT IS ACCEPTED AND THEN IGNORED IS INDISTINGUISHABLE FROM NO
PARAMETER AT ALL. That is the M19 shape -- a check that cannot fail because the
fixture and the code agree by construction -- and this session already produced
it twice in numeric-domain.ts. So the generalization does not get to be trusted
on the strength of passing with its own defaults. Every mutation below either
re-hardwires a TOON word or drops a parameter on the floor; if the selftest
survives one, the generalization is decorative there.

The rest of the file's guards (unknown adapter, unknown case, duplicate record,
a pairwise record routed into the one-sided lane) are mutated too. They were
written in v0.3 and v0.4 and have never been shown to fail.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

SRC = os.path.abspath("probe/grid.ts")
TEST = "probe/selftest-grid.ts"

MUTATIONS = [
    # ---- THE VOCABULARY IS REACHED, NOT JUST ACCEPTED --------------------
    ("M1  pairwise header re-hardwires TOON's roles",
     '`GRID (${vocab.rowRole} row \\u2192 ${vocab.colRole} col): divergent ${vocab.unit} per pair, of ${report.caseCount}`',
     '`GRID (encoder row \\u2192 decoder col): divergent cases per pair, of ${report.caseCount}`'),

    ("M2  the unit falls back to TOON's word",
     "divergent ${vocab.unit} per pair",
     "divergent cases per pair"),

    ("M3  the axis label is re-hardwired",
     "      vocab.axisLabel,\n    ),\n  );\n  lines.push(`  ${MARK_CHAR.agree} = ${vocab.agreeLegend}`);",
     '      "enc\\\\\\\\dec",\n    ),\n  );\n  lines.push(`  ${MARK_CHAR.agree} = ${vocab.agreeLegend}`);'),

    ("M4  the pairwise agree legend is re-hardwired",
     "lines.push(`  ${MARK_CHAR.agree} = ${vocab.agreeLegend}`);",
     'lines.push(`  ${MARK_CHAR.agree} = all cases agree`);'),

    ("M5  the one-sided title is re-hardwired",
     "`${vocab.title} (case row \\u2192 col)",
     "`SPEC GRID (case row \\u2192 col)"),

    ("M6  the one-sided source note is re-hardwired",
     "${report.specChecks} check(s), ${vocab.sourceNote}`",
     "${report.specChecks} check(s), wire from SPEC.md \\u2014 no encoder in the loop`"),

    ("M7  the one-sided legends are re-hardwired",
     "`  ${MARK_CHAR.agree} = ${vocab.agreeLegend}   ` +\n      `${MARK_CHAR[\"value-mismatch\"]} = ${vocab.disagreeLegend}   ${MARK_CHAR.error} = error`",
     "`  ${MARK_CHAR.agree} = decodes as the spec says   ` +\n      `${MARK_CHAR[\"value-mismatch\"]} = disagrees with the spec   ${MARK_CHAR.error} = error`"),

    ("M8  the empty note is re-hardwired",
     "lines.push(`  ${vocab.emptyNote}`);",
     'lines.push("  (no spec cases)");'),

    ("M9  the one-sided axis label is re-hardwired",
     "  const label = vocab.axisLabel;",
     '  const label = "case\\\\\\\\dec";'),

    # ---- THE ORACLE NAME IS THE CONFIGURED ONE, NOT THE CONSTANT ---------
    ("M10 the oracle guard compares against SPEC_SIDE again",
     "    if (r.from !== oracle) {",
     "    if (r.from !== SPEC_SIDE) {"),

    ("M11 the oracle guard is removed entirely",
     "    if (r.from !== oracle) {",
     "    if (false) {"),

    # ---- ARITHMETIC AT ANY N, NOT JUST 3 --------------------------------
    ("M12 pairChecks hardwires a 3-implementation matrix",
     "    pairChecks: caseKeys.length * adapterNames.length * adapterNames.length,",
     "    pairChecks: caseKeys.length * 3 * 3,"),

    ("M13 pairChecks drops one dimension",
     "    pairChecks: caseKeys.length * adapterNames.length * adapterNames.length,",
     "    pairChecks: caseKeys.length * adapterNames.length,"),

    ("M14 one-sided checks counted as N x N",
     "    specChecks: specCaseKeys.length * decoderNames.length,",
     "    specChecks: specCaseKeys.length * decoderNames.length * decoderNames.length,"),

    # ---- THE HARNESS-BUG GUARDS (never yet shown to fail) ---------------
    ("M15 unknown encoder accepted in the pairwise grid",
     'if (fi === undefined) throw new Error(`grid: divergence names unknown adapter "${r.from}" — harness bug`);',
     "if (fi === undefined) continue;"),

    ("M16 unknown decoder accepted in the pairwise grid",
     'if (ti === undefined) throw new Error(`grid: divergence names unknown adapter "${r.to}" — harness bug`);',
     "if (ti === undefined) continue;"),

    ("M17 unknown case accepted in the pairwise grid",
     'if (!caseIdx.has(r.file)) throw new Error(`grid: divergence names unknown case "${r.file}" — harness bug`);',
     "if (!caseIdx.has(r.file)) { /* accepted */ }"),

    ("M18 duplicate pair records are absorbed instead of thrown",
     "      throw new Error(`grid: duplicate divergence for ${r.file} (${r.from} -> ${r.to}) — harness bug`);",
     "      continue;"),

    ("M19 unknown decoder accepted in the one-sided lane",
     '      throw new Error(`spec grid: divergence names unknown decoder "${r.to}" — harness bug`);',
     "      continue;"),

    ("M20 duplicate one-sided records are absorbed",
     "      throw new Error(`spec grid: duplicate divergence for ${r.file} (${r.to}) — harness bug`);",
     "      continue;"),

    # ---- MARKS AND ORDERING ---------------------------------------------
    ("M21 every divergence renders as a value-mismatch (error mark lost)",
     '    marks[r.file][r.to] = r.error !== undefined ? "error" : "value-mismatch";',
     '    marks[r.file][r.to] = "value-mismatch";'),

    ("M22 error counting inverted in the pairwise grid",
     "    if (r.error !== undefined) cell.errorCount++;",
     "    if (r.error === undefined) cell.errorCount++;"),

    ("M23 cells transposed (encoder and decoder axes swapped)",
     "    const cell = cells[fi][ti];",
     "    const cell = cells[ti][fi];"),

    ("M24 default marks are mismatch rather than agree",
     '          marks[from][to] = src.get(`${from}\\u0000${to}`) ?? "agree";',
     '          marks[from][to] = src.get(`${from}\\u0000${to}`) ?? "value-mismatch";'),
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
        shutil.copytree(base, work, ignore=shutil.ignore_patterns("node_modules", ".git", ".venv"))
        original = open(SRC, encoding="utf8").read()

        out = run(work)
        if "PROVEN" not in out:
            print("BASELINE NOT GREEN — fix that before mutating.")
            print(out[-2000:])
            return 1
        print(f"baseline green: {out.strip().splitlines()[-1][:100]}\n")

        target = os.path.join(work, "probe", "grid.ts")
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
                print(f"            {len(red)} check(s) red, first: {first[:88]}")
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
