#!/usr/bin/env python3
"""Mutation pass for probe/numeric-domain.ts -- domains, and the relay credit.

WHY THIS EXISTS, AND WHY NOW. This module carried a real defect for weeks and
the selftest stayed green through all of it: inDomain() unioned the i64/u64
window with the exactly-representable doubles, on a reading of serde_json's
model that was never checked against the binary, and selftest-numeric-domain.ts
asserted "2^100 is in-domain via the f64 fallback" -- a check that could not
fail, because the only thing it tested was the model agreeing with itself.
The 2026-08-30 boundary measurement refuted it: rust stringifies 2^100.

That is the M19 shape and the 08-14 judge rule, on a third file. So the
corrected logic does not get to be trusted on the strength of being newer.

WHAT THIS PASS CAN AND CANNOT DO. It proves the selftest would NOTICE if the
model changed. It CANNOT prove the model matches rust, python or ts -- only
measurement does that, and the measured ladder is recorded in
IMPL_CLAIMS.rust.numeric.domainEvidence. Mutations here therefore target the
boundary arithmetic and the relay logic, which are ours; the domain FACTS are
upstream's and are pinned by evidence, not by this file.

Runs against a scratch copy; the real tree is never modified.
"""
import shutil, subprocess, sys, tempfile, os

SRC = os.path.abspath("probe/numeric-domain.ts")
TEST = "probe/selftest-numeric-domain.ts"

