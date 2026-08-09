#!/usr/bin/env python3
"""Mutation pass for gen/finding-log.ts.

Each mutation is a defect a reviewer could plausibly introduce, or the exact
pre-fix behaviour of gen/shrink-cli.ts. A mutation that leaves the selftest GREEN
is a hole in the selftest, not a harmless edit.

Runs against a scratch copy; the real tree is never modified.

Re-run whenever finding-log.ts changes. A SURVIVED line is a hole.
"""
import shutil, subprocess, sys, tempfile, os

SRC = os.path.abspath("gen/finding-log.ts")
TEST = "gen/selftest-finding-log.ts"

MUTATIONS = [
    # The defect this module exists to close.
    ("M1  property regex removed (the pre-fix defect: property findings invisible)",
     "    const p = PROPERTY_RE.exec(line);\n    if (p) {",
     "    const p = null as RegExpExecArray | null;\n    if (p) {"),

    ("M2  property recipes deduped on the PAIR, so one case shrinks nine times",
     '      ? `prop|${f.recipe}`',
     '      ? `prop|${f.from}->${f.to}|${f.recipe}`'),

    ("M3  malformed recipe guessed at instead of dropped",
     "      if (identity) out.push({ kind: \"property\", from: p[1], to: p[2], recipe: p[3], identity });",
     "      out.push({ kind: \"property\", from: p[1], to: p[2], recipe: p[3], identity: identity ?? { version: 1, channel: \"general\", rngSeed: 0, size: 0 } });"),

    ("M4  version split accepts every version (the refusal rule dropped)",
     "    if (f.identity.version === currentVersion) { current.push(f); continue; }",
     "    { current.push(f); continue; }"),

    ("M5  version mismatch silently skipped rather than reported",
     "    const list = refused.get(f.identity.version) ?? [];\n    list.push(f);\n    refused.set(f.identity.version, list);",
     "    continue;"),

    ("M6  refusal report emitted but empty (reporting half lost)",
     "  if (split.refused.size === 0) return [];",
     "  return [];\n  if (split.refused.size === 0) return [];"),

    ("M7  refusal report loses the count",
     '    `REFUSED: ${[...split.refused.values()].reduce((n, l) => n + l.length, 0)} property recipe(s) ` +',
     '    `REFUSED: some property recipe(s) ` +'),

    ("M8  refusal report loses the authoritative-bytes pointer",
     '  lines.push(`  Use the stored case files, which are authoritative.`);',
     '  lines.push(`  Skipping.`);'),

    ("M9  mutation operator detail no longer stripped, so keys never group",
     '      if (rm) ops = rm[1].replace(/\\([^)]*\\)/g, "").trim();',
     '      if (rm) ops = rm[1].trim();'),

    ("M10 mutation dedup key loses the pair (behaviour this commit must NOT change)",
     '      : `mut|${f.from}->${f.to}|${f.seed}|${f.ops}`;',
     '      : `mut|${f.seed}|${f.ops}`;'),

    ("M11 a passing line counts as a finding",
     "const PAIR = String.raw`^(ts|python|rust) → (ts|python|rust)\\s+✗\\s+`;",
     "const PAIR = String.raw`^(ts|python|rust) → (ts|python|rust)\\s+.\\s+`;"),

    ("M14 property regex anchored at end of line (drops every skewed-pair finding)",
     "const PROPERTY_RE = new RegExp(PAIR + String.raw`(prop:\\S+)`);",
     "const PROPERTY_RE = new RegExp(PAIR + String.raw`(prop:\\S+)\\s*$`);"),

    ("M12 property regex anchors on the full grammar, so a FUTURE version cannot be reported",
     "const PROPERTY_RE = new RegExp(PAIR + String.raw`(prop:\\S+)`);",
     "const PROPERTY_RE = new RegExp(PAIR + String.raw`(prop:v1/\\S+)`);"),

    ("M13 mutation findings dropped entirely",
     "    const m = MUTATION_RE.exec(line);\n    if (m) {",
     "    const m = null as RegExpExecArray | null;\n    if (m) {"),
]


def run(cwd):
    r = subprocess.run([sys.executable and "node", "--experimental-strip-types", TEST],
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

        target = os.path.join(work, "gen", "finding-log.ts")
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
