// gen/property.ts
//
// The v0.4 FROM-SCRATCH generator. No seed, no operator pipeline: every value is
// built from grammar productions. See gen/DESIGN.md "The property layer" for the
// thesis and the honest limits of the independence claim.
//
// WHAT THIS DOES NOT CLAIM. The human prior is not removed here, only relocated --
// out of individual example values and into productions, archetypes, weights and
// fuel policy. The claim is deterministic evidence independent of implementation
// behaviour and of hand-authored example VALUES, under explicit priors.
//
// TWO RULES THAT ARE NOT STYLE:
//
//   1. NO BOUNDARY CONSTANTS. Nothing in this file names 2^53, i64/u64 max, or any
//      other numeric limit. Number lexemes are assembled from the JSON number
//      grammar -- a digit count, a sign, an optional fraction, an optional
//      exponent -- so large-integer regions are reached because the digit-count
//      distribution covers them, not because a fixture pointed at them. Copying
//      BumpNumber's palette would make this a re-parameterisation of the operator
//      set wearing a different hat.
//
//   2. NO f64, BY CONSTRUCTION. A lexeme assembled from digits as a STRING never
//      touches a JS number. rawNum() takes it directly. No production in the
//      number path accepts or returns JS number content.
//
// DEPENDENCIES ARE PART OF THE ARGUMENT: this module imports model/emit/prng and
// nothing else. Not the seed corpus, not operators.ts. Pinned by obligation 8 in
// selftest-property.ts.
//
// The surface-toon channel (structural-lookalike strings drawn from TOON's own
// wire syntax) is deliberately absent -- it crosses the containment line and
// lands separately, with its own spec-version tripwire.

import type { GNode } from "./model.ts";
import { rawNum, isRawNum, isArray, isObject } from "./model.ts";
import { emit } from "./emit.ts";
import { makeRng } from "./prng.ts";
import type { Rng } from "./prng.ts";

/**
 * Bump when ANY production, weight or cap below changes -- the grammar is part of
 * a case's identity, so the same (channel, rngSeed, size) under a different
 * version is a different case. Golden outputs in selftest-property.ts make a
 * silent bump impossible.
 */
export const PROPERTY_GEN_VERSION = 1;

export const CHANNELS = [
  "general",
  "shape-flat-wide",
  "shape-repetitive-array",
  "shape-uniform-table",
  "shape-near-uniform-table",
  "shape-deep-nest",
] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * The canonical configuration. ONE exported object rather than literals scattered
 * through the constructors, so that a weight change is reviewable, serialisable
 * into fuzz-run metadata, and visible to the version review.
 *
 * minSize is the smallest node budget at which an archetype can honour its shape
 * guarantee. A "uniform table" at size 4 is not a table, so size stays a STRICT
 * cap and the archetype is simply not offered below its minimum.
 */
export const CONFIG = {
  caps: {
    maxKeyLen: 24,
    maxStringLen: 64,
    maxDigits: 40,
    maxExpDigits: 2,
    maxFracDigits: 8,
    maxChildren: 8,
    maxBytes: 262_144,
  },
  channelWeights: {
    "general": 6,
    "shape-flat-wide": 3,
    "shape-repetitive-array": 3,
    "shape-uniform-table": 3,
    "shape-near-uniform-table": 2,
    "shape-deep-nest": 1,
  },
  minSize: {
    "general": 1,
    "shape-flat-wide": 5,
    "shape-repetitive-array": 4,
    "shape-uniform-table": 7,
    "shape-near-uniform-table": 10,
    "shape-deep-nest": 4,
  },
  /** Terminal vs container at a node with fuel to spare. */
  nodeWeights: { terminal: 5, object: 3, array: 3 },
  /**
   * Same choice at the ROOT, weighted apart. A scalar root discards the whole
   * budget, which would make `size` meaningless for a large share of draws --
   * but a bare scalar is legal JSON and worth testing, so it stays reachable
   * rather than being forbidden.
   */
  rootWeights: { terminal: 1, object: 5, array: 5 },
  /** Which terminal. */
  scalarWeights: { null: 1, bool: 2, number: 4, string: 4 },
  /** Number shape: integer only, with a fraction, with an exponent, or both. */
  numberFormWeights: { integer: 6, fraction: 3, exponent: 2, both: 1 },
  /** Where a string's characters come from. */
  stringSourceWeights: { ordinary: 3, delimiterStress: 2 },
  /** An empty key is legal JSON and a known fault region; kept rare, not absent. */
  emptyKeyWeight: 1,
  nonEmptyKeyWeight: 24,
} as const;

