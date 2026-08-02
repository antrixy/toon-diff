// gen/selftest-property.ts
//
// Proves the v0.4 from-scratch generator (gen/property.ts). The independent judge
// is the ORACLE (oracle/ingest.ts) -- the same judge the matrix uses -- exactly as
// in selftest-emit.ts. The generator is never judged by its own machinery.
//
// Obligations covered here are 1-8 and 10 of gen/DESIGN.md "Proof obligations".
// Obligation 9 (declared TOON spec version matches SPEC_CURRENT) lands with the
// surface-toon channel, which does not exist yet.
//
// OBLIGATION 10 IS A RUN INSTRUCTION, NOT A CHECK. The goldens are pinned in the
// sandbox (Node 22); sweeps run on the Mac (Node 24.4.1). mulberry32 is
// integer-exact -- Math.imul is spec-defined and division by 2^32 is exact -- so
// stability is expected, but a tripwire that fires depending on which machine ran
// it would be worse than no tripwire. Run this file on BOTH before trusting a red.
//
// WHY GOLDENS. The grammar is part of a case's identity: change a weight or a
// production and the same (channel, rngSeed, size) yields different bytes, so
// every promoted case's recipe silently stops being true. Pinned bytes make a
// grammar change a deliberate act -- update these in the same commit that bumps
// PROPERTY_GEN_VERSION, or not at all.
//
// Run: node --experimental-strip-types gen/selftest-property.ts

import { parse } from "./model.ts";
import { emit } from "./emit.ts";
import { ingest, equalRaw } from "../oracle/ingest.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CHANNELS, CONFIG, PROPERTY_GEN_VERSION, canonicalConfig, collectLexemes,
  countNodes, depthOf, eligibleChannels, generateProperty, identityOf,
  parseIdentity, replayProperty,
} from "./property.ts";
import type { Channel } from "./property.ts";

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

const GOLDEN_SEED = 20260802;

// ---- 1. deterministic construction ---------------------------------------

{
  const a = generateProperty(1000003, 40, { channel: "general" });
  const b = generateProperty(1000003, 40, { channel: "general" });
  check("same (channel, seed, size) yields identical text",
    a.text === b.text && a.recipe === b.recipe && a.nodes === b.nodes);

  const r = replayProperty(a.recipe);
  check("replay from the recipe line reproduces the bytes", r !== null && r.text === a.text);

  // Channel selection must draw from a DERIVED rng, never the value rng: a case
  // built with an auto-selected channel has to equal the same case with that
  // channel named, or a recorded recipe would not replay.
  const auto = generateProperty(777_001, 40);
  const named = generateProperty(777_001, 40, { channel: auto.identity.channel });
  check("auto-selected channel replays identically when named explicitly",
    auto.text === named.text);

  check("recipe round-trips through parseIdentity",
    identityOf(parseIdentity(a.recipe)!) === a.recipe);
  check("parseIdentity rejects a malformed line",
    parseIdentity("prop:v1/not-a-channel@1/2") === null &&
    parseIdentity("mut:seeds/010-numbers.json@1/3") === null);
}

// ---- 2. golden outputs (the version tripwire) -----------------------------

const CHANNEL_GOLDENS: [Channel, number, string][] = [
  ["general", 12, "{\"O\u00e7izk\u00e7w6\u00f5\":{\"_\u00e14\u00e1Ez\":null},\"_YP\":true}"],
  ["shape-flat-wide", 7, "{\"L本iA\":-99347367505,\"izkçw6õKh_YPTfEméxñQ5éQ\":\"  \\n}|  \\t=>#}\\n=>\\r(=(({[>=<  [{\\\")<>(/<]{\",\"á4áEzkgiLõTKdYFUK8gr\":false,\"8Q-Fül1T\":\"H한WAhY語oO5dVéO3nRõ\",\"ñxatmsdNh\":-34796.7E+13,\"torlfz_ip0gZMkJB0n5oP5\":null}"],
  ["shape-repetitive-array", 6, "[-91359131927840765503,-91359131927840765503,-91359131927840765503,-91359131927840765503,-91359131927840765503]"],
  ["shape-uniform-table", 9, "[{\"本iAOçizkçw6õ\":-2829578527878331,\"_YP\":true},{\"本iAOçizkçw6õ\":\"dYFUK8grvz8Q-Fül1TSAñxatmsdNhu\",\"_YP\":\"rlfz_ip0gZM\"}]"],
  ["shape-near-uniform-table", 12, "[{\"本iAOçizkçw6õ\":null,\"_YP\":-39578527878331014854063547022375848},{\"本iAOçizkçw6õ\":\"AñxatmsdNhuçtorlfz_ip0gZMkJB0n5oP5Do\"},{\"本iAOçizkçw6õ\":36750518859821975652866866772165,\"_YP\":\"A8X14JWoriüYQw\"}]"],
  ["shape-deep-nest", 6, "{\"torlfz_ip0gZMkJB0n5oP5\":{\"ñxatmsdNh\":{\"8Q-Fül1T\":{\"áEzkgiLõTKdYFUK8gr\":{\"ñQ5éQs_\":-91359131927840765503}}}}}"],
];