MUTATIONS = [
    # ---- THE DEFECT ITSELF: it must never be able to come back -------------
    ("M1  the f64 fallback is restored (the exact defect measurement refuted)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return (v >= -TWO_63 && v < TWO_64) || isExactF64Integer(v);"),

    ("M2  the window widened to i128 (a plausible wrong reading of the crate)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return v >= -(2n ** 127n) && v < 2n ** 127n;"),

    ("M3  the window collapsed to i64 only (drops the u64 half)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return v >= -TWO_63 && v < TWO_63;"),

    # ---- boundary arithmetic, both edges, both directions ------------------
    ("M4  upper edge off by one (u64 max excluded)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return v >= -TWO_63 && v < TWO_64 - 1n;"),

    ("M5  upper edge inclusive (2^64 wrongly admitted)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return v >= -TWO_63 && v <= TWO_64;"),

    ("M6  lower edge exclusive (i64 min wrongly rejected)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return v > -TWO_63 && v < TWO_64;"),

    ("M7  lower edge unbounded (negatives never leave the domain)",
     "      return v >= -TWO_63 && v < TWO_64;",
     "      return v < TWO_64;"),

    # ---- the f64 exactness test (013's verdict rests on it) ---------------
    ("M8  f64 exactness becomes the naive |v| <= 2^53 test",
     "  while (m % 2n === 0n) m /= 2n; // strip trailing zero bits\n  return m < TWO_53;",
     "  return m < TWO_53;"),

    # M9 RETIRED AS AN EQUIVALENT MUTANT, 2026-08-30. Recorded here rather than
    # deleted, and NOT killed by a manufactured check.
    #   ("M9  f64 exactness off by one at the significand",
    #    "  return m < TWO_53;", "  return m <= TWO_53;")
    # The two predicates can differ only where the stripped part m equals 2^53
    # exactly. The strip loop `while (m % 2n === 0n) m /= 2n` exits only when m
    # is ODD, and m === 0n is returned before it; 2^53 is even, so that value is
    # unreachable and the mutant is behaviourally identical.
    # Confirmed on evidence as well as argument, the way S12 was retired:
    # differential-tested over 80,420 values (every 2^k, 2^k±1, 3*2^k and
    # 2^53*2^k for k<70, plus 20k linear and multiplied values, negatives
    # included) -- ZERO differed.
    ("M10 f64 has no upper magnitude limit (1e400 would be 'exact')",
     "  if (m >= F64_MAX_MAGNITUDE) return false;",
     "  if (false) return false;"),

    # ---- bignum must stay unbounded ---------------------------------------
    ("M11 bignum acquires a boundary",
     '    case "bignum":\n      return true;',
     '    case "bignum":\n      return v < TWO_64;'),

    # ---- THE RELAY CREDIT: the guard that replaced the nesting assumption --
    ("M12 relay credited unconditionally (the pre-measurement assumption)",
     "    if (relayLandsInDomain(value, e.domain, d.domain)) {",
     "    if (true) {"),

    ("M13 relay never credited (over-correction: 013 would gain a fault)",
     "    if (relayLandsInDomain(value, e.domain, d.domain)) {",
     "    if (false) {"),

    ("M14 relay soundness ignores the decoder's domain",
     "      return inDomain(decoderDomain, approx.toString());",
     "      return inDomain(\"bignum\", approx.toString());"),

    ("M15 relay checks the ORIGINAL value, not the encoder's approximation",
     "      return inDomain(decoderDomain, approx.toString());",
     "      return inDomain(decoderDomain, value);"),

    ("M16 f64 approximation returns the value unrounded",
     "  const n = Number(value);\n  if (!Number.isFinite(n)) return null;\n  return BigInt(n);",
     "  return BigInt(value);"),

    ("M17 an i64u64 encoder is treated as losing data (it emits a lossless string)",
     '    case "i64u64": {\n      // Lossless string on the wire — nothing numeric was lost to relay.\n      return true;\n    }',
     '    case "i64u64": {\n      return false;\n    }'),

    # ---- THE TOKEN-FORM BRANCH: added after the guard was wrong TWICE -----
    # The first guard ignored the wire form entirely and called ts->rust
    # unsound at 2^100+1; ts emits exponent there and rust returns a number.
    # A constant nobody mutates is a constant that drifts back.
    ("M23 the exponent branch is removed (the first wrong guard, restored)",
     "      if (mag >= EXPONENT_FORM_THRESHOLD) return true;",
     "      if (false) return true;"),

    ("M24 every f64 relay is credited (the exponent branch swallows the plain band)",
     "      if (mag >= EXPONENT_FORM_THRESHOLD) return true;",
     "      if (true) return true;"),

    ("M25 the §2 form threshold retuned to 1e18",
     "const EXPONENT_FORM_THRESHOLD = 10n ** 21n;",
     "const EXPONENT_FORM_THRESHOLD = 10n ** 18n;"),

    ("M26 the §2 form threshold off by one order",
     "const EXPONENT_FORM_THRESHOLD = 10n ** 21n;",
     "const EXPONENT_FORM_THRESHOLD = 10n ** 22n;"),

    ("M27 the threshold comparison is exclusive at 1e21",
     "      if (mag >= EXPONENT_FORM_THRESHOLD) return true;",
     "      if (mag > EXPONENT_FORM_THRESHOLD) return true;"),

    ("M28 magnitude ignored, so negatives never reach the exponent branch",
     "      const mag = approx < 0n ? -approx : approx;",
     "      const mag = approx;"),

    # ---- per-side attribution (the 013 lesson) ----------------------------
    ("M18 encoder credited as conformant while out-of-domain",
     "  if (inDomain(e.domain, value)) {",
     "  if (true) {"),

    ("M19 an undocumented decoder policy stops being a violation",
     "  if (d.decoderPolicy === null) {",
     "  if (false) {"),

    ("M20 the documentation-fault wording is dropped (report reads as data loss)",
     " — note this is a DOCUMENTATION fault: §4 permits a higher-precision type, a string, an approximation, or rejection, so even an implementation already doing the RECOMMENDED lossless-first thing owes the written policy",
     ""),

    # ---- the governing probe ----------------------------------------------
    ("M21 governingProbe returns the first integer regardless of domain",
     "    if (!inDomain(e.domain, v) || !inDomain(d.domain, v)) return v;",
     "    return v;"),

    ("M22 governingProbe requires BOTH sides out-of-domain",
     "    if (!inDomain(e.domain, v) || !inDomain(d.domain, v)) return v;",
     "    if (!inDomain(e.domain, v) && !inDomain(d.domain, v)) return v;"),
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

        target = os.path.join(work, "probe", "numeric-domain.ts")
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
                print(f"            {len(red)} check(s) red, first: {first[:90]}")
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