/** Deterministic serialisation of the config, for run metadata and version review. */
export function canonicalConfig(): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
    }
    return v;
  };
  return JSON.stringify({ version: PROPERTY_GEN_VERSION, config: sortDeep(CONFIG) });
}

// ---- identity -------------------------------------------------------------

export interface PropertyIdentity {
  version: number;
  channel: Channel;
  rngSeed: number;
  size: number;
}

/** e.g. "prop:v1/shape-uniform-table@1000003/40" */
export function identityOf(id: PropertyIdentity): string {
  return `prop:v${id.version}/${id.channel}@${id.rngSeed}/${id.size}`;
}

const IDENTITY_RE = /^prop:v(\d+)\/([a-z0-9-]+)@(\d+)\/(\d+)$/;

/** Parse a recipe line back. Returns null on anything malformed or unknown. */
export function parseIdentity(s: string): PropertyIdentity | null {
  const m = IDENTITY_RE.exec(s.trim());
  if (!m) return null;
  const channel = m[2] as Channel;
  if (!(CHANNELS as readonly string[]).includes(channel)) return null;
  return {
    version: parseInt(m[1], 10),
    channel,
    rngSeed: parseInt(m[3], 10),
    size: parseInt(m[4], 10),
  };
}

// ---- weighted choice ------------------------------------------------------

function weighted<K extends string>(rng: Rng, weights: Record<K, number>, keys: readonly K[]): K {
  const total = keys.reduce((s, k) => s + weights[k], 0);
  let r = rng.next() * total;
  for (const k of keys) {
    r -= weights[k];
    if (r < 0) return k;
  }
  return keys[keys.length - 1];
}

// ---- leaf grammar: numbers ------------------------------------------------

const DIGITS = "0123456789";

/**
 * A JSON number lexeme, assembled as text.
 *
 * Grammar (RFC 8259): -? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?
 *
 * The digit count is drawn across the whole permitted range, so long integers --
 * including those past any particular implementation's exact-integer limit --
 * occur because the distribution covers them. No constant here names such a
 * limit. Note that "-0" is reachable the same way: sign, one digit, zero.
 */
function numberLexeme(rng: Rng): string {
  const { maxDigits, maxFracDigits, maxExpDigits } = CONFIG.caps;
  const form = weighted(rng, CONFIG.numberFormWeights, ["integer", "fraction", "exponent", "both"] as const);

  const intDigits = 1 + rng.int(maxDigits);
  let intPart: string;
  if (intDigits === 1) {
    intPart = DIGITS[rng.int(10)];
  } else {
    // No leading zero: JSON forbids it outside the bare "0".
    intPart = DIGITS[1 + rng.int(9)];
    for (let i = 1; i < intDigits; i++) intPart += DIGITS[rng.int(10)];
  }

  let lex = (rng.bool() ? "-" : "") + intPart;

  if (form === "fraction" || form === "both") {
    const n = 1 + rng.int(maxFracDigits);
    let frac = "";
    for (let i = 0; i < n; i++) frac += DIGITS[rng.int(10)];
    lex += "." + frac;
  }
  if (form === "exponent" || form === "both") {
    const n = 1 + rng.int(maxExpDigits);
    let exp = "";
    for (let i = 0; i < n; i++) exp += DIGITS[rng.int(10)];
    lex += (rng.bool() ? "e" : "E") + (rng.bool() ? "-" : "+") + exp;
  }
  return lex;
}