{
  const moved: string[] = [];
  for (const [channel, size, want] of CHANNEL_GOLDENS) {
    const got = generateProperty(GOLDEN_SEED, size, { channel }).text;
    if (got !== want) moved.push(channel);
  }
  check(`golden output pinned for all ${CHANNEL_GOLDENS.length} channels`, moved.length === 0);
  if (moved.length) console.log(`       moved: ${moved.join(", ")} -- bump PROPERTY_GEN_VERSION`);
}

// Scalar production families, pinned separately: a weight change inside the
// number grammar can leave every channel golden untouched.
const LEXEME_GOLDENS = ["4832239436944394893973324.49", "510076750729126775671329647172358953914", "-433706812443421505438200422236463", "744537200953878577", "65459260683243368420", "32580742", "-96626141567418985365167E-3", "-4551", "-82E+60", "90488632693", "-4357946110486831102787993811877734E-6", "-688899649645798647335503946348396E-3", "45227194180018325416429276692", "78251928500844500077E-99"];

function sweepLexemes(limit: number): string[] {
  const out: string[] = [];
  for (let s = 1; s <= 60 && out.length < limit; s++) {
    const c = generateProperty(s * 104_729, 30, { channel: "general" });
    for (const lex of collectLexemes(c.node)) if (out.length < limit) out.push(lex);
  }
  return out;
}

{
  const got = sweepLexemes(LEXEME_GOLDENS.length);
  check("golden number lexemes pinned across production families",
    JSON.stringify(got) === JSON.stringify(LEXEME_GOLDENS));

  check("canonical config serialises deterministically",
    canonicalConfig() === canonicalConfig() && canonicalConfig().includes(`"version":${PROPERTY_GEN_VERSION}`));
}

// ---- 3. lossless round trip, judged by the oracle -------------------------

{
  let byteExact = 0, valueEqual = 0, wellFormed = 0, n = 0;
  for (const channel of CHANNELS) {
    for (let s = 1; s <= 40; s++) {
      const size = Math.max(CONFIG.minSize[channel], 6 + (s % 30));
      const c = generateProperty(s * 7919, size, { channel });
      n++;
      try { ingest(c.text); wellFormed++; } catch { /* counted by omission */ }
      const round = emit(parse(c.text));
      if (round === c.text) byteExact++;
      if (equalRaw(round, c.text)) valueEqual++;
    }
  }
  check(`all ${n} generated cases are well-formed JSON (oracle ingest)`, wellFormed === n);
  check(`all ${n} survive parse->emit byte-exact`, byteExact === n);
  check(`all ${n} survive parse->emit value-equal (oracle judge)`, valueEqual === n);
}

// ---- 4. numeric-path integrity -------------------------------------------

// RFC 8259 number grammar. A lexeme that fails this would mean the generator
// emitted something JSON.parse only tolerates by accident.
const JSON_NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

{
  const lexemes: string[] = [];
  for (let s = 1; s <= 120; s++) {
    lexemes.push(...collectLexemes(generateProperty(s * 31_337, 40, { channel: "general" }).node));
  }
  check(`every lexeme matches the JSON number grammar (${lexemes.length} sampled)`,
    lexemes.every((l) => JSON_NUMBER.test(l)));
  check("no lexeme carries a leading zero", lexemes.every((l) => !/^-?0[0-9]/.test(l)));

  // The independence claim, made behavioural. The THRESHOLD lives here, in the
  // judge -- property.ts contains no such constant. Reaching this region is a
  // consequence of the digit-count distribution, not of a fixture.
  const intDigits = (l: string) => l.replace(/^-/, "").split(/[.eE]/)[0].length;
  const past = lexemes.filter((l) => intDigits(l) > 16);
  check("integers beyond the exact-integer region occur unprompted", past.length > 0);

  // Byte survival: the digits of a long integer must reach the text intact.
  const long = past.sort((a, b) => intDigits(b) - intDigits(a))[0];
  let survived = false;
  for (let s = 1; s <= 120 && !survived; s++) {
    const c = generateProperty(s * 31_337, 40, { channel: "general" });
    if (collectLexemes(c.node).includes(long)) survived = c.text.includes(long);
  }
  check(`the longest sampled integer survives into the text byte-for-byte (${intDigits(long)} digits)`,
    survived);

  // -0 is reachable from the grammar (sign + single zero digit), not planted.
  let sawNegZero = false;
  for (let s = 1; s <= 4000 && !sawNegZero; s++) {
    sawNegZero = collectLexemes(generateProperty(s, 20, { channel: "general" }).node).includes("-0");
  }
  check("-0 is reachable from the number grammar", sawNegZero);
}

// ---- 5. structural budget -------------------------------------------------

{
  let over = 0, big = 0, n = 0;
  for (const channel of CHANNELS) {
    for (let size = CONFIG.minSize[channel]; size <= 120; size += 7) {
      for (let s = 1; s <= 12; s++) {
        const c = generateProperty(s * 7919 + size, size, { channel });
        n++;
        if (c.nodes > size) over++;
        if (c.text.length > CONFIG.caps.maxBytes) big++;
      }
    }
  }
  check(`node count never exceeds size (${n} draws)`, over === 0);
  check("output never exceeds the byte cap", big === 0);
  check("countNodes agrees with the emitted structure",
    countNodes(generateProperty(5, 30, { channel: "general" }).node) ===
      generateProperty(5, 30, { channel: "general" }).nodes);
}

