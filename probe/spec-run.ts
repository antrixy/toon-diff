/**
 * probe/spec-run.ts — the one-sided spec run path (v0.4).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every wire the N×N matrix tests was produced by SOME implementation's
 * encoder. When ports copy the reference implementation, they share its
 * assumptions, every round-trip agrees, and the matrix sees nothing. That is
 * the blind spot ROADMAP.md names, and it is structural: no amount of pairwise
 * testing reaches it, because the pair is the thing that is compromised.
 *
 * A spec case removes the encoder from the loop:
 *
 *     decode_X( hand-built wire text )  ==  the value SPEC.md says it means
 *
 * One check per implementation, not N×N, because there is no `from`: the input
 * came from the specification, and the only side with an obligation is the
 * decoder under test.
 *
 * THE PSEUDO-ENCODER. Records still carry `from: "spec"`, which is the
 * ROADMAP's "model the spec itself as a pseudo-encoder" made concrete — but
 * DELIBERATELY NOT as an Adapter object. Adapter.encode() takes jsonText and
 * returns wire, so a real spec adapter would need a value -> wire lookup keyed
 * on case text, which breaks the moment two spec cases share an expected value
 * — and they will, since many wire forms legitimately decode to one value
 * (`[]`, `[0]:`, `key: []` are the same empty array). The synthetic name is
 * all that grid.ts and explain.ts ever see of an encoder, so that is all this
 * module mints. SPEC_SIDE is deliberately not an adapter name; the guards
 * below and in grid.ts keep the two namespaces from mixing.
 *
 * WHAT A DIVERGENCE MEANS HERE. Not "two implementations disagree" but "this
 * implementation disagrees WITH THE SPECIFICATION". Every other side is
 * irrelevant, which is exactly the independence gain.
 *
 * Throws on harness bugs (non-spec case, spec case without wire) — OUR
 * mistakes, not data, per the house rule.
 */

import { ingest, equal } from "../oracle/ingest.ts";
import type { CorpusCase } from "./corpus.ts";
import type { DivergenceRecord } from "./explain.ts";

/**
 * The synthetic encoder side. Not an adapter, and must never be registered as
 * one: it names the SPECIFICATION as the origin of the wire.
 */
export const SPEC_SIDE = "spec";

/** The decode half of an Adapter — all a spec check needs. */
export interface SpecDecoder {
  name: string;
  decode(toonText: string): Promise<string>;
}

export interface SpecRunResult {
  records: DivergenceRecord[];
  /** caseCount * N — its own tripwire, never folded into pairChecks. */
  specChecks: number;
}

/**
 * Run every spec case against every decoder. Each check decodes the wire and
 * compares LOSSLESSLY against the case body (the spec-mandated value), so a
 * decoder that returns 18446744073709551616 for 18446744073709551617 is caught
 * rather than rounded into agreement.
 */
export async function runSpecCases(
  specCases: CorpusCase[],
  decoders: SpecDecoder[],
): Promise<SpecRunResult> {
  const records: DivergenceRecord[] = [];
  let specChecks = 0;

  for (const c of specCases) {
    if (c.bucket !== "spec") {
      throw new Error(
        `spec-run: case "${c.key}" is in bucket "${c.bucket}", not spec — harness bug`,
      );
    }
    if (c.wire === undefined) {
      throw new Error(`spec-run: spec case "${c.key}" has no wire text — harness bug`);
    }
    // The spec's stated value, read through the lossless oracle exactly as the
    // matrix reads a case body. The corpus loader has already proven it ingests.
    const expected = ingest(c.text);

    for (const X of decoders) {
      specChecks++;
      try {
        const got = await X.decode(c.wire);
        if (!equal(ingest(got), expected)) {
          records.push({
            file: c.key,
            from: SPEC_SIDE,
            to: X.name,
            expected: c.text,
            actual: got,
          });
        }
      } catch (e) {
        records.push({
          file: c.key,
          from: SPEC_SIDE,
          to: X.name,
          expected: c.text,
          actual: "",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return { records, specChecks };
}