// ---- leaf grammar: strings ------------------------------------------------

// Ordinary text: latin, digits, spaces, and non-BMP/accented code points, so that
// encoding and escaping paths are exercised without aiming at any grammar.
const ORDINARY_CHARS = (
  "abcdefghijklmnopqrstuvwxyz" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
  "0123456789 _.-" +
  "áéîõüßçñ" +
  "日本語한글"
).split("");

// Delimiter stress: the individual characters that carry structural meaning in
// line-oriented formats, plus whitespace and escapes. These are CHARACTERS, not
// tokens -- complete structural tokens belong to the surface-toon channel.
const DELIMITER_CHARS = [
  ",", ":", "|", "[", "]", "{", "}", "\"", "'", "\\", "/", "-", "#", "=",
  "<", ">", "(", ")", "\t", "\n", "\r", " ", "  ",
];

function stringValue(rng: Rng): string {
  const src = weighted(rng, CONFIG.stringSourceWeights, ["ordinary", "delimiterStress"] as const);
  const pool = src === "ordinary" ? ORDINARY_CHARS : DELIMITER_CHARS;
  const n = rng.int(CONFIG.caps.maxStringLen + 1); // 0 is a legal string
  let out = "";
  for (let i = 0; i < n && out.length < CONFIG.caps.maxStringLen; i++) out += rng.pick(pool);
  return out.slice(0, CONFIG.caps.maxStringLen);
}

function keyName(rng: Rng): string {
  const kind = weighted(rng, { empty: CONFIG.emptyKeyWeight, normal: CONFIG.nonEmptyKeyWeight },
    ["empty", "normal"] as const);
  if (kind === "empty") return "";
  const n = 1 + rng.int(CONFIG.caps.maxKeyLen);
  let out = "";
  for (let i = 0; i < n; i++) out += rng.pick(ORDINARY_CHARS);
  return out.trim() === "" ? "k" : out;
}

/** Unique keys for one object; suffixes on collision so the count is honoured. */
function keySet(rng: Rng, count: number): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    let k = keyName(rng);
    let n = 0;
    while (seen.has(k)) k = `${k}${++n}`;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

function scalar(rng: Rng): GNode {
  switch (weighted(rng, CONFIG.scalarWeights, ["null", "bool", "number", "string"] as const)) {
    case "null": return null;
    case "bool": return rng.bool();
    case "number": return rawNum(numberLexeme(rng));
    default: return stringValue(rng);
  }
}

// ---- fuel -----------------------------------------------------------------

/**
 * Split `fuel` units among `count` children, each guaranteed at least 1.
 * Total is exactly `fuel`, which is what makes the node budget a hard cap.
 */
function splitFuel(rng: Rng, fuel: number, count: number): number[] {
  const parts = new Array<number>(count).fill(1);
  let spare = fuel - count;
  while (spare > 0) {
    const i = rng.int(count);
    const take = 1 + rng.int(spare);
    parts[i] += take;
    spare -= take;
  }
  return parts;
}

/**
 * The general recursive production. Every value costs one node; a container
 * spends one on itself and distributes the rest. Fuel therefore STRICTLY
 * decreases on every recursive call and a call with one unit can only emit a
 * terminal -- termination is structural, not sampled.
 */
function genValue(rng: Rng, fuel: number, root = false): GNode {
  if (fuel <= 1) return scalar(rng);
  const kind = weighted(rng, root ? CONFIG.rootWeights : CONFIG.nodeWeights,
    ["terminal", "object", "array"] as const);
  if (kind === "terminal") return scalar(rng);

  const budget = fuel - 1;
  const count = 1 + rng.int(Math.min(budget, CONFIG.caps.maxChildren));
  const parts = splitFuel(rng, budget, count);

  if (kind === "array") return parts.map((f) => genValue(rng, f));
  const keys = keySet(rng, count);
  const obj: { [k: string]: GNode } = {};
  keys.forEach((k, i) => { obj[k] = genValue(rng, parts[i]); });
  return obj;
}

