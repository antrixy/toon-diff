/**
 * probe/selftest-corpus.ts — proves the v0.3 corpus loader.
 *
 * Part 1: the real corpus loads, all 13 migrated seeds are present, every case
 *         carries raw text byte-identical to what's on disk (trimmed only) and
 *         a validated sidecar.
 * Part 2: against synthetic corpora in a temp dir, the loader REJECTS every
 *         class of malformation — missing sidecar, orphan sidecar, bad name,
 *         duplicate id, malformed case JSON, bad meta, stray root files —
 *         and loading is all-or-nothing.
 *
 * Pure: no TOON implementations needed. Run:
 *     node --experimental-strip-types probe/selftest-corpus.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCorpus, defaultCorpusRoot, BUCKETS } from "./corpus.ts";

let pass = 0;
let fail = 0;
function ok(label: string, got: unknown, want: unknown) {
  const good = Object.is(got, want);
  if (good) pass++;
  else fail++;
  console.log(`  ${good ? "ok  " : "FAIL"} ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// ---------- Part 1: the real corpus ----------
console.log("Part 1: real corpus");
const corpus = loadCorpus();
ok("13 cases load", corpus.cases.length, 13);
ok("all 13 are in seeds/", corpus.byBucket.seeds.length, 13);
ok("other buckets are empty", BUCKETS.filter((b) => b !== "seeds").every((b) => corpus.byBucket[b].length === 0), true);
ok("ids are unique in bucket", new Set(corpus.byBucket.seeds.map((c) => c.id)).size, 13);
ok("keys are corpus-relative", corpus.cases.every((c) => c.key === `${c.bucket}/${c.id}-${c.name}.json`), true);
ok("every meta has origin + invariant", corpus.cases.every((c) => c.meta.origin.length > 0 && c.meta.invariant.length > 0), true);
const c013 = corpus.cases.find((c) => c.id === "013")!;
ok("013 carries refs", Array.isArray(c013.meta.refs) && c013.meta.refs.length > 0, true);

// Spec-rule references (v0.3 explained-failures wiring).
const c002 = corpus.cases.find((c) => c.id === "002")!;
ok("002 references its spec rule", (c002.meta.specRules ?? []).includes("empty-array-canonical-literal"), true);
ok("013 references its spec rule", (c013.meta.specRules ?? []).includes("integer-precision-lossless"), true);
ok("only 002 and 013 carry specRules so far", corpus.cases.filter((c) => c.meta.specRules !== undefined).length, 2);

// Raw-text fidelity: loader output must be the on-disk bytes, trimmed only.
const raw013 = readFileSync(join(defaultCorpusRoot(), "seeds/013-precision-loss-2pow53plus1.json"), "utf8").trim();
ok("013 text is byte-identical to disk (trim only)", c013.text === raw013, true);
ok("013 lexeme preserved (no 9007199254740992 corruption)", c013.text.includes("9007199254740993"), true);

// ---------- Part 2: rejection of malformed corpora ----------
console.log("Part 2: malformed corpora are rejected (all-or-nothing)");

function expectReject(label: string, needle: string, build: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "corpus-"));
  try {
    build(root);
    let threw = "";
    try {
      loadCorpus(root);
    } catch (e) {
      threw = (e as Error).message;
    }
    ok(`${label}: rejected`, threw !== "", true);
    ok(`${label}: message names the problem`, threw.includes(needle), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const goodCase = (dir: string, stem: string) => {
  writeFileSync(join(dir, `${stem}.json`), `{"a":1}`);
  writeFileSync(join(dir, `${stem}.meta.json`), `{"origin":"t","invariant":"t"}`);
};

expectReject("missing sidecar", "missing sidecar", (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
});
expectReject("orphan sidecar", "no matching case file", (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  goodCase(d, "001-a");
  writeFileSync(join(d, "002-b.meta.json"), `{"origin":"t","invariant":"t"}`);
});
expectReject("bad case name", "must match NNN-kebab-name.json", (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  goodCase(d, "001-a");
  writeFileSync(join(d, "1-BadName.json"), `{}`);
  writeFileSync(join(d, "1-BadName.meta.json"), `{"origin":"t","invariant":"t"}`);
});
expectReject("duplicate id in bucket", "duplicate id 001", (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  goodCase(d, "001-a");
  goodCase(d, "001-b");
});
expectReject("malformed case JSON", "not well-formed JSON", (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{"a":`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t","invariant":"t"}`);
});
expectReject("meta missing invariant", `"invariant" must be a non-empty string`, (root) => {
  const d = join(root, "regressions");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t"}`);
});
expectReject("specRules with unknown rule id", `unknown rule "no-such-rule"`, (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t","invariant":"t","specRules":["no-such-rule"]}`);
});
expectReject("specRules with wrong shape", `"specRules" must be an array`, (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t","invariant":"t","specRules":"empty-array-canonical-literal"}`);
});
expectReject("specRules empty array", `omit the field or list at least one`, (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t","invariant":"t","specRules":[]}`);
});
expectReject("specRules duplicate ids", `must not contain duplicate rule ids`, (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t","invariant":"t","specRules":["empty-array-canonical-literal","empty-array-canonical-literal"]}`);
});
expectReject("meta with unknown field", `unknown field "fix"`, (root) => {
  const d = join(root, "seeds");
  mkdirSync(d);
  writeFileSync(join(d, "001-a.json"), `{}`);
  writeFileSync(join(d, "001-a.meta.json"), `{"origin":"t","invariant":"t","fix":"use BigInt"}`);
});
expectReject("stray file at corpus root (pre-v0.3 layout)", "unexpected entry at corpus root", (root) => {
  writeFileSync(join(root, "001-a.json"), `{}`);
});

// All-or-nothing: one bad case in an otherwise good corpus loads nothing.
{
  const root = mkdtempSync(join(tmpdir(), "corpus-"));
  const d = join(root, "seeds");
  mkdirSync(d);
  goodCase(d, "001-a");
  goodCase(d, "002-b");
  writeFileSync(join(d, "003-c.json"), `{}`); // no sidecar
  let threw = false;
  try {
    loadCorpus(root);
  } catch {
    threw = true;
  }
  ok("all-or-nothing: 2 good + 1 bad loads nothing", threw, true);
  rmSync(root, { recursive: true, force: true });
}

console.log();
if (fail === 0) {
  console.log(`CORPUS LOADER PROVEN: ${pass} checks pass. Buckets, sidecars, and raw-text fidelity are enforced; malformed corpora are refused whole.`);
} else {
  console.log(`CORPUS LOADER FAILED: ${fail} of ${pass + fail} checks failed.`);
  process.exit(1);
}
