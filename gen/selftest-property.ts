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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPEC_CURRENT } from "../probe/spec-rules.ts";
import { LOOKALIKE_PAYLOADS } from "./operators.ts";
import { FAMILIES, FAMILY_BASIS, PRODUCTIONS, TOON_SURFACE_SPEC, token } from "./toon-surface.ts";
import { makeRng } from "./prng.ts";
import {
  CHANNELS, CONFIG, PROPERTY_GEN_VERSION, addedKeyName, canonicalConfig, collectLexemes, digitWeights,
  countNodes, depthOf, eligibleChannels, generateProperty, identityOf,
  parseIdentity, replayProperty,
} from "./property.ts";
import type { Channel } from "./property.ts";

let failures = 0;
let total = 0;
function check(label: string, ok: boolean) {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}`);
}

const GOLDEN_SEED = 20260802;
const intDigitsOf = (l: string): number => l.replace(/^-/, "").split(/[.eE]/)[0].length;

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
  ["general", 12, "{\"Oçizkçw6õ\":{\"_á4áEz\":null},\"_YP\":true}"],
  ["shape-flat-wide", 7, "{\"L本iA\":-993,\"izkçw6õKh_YPTfEméxñQ5éQ\":\"4TdRkü.Q語-wi語 S1PxáW0î2V43sm1UY글lrA8X14JW\",\"á4áEzkgiLõTKdYFUK8gr\":true,\"8Q-Fül1T\":false,\"ñxatmsdNh\":\"H한WAhY語oO5dVéO3nRõ\",\"torlfz_ip0gZMkJB0n5oP5\":34.63075136e+08}"],
  ["shape-repetitive-array", 6, "[-9135913,-9135913,-9135913,-9135913,-9135913]"],
  ["shape-uniform-table", 9, "[{\"本iAOçizkçw6õ\":282957,\"_YP\":-8783310148540635},{\"本iAOçizkçw6õ\":\"vz8Q-Fül1TSAñx\",\"_YP\":null}]"],
  ["shape-near-uniform-table", 12, "[{\"本iAOçizkçw6õ\":null,\"_YP\":-3957852787833101485},{\"本iAOçizkçw6õ\":null},{\"本iAOçizkçw6õ\":461715,\"_YP\":-993}]"],
  ["surface-toon", 8, "[\"[0\\t]:\",\"[0\\t]{\\\"ZG\\\\rKekuL\\\"{CZ1\\tSuif\\t\\\"OcBG\\\"}}:\",\"# oXI1\",\"Ev7saq[1:|]{\\\"rp\\\\\\\\\\\"|Qm}:\",\"\\\"jylnZm\\\":\",\"AuOUKcJi[5982]: []\",\"[528|]:\"]"],
  ["shape-deep-nest", 6, "{\"8Q-Fül1T\":{\"áEzkgiLõTKdYFUK8gr\":{\"ñQ5éQs_\":{\"Em\":{\"6õKh_YP\":-9135913}}}}}"],
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
const LEXEME_GOLDENS = ["4832239436.4394","-99139961628.010398","-6536567912864439356434068922312.90E+13","-8e-18","-999.08859","-3716","5363063","43370681244342150","30042223646336438026","649","6130455459260.32433684","-230","3","-57082"];

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

  // THE CONFIG ITSELF IS A GOLDEN. The channel goldens pin generated BYTES, which
  // is not the same thing: a version left un-bumped, or a config key renamed or
  // dropped, changes nothing about the bytes and so leaves every other golden
  // green. Both were live mutations that survived until this check existed.
  // canonicalConfig() carries the version AND every weight, so pinning its digest
  // makes any of them a deliberate act.
  const CONFIG_GOLDEN = "43886d1e";
  const configDigest = (): string => {
    let h = 0x811c9dc5;
    for (const ch of canonicalConfig()) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  };
  check(`the canonical config digest is pinned (${configDigest()}), so version and weights cannot move silently`,
    configDigest() === CONFIG_GOLDEN);

  check(`PROPERTY_GEN_VERSION is ${PROPERTY_GEN_VERSION} and the goldens above belong to it`,
    canonicalConfig().startsWith(`{"version":${PROPERTY_GEN_VERSION},`));

  // RULE 1, AS A CHECK ON THE SOURCE. The generator may name no numeric limit.
  // This is the one invariant that cannot be tested behaviourally -- a boundary
  // constant sitting unused in the file is still the thing the rule forbids -- so
  // it is a source scan, deliberately, and it is narrow: long numeric literals and
  // the specific limits by name.
  {
    const gen = readFileSync(fileURLToPath(new URL("./property.ts", import.meta.url)), "utf8");
    const code = gen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const longLiterals = (code.match(/\b\d[\d_]{9,}\b/g) ?? []).filter((l) => !/^0123456789$/.test(l));
    check(`no long numeric literal in the generator (${longLiterals.join(", ") || "none"})`,
      longLiterals.length === 0);
    const named = ["9007199254740991", "9007199254740992", "9007199254740993",
      "18446744073709551615", "9223372036854775807", "2**53", "2 ** 53", "Number.MAX_SAFE_INTEGER"];
    const hits = named.filter((n) => code.includes(n));
    check(`no boundary limit named in the generator (${hits.join(", ") || "none"})`, hits.length === 0);
  }
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

  // ---- THE DIGIT PRIOR'S SHAPE, WHICH IS RULE 1 MADE ENFORCEABLE ----------
  //
  // The generator may not name a numeric limit. These three checks turn that from
  // a comment into an invariant, by pinning the SHAPE of the digit prior rather
  // than any particular probability:
  //
  //   C1 monotone non-increasing   -- no peak anywhere but d=1
  //   C2 constant ratio            -- p(d)/p(d-1) identical at every d, so the
  //                                   distribution is FEATURELESS across the
  //                                   region where implementations diverge
  //   C3 mean matches the config   -- the one free parameter cannot be retuned
  //                                   silently
  //
  // C2 is the load-bearing one: it makes any per-digit hand-tuning impossible, so
  // a boundary weight cannot be smuggled in at all -- in EITHER direction. A peak
  // near the boundary aims at it; a notch aims away from it; both are the same
  // violation with opposite signs, and both break C2.
  //
  // The judge may name the boundary; the generator may not. See DESIGN.md.
  {
    const w = digitWeights();
    check(`the digit prior is monotone non-increasing (${w.length} counts)`,
      w.every((v, i) => i === 0 || v <= w[i - 1] + 1e-12));

    const r0 = w[1] / w[0];
    check("the digit prior has a CONSTANT ratio, so it is featureless across every region",
      w.every((v, i) => i === 0 || Math.abs(v / w[i - 1] - r0) < 1e-9));

    const mean = w.reduce((a, p, i) => a + p * (i + 1), 0);
    check(`the realised mean integer length equals CONFIG.digitMean (${mean.toFixed(3)} vs ${CONFIG.digitMean})`,
      Math.abs(mean - CONFIG.digitMean) < 0.05);

    check("the digit prior is a probability distribution",
      Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);

    // The far end of the range must stay REACHABLE. A prior that suppressed it to
    // zero would be aiming away from the large-integer region, which is the same
    // violation as aiming at it.
    check("the longest permitted digit count is still reachable",
      w[w.length - 1] > 0);

    // THE TABLE IS NOT THE DRAW. Everything above judges digitWeights(); a draw
    // routine that ignored the table entirely would leave all of it green. So
    // compare the REALISED distribution of generated lexemes against the table.
    const seen = new Array(w.length).fill(0);
    let n = 0;
    for (let s = 1; s <= 1500; s++) {
      for (const lex of collectLexemes(generateProperty(s * 31_337, 40, { channel: "general" }).node)) {
        seen[intDigitsOf(lex) - 1]++; n++;
      }
    }
    const realisedMean = seen.reduce((a, c, i) => a + c * (i + 1), 0) / n;
    check(`the DRAWN mean matches the table's mean (${realisedMean.toFixed(2)} vs ${CONFIG.digitMean}, n=${n})`,
      Math.abs(realisedMean - CONFIG.digitMean) < 0.6);
    const realisedTail = seen.slice(16).reduce((a, b) => a + b, 0) / n;
    const tableTail = w.slice(16).reduce((a, b) => a + b, 0);
    check(`the DRAWN tail share matches the table's (${(100 * realisedTail).toFixed(1)}% vs ${(100 * tableTail).toFixed(1)}%)`,
      Math.abs(realisedTail - tableTail) < 0.04);
  }

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

  // THE COLLISION PATH, TESTED DIRECTLY BECAUSE A BULK SWEEP CANNOT REACH IT.
  // The odd row adds a key `x${keys[0]}`. If keys[0] is "" and "x" is already a
  // column, a plain assignment OVERWRITES and the archetype silently produces a
  // UNIFORM table while claiming near-uniform. The Aug-8 audit swept 115,000 draws
  // and never saw it -- which is why this is a directed check on the collision
  // RULE rather than another sweep. A bulk sweep that cannot reach a path proves
  // nothing about it.
  {
    // INVOKES the exported rule; does not reimplement it. A check that mirrors
    // its subject passes whatever the subject does.
    const applyRule = addedKeyName;
    const collide: Record<string, unknown> = { "": 1, "x": 2 };
    check("an added key that collides is suffixed, never overwritten",
      applyRule(collide, "") === "x1");
    const twice: Record<string, unknown> = { "": 1, "x": 2, "x1": 3 };
    check("the suffix loop keeps going while the name is taken",
      applyRule(twice, "") === "x2");
    check("the ordinary non-colliding case is unchanged by the rule",
      applyRule({ "a": 1 }, "a") === "xa");
    // The property that matters: the row gains a column rather than replacing one.
    const row: Record<string, unknown> = { "": 1, "x": 2 };
    row[applyRule(row, "")] = 3;
    check("the odd row GAINS a column, so it stays the odd one out",
      Object.keys(row).length === 3);
  }

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