// ---- archetypes -----------------------------------------------------------

/**
 * Each archetype honours its shape guarantee at or above CONFIG.minSize and never
 * exceeds `size` nodes. They exist because a plain recursive grammar spends nearly
 * all its mass on small nondescript values and would essentially never land a
 * large uniform table -- the region toon#310 says the ecosystem under-tests.
 */
/** Row floors the table archetypes must honour; CONFIG.minSize is derived from these. */
const MIN_TABLE_ROWS = 2;
const MIN_NEAR_ROWS = 3;

const ARCHETYPES: Record<Exclude<Channel, "general">, (rng: Rng, size: number) => GNode> = {
  // Many keys, all shallow: the flat/wide region.
  "shape-flat-wide": (rng, size) => {
    const count = size - 1;
    const keys = keySet(rng, count);
    const obj: { [k: string]: GNode } = {};
    for (const k of keys) obj[k] = scalar(rng);
    return obj;
  },

  // Long and highly repetitive: one drawn element, repeated.
  "shape-repetitive-array": (rng, size) => {
    const n = size - 1;
    const element = scalar(rng);
    const out: GNode[] = [];
    for (let i = 0; i < n; i++) out.push(element);
    return out;
  },

  // Array of objects sharing one key set exactly: the tabular path.
  "shape-uniform-table": (rng, size) => {
    // Columns are clamped so at least MIN_ROWS rows still fit: size is a hard cap,
    // and a one-row "table" would not honour the shape guarantee.
    const maxCols = Math.max(2, Math.floor((size - 1) / MIN_TABLE_ROWS) - 1);
    const cols = 2 + rng.int(Math.max(1, Math.min(4, maxCols - 1)));
    const perRow = 1 + cols;
    const rows = Math.max(MIN_TABLE_ROWS, Math.floor((size - 1) / perRow));
    const keys = keySet(rng, cols);
    const out: GNode[] = [];
    for (let r = 0; r < rows; r++) {
      const row: { [k: string]: GNode } = {};
      for (const k of keys) row[k] = scalar(rng);
      out.push(row);
    }
    return out;
  },

  // Uniform except for exactly one row: the near-uniform trap.
  "shape-near-uniform-table": (rng, size) => {
    const maxCols = Math.max(2, Math.floor((size - 1) / MIN_NEAR_ROWS) - 1);
    const cols = 2 + rng.int(Math.max(1, Math.min(3, maxCols - 1)));
    const perRow = 1 + cols;
    const rows = Math.max(MIN_NEAR_ROWS, Math.floor((size - 1) / perRow));
    const keys = keySet(rng, cols);
    const oddRow = rng.int(rows);
    // An added key costs a node; only take that branch if the budget has room,
    // otherwise deviate by dropping one. Either way the row is the odd one out.
    const planned = 1 + rows * perRow;
    const canAdd = planned + 1 <= size;
    const out: GNode[] = [];
    for (let r = 0; r < rows; r++) {
      const row: { [k: string]: GNode } = {};
      for (const k of keys) row[k] = scalar(rng);
      if (r === oddRow) {
        if (canAdd && rng.bool()) row[`x${keys[0]}`] = scalar(rng);
        else delete row[keys[keys.length - 1]];
      }
      out.push(row);
    }
    return out;
  },

  // Single-key objects all the way down: the OVER-tested region, kept for contrast.
  "shape-deep-nest": (rng, size) => {
    const depth = Math.max(2, size - 1);
    let node: GNode = scalar(rng);
    for (let d = 0; d < depth; d++) node = { [keyName(rng) || "n"]: node };
    return node;
  },
};

// ---- helpers --------------------------------------------------------------

