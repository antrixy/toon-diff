/**
 * probe/corpus.ts — the single corpus loader (v0.3).
 *
 * The corpus is organized by PROVENANCE. A spec example, a preserved past bug,
 * and a fuzz-generated case are different things, and both the tool and a
 * contributor should be able to tell which is which:
 *
 *   probe/cases/seeds/        hand-written v0.1 seeds (mutation substrate)
 *   probe/cases/spec/         examples lifted from normative spec text
 *   probe/cases/regressions/  fixed upstream bugs that must never return
 *   probe/cases/generated/    fuzz-found cases promoted into the corpus
 *   probe/cases/community/    contributed cases
 *
 * Every case is a pair:  NNN-name.json  +  NNN-name.meta.json
 * The .json file is the input, kept as RAW TEXT end to end — the loader never
 * parses-and-reserializes it, because number lexemes (-0, 1.0, 2^53+1) are the
 * point. It is only checked for well-formedness via the oracle's lossless
 * ingest, which reads lexemes from source text.
 *
 * The .meta.json sidecar answers two questions in one line each:
 *   origin    — where did this case come from?
 *   invariant — what property does it protect?
 * plus optional refs (spec clauses, upstream issue URLs).
 *
 * Validation is strict and loading is all-or-nothing: a conformance suite must
 * refuse an ambiguous corpus rather than silently skip parts of it.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingest } from "../oracle/ingest.ts";

export const BUCKETS = [
  "seeds",
  "spec",
  "regressions",
  "generated",
  "community",
] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface CaseMeta {
  /** One line: where did this case come from? */
  origin: string;
  /** One line: what invariant does it protect? */
  invariant: string;
  /** Optional: spec clauses ("§2.1"), upstream issues (URLs), etc. */
  refs?: string[];
}

export interface CorpusCase {
  /** e.g. "011" — unique within its bucket. */
  id: string;
  /** e.g. "safe-integer-boundary". */
  name: string;
  /** e.g. "seeds/011-safe-integer-boundary.json" (corpus-relative, stable key). */
  key: string;
  bucket: Bucket;
  /** Raw source text of the case, trimmed, lexemes untouched. */
  text: string;
  meta: CaseMeta;
}

export interface Corpus {
  cases: CorpusCase[];
  byBucket: Record<Bucket, CorpusCase[]>;
}

const CASE_RE = /^(\d{3})-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const META_SUFFIX = ".meta.json";

export function defaultCorpusRoot(): string {
  return fileURLToPath(new URL("./cases/", import.meta.url));
}

/** Load and validate the whole corpus. Throws with every problem listed. */
export function loadCorpus(root: string = defaultCorpusRoot()): Corpus {
  const problems: string[] = [];
  const cases: CorpusCase[] = [];
  const byBucket = Object.fromEntries(
    BUCKETS.map((b) => [b, [] as CorpusCase[]]),
  ) as Record<Bucket, CorpusCase[]>;

  if (!existsSync(root)) throw new Error(`corpus root not found: ${root}`);

  // Anything at the top level that isn't a known bucket is a mistake —
  // most likely a case file left in the pre-v0.3 flat layout.
  for (const entry of readdirSync(root)) {
    if (!(BUCKETS as readonly string[]).includes(entry)) {
      problems.push(
        `unexpected entry at corpus root: "${entry}" (cases live in ${BUCKETS.join("/, ")}/)`,
      );
    }
  }

  for (const bucket of BUCKETS) {
    const dir = join(root, bucket);
    if (!existsSync(dir)) continue; // empty buckets simply don't exist yet
    if (!statSync(dir).isDirectory()) {
      problems.push(`${bucket} exists but is not a directory`);
      continue;
    }

    const files = readdirSync(dir).sort();
    const caseFiles = files.filter(
      (f) => f.endsWith(".json") && !f.endsWith(META_SUFFIX),
    );
    const metaFiles = new Set(files.filter((f) => f.endsWith(META_SUFFIX)));
    const seenIds = new Map<string, string>(); // id -> filename

    for (const f of files) {
      if (!f.endsWith(".json")) {
        problems.push(`${bucket}/${f}: not a .json or .meta.json file`);
      }
    }

    for (const file of caseFiles) {
      const where = `${bucket}/${file}`;
      const m = CASE_RE.exec(file);
      if (!m) {
        problems.push(
          `${where}: name must match NNN-kebab-name.json (e.g. 001-empty-object.json)`,
        );
        continue;
      }
      const [, id, name] = m;

      const dup = seenIds.get(id);
      if (dup) problems.push(`${where}: duplicate id ${id} (also ${bucket}/${dup})`);
      else seenIds.set(id, file);

      const metaName = file.slice(0, -".json".length) + META_SUFFIX;
      if (!metaFiles.has(metaName)) {
        problems.push(`${where}: missing sidecar ${metaName}`);
        continue;
      }
      metaFiles.delete(metaName);

      // Case text: raw, trimmed, and provably well-formed via lossless ingest.
      const text = readFileSync(join(dir, file), "utf8").trim();
      try {
        ingest(text);
      } catch (e) {
        problems.push(`${where}: not well-formed JSON: ${(e as Error).message}`);
        continue;
      }

      // Sidecar: parsed normally (it's metadata, not test input).
      let meta: CaseMeta;
      try {
        meta = validateMeta(JSON.parse(readFileSync(join(dir, metaName), "utf8")));
      } catch (e) {
        problems.push(`${bucket}/${metaName}: ${(e as Error).message}`);
        continue;
      }

      const c: CorpusCase = {
        id,
        name,
        key: `${bucket}/${file}`,
        bucket,
        text,
        meta,
      };
      cases.push(c);
      byBucket[bucket].push(c);
    }

    for (const orphan of metaFiles) {
      problems.push(`${bucket}/${orphan}: sidecar has no matching case file`);
    }
  }

  if (problems.length) {
    throw new Error(
      `corpus validation failed (${problems.length} problem${problems.length === 1 ? "" : "s"}):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  return { cases, byBucket };
}

function validateMeta(raw: unknown): CaseMeta {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("meta must be a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const bad: string[] = [];
  if (typeof o.origin !== "string" || o.origin.trim() === "") {
    bad.push(`"origin" must be a non-empty string`);
  }
  if (typeof o.invariant !== "string" || o.invariant.trim() === "") {
    bad.push(`"invariant" must be a non-empty string`);
  }
  if (o.refs !== undefined) {
    if (
      !Array.isArray(o.refs) ||
      !o.refs.every((r) => typeof r === "string" && r.trim() !== "")
    ) {
      bad.push(`"refs" must be an array of non-empty strings`);
    }
  }
  for (const k of Object.keys(o)) {
    if (k !== "origin" && k !== "invariant" && k !== "refs") {
      bad.push(`unknown field "${k}"`);
    }
  }
  if (bad.length) throw new Error(bad.join("; "));
  return {
    origin: (o.origin as string).trim(),
    invariant: (o.invariant as string).trim(),
    ...(o.refs !== undefined ? { refs: (o.refs as string[]).map((r) => r.trim()) } : {}),
  };
}
