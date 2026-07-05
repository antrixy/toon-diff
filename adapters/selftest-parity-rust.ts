// adapters/selftest-parity-rust.ts
//
// Proves the PERSISTENT rust adapter is behaviorally identical to the one-shot
// rust adapter. A speedup that silently changed a single encode/decode result
// would manufacture false findings (or hide real ones) — so the persistent path
// is not trusted for sweeps until this passes. Rust analogue of
// adapters/selftest-parity.ts.
//
// For every case (the 13 seeds + a batch of generated cases) it checks:
//   * encode:  oneshot.encode(C)      vs  persistent.encode(C)
//   * decode:  oneshot.decode(T)      vs  persistent.decode(T)    where T = encode(C)
// and requires, for each: both succeed with BYTE-IDENTICAL output, OR both fail.
// A success-vs-failure split, or differing bytes, is a parity break.
//
// FULL ENV ONLY (needs the bridge built: cd adapters/rust-bridge && cargo build --release).
// Run: node --experimental-strip-types adapters/selftest-parity-rust.ts [--per 30]

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rustAdapter } from "./rust.ts";
import { rustAdapterPersistent, shutdownRust } from "./rust-persistent.ts";
import { generateCase } from "../gen/generate.ts";

const args = process.argv.slice(2);
const perArg = args.indexOf("--per");
const per = perArg >= 0 && args[perArg + 1] ? parseInt(args[perArg + 1], 10) : 30;

const casesDir = fileURLToPath(new URL("../probe/cases/", import.meta.url));
const seeds = readdirSync(casesDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => ({ name: f, text: readFileSync(casesDir + f, "utf8").trim() }));

type Attempt = { ok: boolean; val?: string; err?: string };
async function attempt(fn: () => Promise<string>): Promise<Attempt> {
  try { return { ok: true, val: await fn() }; }
  catch (e) { return { ok: false, err: e instanceof Error ? e.message : String(e) }; }
}

let checks = 0, mismatches = 0;
let bothOk = 0, bothErr = 0;

function compare(label: string, a: Attempt, b: Attempt): void {
  checks++;
  if (a.ok && b.ok) {
    if (a.val === b.val) { bothOk++; return; }
    mismatches++;
    console.log(` FAIL ${label}: outputs differ`);
    console.log(`   oneshot:    ${(a.val ?? "").slice(0, 120)}`);
    console.log(`   persistent: ${(b.val ?? "").slice(0, 120)}`);
  } else if (!a.ok && !b.ok) {
    bothErr++; // both failed — parity holds (error text may differ in wrapping)
  } else {
    mismatches++;
    console.log(` FAIL ${label}: one succeeded, the other failed`);
    console.log(`   oneshot:    ${a.ok ? "ok" : "ERR " + (a.err ?? "").split("\n")[0]}`);
    console.log(`   persistent: ${b.ok ? "ok" : "ERR " + (b.err ?? "").split("\n")[0]}`);
  }
}

const main = async () => {
  const cases: { label: string; text: string }[] = [];
  for (const s of seeds) cases.push({ label: `seed ${s.name}`, text: s.text });
  seeds.forEach((s, si) => {
    for (let i = 0; i < per; i++) {
      const rngSeed = (1 * 1_000_003 + si * 9973 + i) >>> 0;
      cases.push({
        label: `${s.name} g${i} (rngSeed ${rngSeed})`,
        text: generateCase(s.text, rngSeed, { seedName: s.name, maxOps: 3 }).text,
      });
    }
  });

  console.log(`parity check (rust): ${cases.length} cases (${seeds.length} seeds + ${seeds.length}x${per} generated)\n`);

  for (const c of cases) {
    const e1 = await attempt(() => rustAdapter.encode(c.text));
    const e2 = await attempt(() => rustAdapterPersistent.encode(c.text));
    compare(`encode ${c.label}`, e1, e2);

    const toon = e1.ok ? e1.val! : e2.ok ? e2.val! : null;
    if (toon !== null) {
      const d1 = await attempt(() => rustAdapter.decode(toon));
      const d2 = await attempt(() => rustAdapterPersistent.decode(toon));
      compare(`decode ${c.label}`, d1, d2);
    }
  }

  console.log(`\nchecks: ${checks} | both-ok: ${bothOk} | both-error: ${bothErr} | mismatches: ${mismatches}`);
  console.log(mismatches === 0
    ? "\nPARITY PROVEN: persistent rust adapter matches one-shot byte-for-byte. Safe for big sweeps."
    : `\nPARITY BROKEN: ${mismatches} mismatch(es) — do NOT use the persistent rust adapter until fixed.`);
  shutdownRust();
  process.exit(mismatches === 0 ? 0 : 1);
};

main();