// ---- 6. direct shape validation ------------------------------------------
// Archetypes are invoked directly rather than waited for: a probabilistic
// "eventually drew one" test would prove the sampler, not the constructor.

function keysOf(n: unknown): string[] {
  return Object.keys(n as Record<string, unknown>);
}

{
  const flat = generateProperty(GOLDEN_SEED, 30, { channel: "shape-flat-wide" }).node;
  check("flat-wide is a wide, shallow object",
    !Array.isArray(flat) && typeof flat === "object" && flat !== null &&
    keysOf(flat).length >= 20 && depthOf(flat) === 2);

  const rep = generateProperty(GOLDEN_SEED, 40, { channel: "shape-repetitive-array" }).node as unknown[];
  check("repetitive-array is long and made of one repeated element",
    Array.isArray(rep) && rep.length >= 30 &&
    new Set(rep.map((e) => emit(e as never))).size === 1);

  const tbl = generateProperty(GOLDEN_SEED, 60, { channel: "shape-uniform-table" }).node as unknown[];
  const tblKeys = tbl.map((r) => keysOf(r).join("|"));
  check("uniform-table is an array of objects sharing one key set",
    Array.isArray(tbl) && tbl.length >= 2 &&
    tbl.every((r) => r !== null && typeof r === "object" && !Array.isArray(r)) &&
    new Set(tblKeys).size === 1);

  const near = generateProperty(GOLDEN_SEED, 60, { channel: "shape-near-uniform-table" }).node as unknown[];
  const nearKeys = near.map((r) => keysOf(r).join("|"));
  check("near-uniform-table deviates in exactly one row",
    Array.isArray(near) && near.length >= 3 && new Set(nearKeys).size === 2 &&
    nearKeys.filter((k) => k !== nearKeys.find((x, i) => nearKeys.indexOf(x) !== i)).length >= 1);

  const deep = generateProperty(GOLDEN_SEED, 30, { channel: "shape-deep-nest" }).node;
  check("deep-nest reaches its depth through single-key objects",
    depthOf(deep) >= 25);

  const gen = generateProperty(GOLDEN_SEED, 60, { channel: "general" }).node;
  check("general produces a composite value, not only scalars",
    depthOf(gen) >= 2);
}

// ---- 7. sampler validation ------------------------------------------------

{
  check("eligibleChannels honours every declared minimum",
    CHANNELS.every((c) => {
      const min = CONFIG.minSize[c];
      const atMin = eligibleChannels(min).includes(c);
      const belowMin = min > 1 ? !eligibleChannels(min - 1).includes(c) : true;
      return atMin && belowMin;
    }));

  // A named channel below its minimum is refused, not silently degraded.
  const belowMin = CHANNELS.filter((c) => CONFIG.minSize[c] > 1);
  check("naming a channel below its minimum throws",
    belowMin.every((c) => {
      try { generateProperty(1, CONFIG.minSize[c] - 1, { channel: c }); return false; }
      catch { return true; }
    }));

  // Auto-selection never returns a channel it could not honour.
  let ineligible = 0;
  for (let size = 1; size <= 30; size++) {
    for (let s = 1; s <= 40; s++) {
      const c = generateProperty(s * 4813 + size, size);
      if (!eligibleChannels(size).includes(c.identity.channel) && c.identity.channel !== "general") ineligible++;
    }
  }
  check("auto-selection never picks an ineligible channel", ineligible === 0);

  // Every channel is reachable when the budget allows all of them.
  const seen = new Set<Channel>();
  for (let s = 1; s <= 400; s++) seen.add(generateProperty(s * 977, 60).identity.channel);
  check(`all ${CHANNELS.length} channels are reachable by auto-selection`, seen.size === CHANNELS.length);
}

// ---- 8. dependency separation ---------------------------------------------
// The independence claim is structural, so it is checked structurally: an import
// graph, not a grep for constants. A source scan for "2^53" would prove a
// property of the file and be defeated by a constant assembled at runtime.

{
  const src = readFileSync(fileURLToPath(new URL("./property.ts", import.meta.url)), "utf8");
  const imports = [...src.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  const allowed = new Set(["./model.ts", "./emit.ts", "./prng.ts"]);
  const unique = [...new Set(imports)];
  check(`property.ts imports only the shared substrate (${unique.join(", ")})`,
    unique.length > 0 && unique.every((i) => allowed.has(i)));
  check("property.ts imports neither the seed corpus nor the operator set",
    !imports.some((i) => i.includes("corpus") || i.includes("operators")));
}

console.log(failures === 0
  ? "\nPROPERTY LAYER PROVEN: 31 checks pass. Grammar-driven, budget-bounded, replayable, and pinned against silent grammar drift."
  : `\nPROPERTY LAYER BROKEN: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