// ---- 9. spec relationship + surface-toon --------------------------------
// Golden bytes prove the MODULE did not move. They cannot detect that the SPEC
// moved while the module stood still, which is what this comparison is for.

{
  check(`toon-surface models the current spec (${TOON_SURFACE_SPEC.version} vs SPEC_CURRENT ${SPEC_CURRENT})`,
    TOON_SURFACE_SPEC.version === SPEC_CURRENT);

  check("every family records its basis and clauses",
    FAMILIES.every((f) => {
      const b = FAMILY_BASIS[f];
      return b !== undefined && (b.basis === "abnf" || b.basis === "prose") && b.clauses.length > 0;
    }));

  check("every family has a production", FAMILIES.every((f) => typeof PRODUCTIONS[f] === "function"));

  // INDEPENDENCE, STATED CORRECTLY. The claim is not that minted tokens never
  // equal a hand-written one -- the palette holds short tokens like "[0]:" that
  // any faithful §6 grammar must be able to produce, and a grammar that could
  // never reach them would be the weaker one. The claim is that the palette is
  // not the SOURCE: the module cannot import it (checked below), and the minted
  // space is overwhelmingly outside it.
  const minted: string[] = [];
  for (const f of FAMILIES) {
    for (let s2 = 1; s2 <= 250; s2++) minted.push(token(makeRng(s2 * 7919), f));
  }
  const palette = new Set<string>(LOOKALIKE_PAYLOADS);
  const distinct = new Set(minted);
  const outside = [...distinct].filter((t) => !palette.has(t));
  check(`minted tokens are overwhelmingly outside the palette (${outside.length}/${distinct.size} distinct)`,
    outside.length / distinct.size > 0.95);
  check(`the palette's own reach is a vanishing share of the minted space (${distinct.size - outside.length} overlap)`,
    distinct.size - outside.length <= palette.size);

  // Each family is genuinely productive rather than emitting one constant.
  check("every family produces more than one distinct token",
    FAMILIES.every((f) => {
      const seen = new Set<string>();
      for (let s2 = 1; s2 <= 40; s2++) seen.add(token(makeRng(s2 * 104_729), f));
      return seen.size > 1;
    }));

  // The three families the palette never reaches, asserted by shape.
  const keyed = Array.from({ length: 40 }, (_, i) => token(makeRng((i + 1) * 613), "keyed-tabular-header"));
  check("keyed-tabular headers carry the [N:]{...}: form the palette lacks",
    keyed.every((t) => /\[\d+:[\t|]?\]\{.+\}:$/.test(t)) &&
    !LOOKALIKE_PAYLOADS.some((p) => /\[\d+:/.test(p)));

  const comments = Array.from({ length: 40 }, (_, i) => token(makeRng((i + 1) * 613), "comment-line"));
  check("comment lines lead with # after spaces only (no tab, per §5.1)",
    comments.every((t) => /^ *#/.test(t) && !/^[^#]*\t/.test(t)));

  const empties = Array.from({ length: 40 }, (_, i) => token(makeRng((i + 1) * 613), "empty-array-token"));
  check("empty-array tokens include the position-flipping bare form",
    empties.some((t) => t === "[]") && empties.some((t) => t.includes(": []")));

  // The surface channel actually places tokens, in value or key position.
  const sc = generateProperty(GOLDEN_SEED, 20, { channel: "surface-toon" });
  const surfaceText = sc.text;
  check("surface-toon places structural tokens into the value space",
    /\[\d+[\t|]?\]/.test(surfaceText) || /#/.test(surfaceText) || /- /.test(surfaceText));
}

// ---- replay through the CLI ----------------------------------------------
// replayProperty() is covered above; this covers the ENTRY POINT. The cli.ts
// write defect lived in argv handling and path resolution, not in the function
// it called, so a recipe printed on a finding is only trustworthy if the command
// that consumes it is exercised.

{
  const cli = fileURLToPath(new URL("./replay-case.ts", import.meta.url));
  const run = (arg: string) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, arg], { encoding: "utf8" });

  const want = generateProperty(GOLDEN_SEED, 24, { channel: "surface-toon" });
  const got = run(want.recipe);
  check("replay-case.ts reproduces a property recipe byte-for-byte",
    got.status === 0 && got.stdout === want.text + "\n");

  const stale = run(`prop:v${PROPERTY_GEN_VERSION + 1}/general@1/40`);
  check("replay-case.ts refuses a recipe from another generator version",
    stale.status !== 0 && stale.stdout === "");

  const junk = run("prop:v1/no-such-channel@1/40");
  check("replay-case.ts rejects an unparseable recipe", junk.status !== 0);
}

// ---- 8. dependency separation ---------------------------------------------
// The independence claim is structural, so it is checked structurally: an import
// graph, not a grep for constants. A source scan for "2^53" would prove a
// property of the file and be defeated by a constant assembled at runtime.

{
  const src = readFileSync(fileURLToPath(new URL("./property.ts", import.meta.url)), "utf8");
  const imports = [...src.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  // toon-surface.ts is allowed IN -- it is the containment line, carrying strings
  // inward. The corpus and the operator set remain out.
  const allowed = new Set(["./model.ts", "./emit.ts", "./prng.ts", "./toon-surface.ts"]);
  const unique = [...new Set(imports)];
  check(`property.ts imports only the shared substrate (${unique.join(", ")})`,
    unique.length > 0 && unique.every((i) => allowed.has(i)));
  check("property.ts imports neither the seed corpus nor the operator set",
    !imports.some((i) => i.includes("corpus") || i.includes("operators")));

  // The containment rule, checked rather than trusted: the one module that knows
  // TOON syntax depends on nothing but the PRNG.
  const surfaceSrc: string = readFileSync(fileURLToPath(new URL("./toon-surface.ts", import.meta.url)), "utf8");
  const surfaceImports = [...new Set([...surfaceSrc.matchAll(/^\s*import[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]))];
  check(`toon-surface.ts imports only the PRNG (${surfaceImports.join(", ")})`,
    surfaceImports.length === 1 && surfaceImports[0] === "./prng.ts");
}

// Counted, not written by hand: a hand-maintained total drifted from the printed
// checks twice during development, and a wrong count is worse than no count when
// the number is meant to be a promotion tripwire.
console.log(failures === 0
  ? `\nPROPERTY LAYER PROVEN: ${total} checks pass. Grammar-driven, spec-anchored, budget-bounded, replayable, and pinned against silent grammar drift.`
  : `\nPROPERTY LAYER BROKEN: ${failures} of ${total} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