export function countNodes(n: GNode): number {
  if (isArray(n)) return 1 + n.reduce((s: number, c: GNode) => s + countNodes(c), 0);
  if (isObject(n)) return 1 + Object.values(n).reduce((s: number, c: GNode) => s + countNodes(c), 0);
  return 1; // null, boolean, string, RawNum
}

export function depthOf(n: GNode): number {
  if (isArray(n)) return 1 + n.reduce((d: number, c: GNode) => Math.max(d, depthOf(c)), 0);
  if (isObject(n)) return 1 + Object.values(n).reduce((d: number, c: GNode) => Math.max(d, depthOf(c)), 0);
  return 1;
}

/** Channels whose shape guarantee can be honoured at this budget. */
export function eligibleChannels(size: number): Channel[] {
  return CHANNELS.filter((c) => size >= CONFIG.minSize[c]);
}

// ---- entry point ----------------------------------------------------------

export interface PropertyCase {
  text: string;
  node: GNode;
  identity: PropertyIdentity;
  /** The recipe line, e.g. "prop:v1/general@1000003/40". */
  recipe: string;
  /** Actual node count -- always <= size. */
  nodes: number;
}

/**
 * Build one case. Pure over (channel, rngSeed, size): same inputs, same bytes.
 *
 * Channel selection draws from a DERIVED rng, never the value rng, so a case
 * generated with a randomly-selected channel is byte-identical to the same case
 * regenerated with that channel named explicitly. Without that split, replay
 * from a recorded recipe would silently diverge.
 */
export function generateProperty(
  rngSeed: number,
  size: number,
  opts: { channel?: Channel } = {},
): PropertyCase {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`size must be a positive integer (got ${size})`);
  }

  let channel: Channel;
  if (opts.channel !== undefined) {
    if (!(CHANNELS as readonly string[]).includes(opts.channel)) {
      throw new Error(`unknown channel "${opts.channel}"`);
    }
    const min = CONFIG.minSize[opts.channel];
    if (size < min) {
      // Refuse rather than silently degrade: a "uniform table" of four nodes is
      // not a table, and the identity would then claim a shape it does not have.
      throw new Error(
        `channel "${opts.channel}" requires size >= ${min} (got ${size}); ` +
        `eligible at this size: ${eligibleChannels(size).join(", ")}`,
      );
    }
    channel = opts.channel;
  } else {
    const eligible = eligibleChannels(size);
    const pickRng = makeRng((rngSeed ^ 0x9e37_79b9) >>> 0);
    channel = eligible.length > 0
      ? weighted(pickRng, CONFIG.channelWeights, eligible)
      : "general";
  }

  const rng = makeRng(rngSeed);
  const node = channel === "general" ? genValue(rng, size, true) : ARCHETYPES[channel](rng, size);
  const text = emit(node);

  if (text.length > CONFIG.caps.maxBytes) {
    throw new Error(
      `generated case exceeds maxBytes (${text.length} > ${CONFIG.caps.maxBytes}) ` +
      `for ${channel}@${rngSeed}/${size} -- caps are inconsistent`,
    );
  }

  const identity: PropertyIdentity = { version: PROPERTY_GEN_VERSION, channel, rngSeed, size };
  return { text, node, identity, recipe: identityOf(identity), nodes: countNodes(node) };
}

/** Regenerate from a recipe line. Returns null if the line does not parse. */
export function replayProperty(recipe: string): PropertyCase | null {
  const id = parseIdentity(recipe);
  if (!id || id.version !== PROPERTY_GEN_VERSION) return null;
  return generateProperty(id.rngSeed, id.size, { channel: id.channel });
}

/** Every number lexeme in a tree, in emit order. Used by the self-test. */
export function collectLexemes(n: GNode, out: string[] = []): string[] {
  if (isRawNum(n)) out.push(emit(n));
  else if (isArray(n)) for (const c of n) collectLexemes(c, out);
  else if (isObject(n)) for (const c of Object.values(n)) collectLexemes(c, out);
  return out;
}
