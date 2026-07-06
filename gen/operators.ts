// gen/operators.ts
//
// The v0.2 mutation operator set. Each operator is a structure-aware, pure
// transform on a GNode tree, driven entirely by a deterministic Rng. Operators
// were designed against the 13-seed corpus and the payload-density fault line
// surfaced externally (toon#310): the ecosystem over-tests DEEP nesting and
// under-tests FLAT / WIDE / HIGHLY-REPETITIVE / LARGE-TABLE shapes. Tier 1 exists
// to manufacture exactly those under-tested shapes.
//
// Contract every operator upholds:
//   * applicable(root): is there at least one target node this operator can act on?
//   * apply(root, rng): return a NEW tree (input untouched) plus a one-line detail
//     string for provenance. Given the same tree and Rng state, output is identical.
//   * The result is always valid JSON when emitted (asserted in bulk by the self-test).

import type { GNode, RawNum } from "./model.ts";
import { rawNum, isRawNum, isArray, isObject, lexemeOf, clone } from "./model.ts";
import type { Rng } from "./prng.ts";

// ---- path addressing ------------------------------------------------------
// A path is a list of object keys / array indices from the root to a node.
type Step = string | number;
type Path = Step[];

/** Collect every path whose node satisfies `pred` (root included). */
function collectPaths(root: GNode, pred: (n: GNode) => boolean): Path[] {
  const out: Path[] = [];
  const walk = (n: GNode, path: Path) => {
    if (pred(n)) out.push(path);
    if (isArray(n)) n.forEach((c, i) => walk(c, [...path, i]));
    else if (isObject(n)) for (const k of Object.keys(n)) walk(n[k], [...path, k]);
  };
  walk(root, []);
  return out;
}

function getAt(root: GNode, path: Path): GNode {
  let cur: GNode = root;
  for (const step of path) {
    cur = typeof step === "number" ? (cur as GNode[])[step] : (cur as { [k: string]: GNode })[step];
  }
  return cur;
}

/** Return a new tree with the node at `path` replaced, cloning only along the path. */
function replaceAt(root: GNode, path: Path, value: GNode): GNode {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    const arr = (root as GNode[]).slice();
    arr[head] = replaceAt(arr[head], rest, value);
    return arr;
  }
  const obj = { ...(root as { [k: string]: GNode }) };
  obj[head] = replaceAt(obj[head], rest, value);
  return obj;
}

// ---- shared value palettes ------------------------------------------------
const SCALARS: GNode[] = [rawNum("0"), rawNum("1"), rawNum("-1"), "x", "", true, false, null];
function scalar(rng: Rng): GNode {
  const s = rng.pick(SCALARS);
  return isRawNum(s) ? rawNum(lexemeOf(s)) : s;
}
const isTable = (n: GNode): boolean => isArray(n) && n.length > 0 && n.every(isObject);

// ==========================================================================
// Operator interface
// ==========================================================================
export interface Operator {
  name: string;
  tier: 1 | 2 | 3 | 4;
  weight: number; // relative selection weight within a pipeline step
  applicable(root: GNode): boolean;
  apply(root: GNode, rng: Rng): { node: GNode; detail: string };
}

// Helper: pick a target path matching pred (guaranteed non-empty by applicable()).
function target(root: GNode, rng: Rng, pred: (n: GNode) => boolean): Path {
  const paths = collectPaths(root, pred);
  return paths[rng.int(paths.length)];
}

// --------------------------------------------------------------------------
// TIER 1 — the toon#310 blind spot (flat / wide / repetitive / large tables)
//          + one known-real fault line (empty-array encoding).
// --------------------------------------------------------------------------

// O1 WidenObject: many keys, shallow depth. Turns {} / {a,b} into a flat-wide map.
export const WidenObject: Operator = {
  name: "WidenObject", tier: 1, weight: 5,
  applicable: (r) => collectPaths(r, isObject).length > 0,
  apply(root, rng) {
    const path = target(root, rng, isObject);
    const width = rng.pick([8, 64, 256]);
    const uniform = rng.bool(); // all-identical values stress the repetitive path
    const filler = scalar(rng);
    const obj = { ...(getAt(root, path) as { [k: string]: GNode }) };
    for (let i = 0; i < width; i++) {
      obj["g" + String(i).padStart(3, "0")] = uniform ? clone(filler) : scalar(rng);
    }
    return { node: replaceAt(root, path, obj), detail: `+${width} keys${uniform ? " (uniform)" : ""}` };
  },
};

// O2 ScaleArray: long, highly-repetitive array. Empty arrays get filled to length.
export const ScaleArray: Operator = {
  name: "ScaleArray", tier: 1, weight: 4,
  applicable: (r) => collectPaths(r, isArray).length > 0,
  apply(root, rng) {
    const path = target(root, rng, isArray);
    const src = getAt(root, path) as GNode[];
    const len = rng.pick([50, 500, 5000]);
    const out: GNode[] = [];
    if (src.length === 0) {
      const fill = scalar(rng);
      for (let i = 0; i < len; i++) out.push(clone(fill));
    } else {
      for (let i = 0; i < len; i++) out.push(clone(src[i % src.length]));
    }
    return { node: replaceAt(root, path, out), detail: `array -> len ${len}` };
  },
};

// O3 GrowTable: large ROW-COUNT table (stress the tabular path). Near-uniform:
// one scalar field is varied per row so it isn't literally identical.
export const GrowTable: Operator = {
  name: "GrowTable", tier: 1, weight: 5,
  applicable: (r) => collectPaths(r, isTable).length > 0,
  apply(root, rng) {
    const path = target(root, rng, isTable);
    const rows = getAt(root, path) as { [k: string]: GNode }[];
    const proto = rows[0];
    const keys = Object.keys(proto);
    const varyKey = keys.length ? rng.pick(keys) : null;
    const count = rng.pick([100, 1000, 5000]);
    const out: { [k: string]: GNode }[] = [];
    for (let i = 0; i < count; i++) {
      const row = clone(rows[i % rows.length]) as { [k: string]: GNode };
      if (varyKey) row[varyKey] = rawNum(String(i)); // vary one column across rows
      out.push(row);
    }
    return { node: replaceAt(root, path, out), detail: `table -> ${count} rows (vary ${varyKey ?? "none"})` };
  },
};

// O4 WidenRow: add columns to every row -> wide (and, with O3, wide+tall) table.
export const WidenRow: Operator = {
  name: "WidenRow", tier: 1, weight: 4,
  applicable: (r) => collectPaths(r, isTable).length > 0,
  apply(root, rng) {
    const path = target(root, rng, isTable);
    const rows = getAt(root, path) as { [k: string]: GNode }[];
    const extra = rng.pick([4, 16, 64]);
    const out = rows.map((r0) => {
      const row = { ...r0 };
      for (let i = 0; i < extra; i++) row["c" + String(i).padStart(3, "0")] = scalar(rng);
      return row;
    });
    return { node: replaceAt(root, path, out), detail: `+${extra} columns/row` };
  },
};

// O5 PerturbUniformity: seed 005 generalized. Break a uniform table in ONE row --
// the exact spot where a tabular encoder's uniform-vs-nested decision can diverge,
// and where "missing key != explicit null" bites.
export const PerturbUniformity: Operator = {
  name: "PerturbUniformity", tier: 1, weight: 4,
  applicable: (r) => collectPaths(r, (n) => isTable(n) && (n as GNode[]).length >= 2).length > 0,
  apply(root, rng) {
    const path = target(root, rng, (n) => isTable(n) && (n as GNode[]).length >= 2);
    const rows = (getAt(root, path) as { [k: string]: GNode }[]).map((r0) => ({ ...r0 }));
    const idx = rng.int(rows.length);
    const row = rows[idx];
    const keys = Object.keys(row);
    const kind = rng.pick(["drop", "add", "reorder", "retype"] as const);
    let detail = "";
    if (kind === "drop" && keys.length > 0) {
      const k = rng.pick(keys); delete row[k]; detail = `row ${idx}: drop "${k}"`;
    } else if (kind === "add") {
      row["extra"] = scalar(rng); detail = `row ${idx}: add "extra"`;
    } else if (kind === "reorder" && keys.length >= 2) {
      const reordered: { [k: string]: GNode } = {};
      for (const k of keys.slice().reverse()) reordered[k] = row[k];
      rows[idx] = reordered; detail = `row ${idx}: reverse key order`;
    } else if (kind === "retype" && keys.length > 0) {
      const k = rng.pick(keys);
      row[k] = isRawNum(row[k]) ? "typed" : rawNum("0");
      detail = `row ${idx}: retype "${k}"`;
    } else {
      row["extra"] = scalar(rng); detail = `row ${idx}: add "extra" (fallback)`;
    }
    return { node: replaceAt(root, path, rows), detail };
  },
};

// O10 EmptyContainerMix: inject {} / [] as a value/element. Targets the empty-array
// encoding divergence already observed upstream.
export const EmptyContainerMix: Operator = {
  name: "EmptyContainerMix", tier: 1, weight: 2,
  applicable: (r) => collectPaths(r, (n) => isObject(n) || isArray(n)).length > 0,
  apply(root, rng) {
    const path = target(root, rng, (n) => isObject(n) || isArray(n));
    const node = getAt(root, path);
    const empty: GNode = rng.bool() ? {} : [];
    if (isArray(node)) {
      const arr = node.slice(); arr.splice(rng.int(arr.length + 1), 0, empty);
      return { node: replaceAt(root, path, arr), detail: `insert ${JSON.stringify(empty)} into array` };
    }
    const obj = { ...(node as { [k: string]: GNode }) };
    obj["empty"] = empty;
    return { node: replaceAt(root, path, obj), detail: `add "empty": ${JSON.stringify(empty)}` };
  },
};

// --------------------------------------------------------------------------
// TIER 2 — numeric: the strongest single-value differential evidence.
// --------------------------------------------------------------------------

// O6 BumpNumber: move a number into a boundary/overflow region. Lexemes are minted
// directly (never via an f64), so the exact integer reaches the matrix intact.
const BOUNDARY_LEXEMES = [
  "9007199254740991",   // 2^53 - 1  (max safe)
  "9007199254740992",   // 2^53
  "9007199254740993",   // 2^53 + 1  (f64 rounds this -> ...992)
  "9007199254740994",   // 2^53 + 2
  "9223372036854775807", // 2^63 - 1  (i64 max)
  "18446744073709551615", // 2^64 - 1 (u64 max)
  "1000000000000000000000000000000",     // 10^30
  "1000000000000000000000000000001",     // 10^30 + 1
];
export const BumpNumber: Operator = {
  name: "BumpNumber", tier: 2, weight: 3,
  applicable: (r) => collectPaths(r, isRawNum).length > 0,
  apply(root, rng) {
    const path = target(root, rng, isRawNum);
    const lex = rng.pick(BOUNDARY_LEXEMES);
    return { node: replaceAt(root, path, rawNum(lex)), detail: `number -> ${lex}` };
  },
};

// O7 NumberForm: re-emit the SAME value in a representationally tricky form (-0,
// trailing-zero float, exponent). Value-equal to the oracle; may diverge in an
// encoder that normalizes differently.
// A PLAIN numeric lexeme: a bare integer or a bare decimal, with NO exponent.
// NumberForm targets only these so it is CLOSED UNDER COMPOSITION -- it can never
// be handed one of its own outputs (e.g. "9e0") and append a second exponent to
// produce invalid JSON like "9e0e0". (That exact case, "9007199254740993e0e0",
// crashed the first large sweep: two NumberForm steps on the same number.)
const PLAIN_NUM = (n: GNode): boolean =>
  isRawNum(n) && (/^-?\d+$/.test(lexemeOf(n)) || /^-?\d+\.\d+$/.test(lexemeOf(n)));

export const NumberForm: Operator = {
  name: "NumberForm", tier: 2, weight: 2,
  applicable: (r) => collectPaths(r, PLAIN_NUM).length > 0,
  apply(root, rng) {
    const path = target(root, rng, PLAIN_NUM); // cur is guaranteed exponent-free
    const cur = lexemeOf(getAt(root, path) as RawNum);
    const isPlainInt = /^-?\d+$/.test(cur);
    // Both branches append to an exponent-free lexeme, so every result is valid
    // JSON and carries at most one exponent. A second NumberForm picks a different
    // plain number, or is skipped if none remain.
    const lex = isPlainInt
      ? rng.pick([`${cur}.0`, `${cur}e0`, cur === "0" ? "-0" : `${cur}.00`])
      : rng.pick([`${cur}0`, `${cur}e0`]); // plain decimal: more trailing zero, or e0
    return { node: replaceAt(root, path, rawNum(lex)), detail: `number form ${cur} -> ${lex}` };
  },
};

// --------------------------------------------------------------------------
// TIER 3 — string encoding stress (delimiters + structural lookalikes).
// --------------------------------------------------------------------------
const STRING_PAYLOADS = [
  "a,b", "a|b", "a\tb", "a\nb", "a\r\nb", 'a"b', "a\\b", "a:b", "  pad  ",
  "#comment", "- item", "[bracket]", "{brace}", "true", "false", "null", "123", "1.5",
];
export const DelimiterInject: Operator = {
  name: "DelimiterInject", tier: 3, weight: 2,
  applicable: (r) => collectPaths(r, (n) => typeof n === "string" || isObject(n)).length > 0,
  apply(root, rng) {
    const payload = rng.pick(STRING_PAYLOADS);
    const strPaths = collectPaths(root, (n) => typeof n === "string");
    const objPaths = collectPaths(root, isObject);
    // Prefer replacing an existing string; fall back to adding a key on an object.
    // Only choose a branch that actually has a target (applicable() allows either).
    const replaceString = strPaths.length > 0 && (objPaths.length === 0 || rng.bool());
    if (replaceString) {
      const path = strPaths[rng.int(strPaths.length)];
      return { node: replaceAt(root, path, payload), detail: `string -> ${JSON.stringify(payload)}` };
    }
    const path = objPaths[rng.int(objPaths.length)];
    const obj = { ...(getAt(root, path) as { [k: string]: GNode }) };
    obj["s"] = payload;
    return { node: replaceAt(root, path, obj), detail: `add "s": ${JSON.stringify(payload)}` };
  },
};

// O11 LookalikeInject: quoted scalars whose CONTENT is a COMPLETE TOON structural
// token (the toon#324 class). DelimiterInject's palette stops at partial lookalikes
// ("- item", "[bracket]"); this palette is the full grammar-token set: array
// headers, tabular headers (bare and keyed), whole-value list markers (including
// indented), and object-header lookalikes. A correct impl must quote these on
// encode and decode them BACK TO THE SAME STRING -- never reparse them as
// structure. Manufacturing them lets the fuzzer rediscover the #324 class
// autonomously instead of by hand-written seed.
const LOOKALIKE_PAYLOADS = [
  // array headers
  "[3]:", "[0]:", "[1]: x",
  // tabular headers (bare + keyed)
  "[2]{a,b}:", "[1]{id}:", "items[2]{x}:",
  // whole-value list markers (plain + indented)
  "- ", "- item", "  - nested",
  // object-header lookalikes
  "key:", "key: value", "a: 1",
];
export const LookalikeInject: Operator = {
  name: "LookalikeInject", tier: 3, weight: 2,
  applicable: (r) => collectPaths(r, (n) => typeof n === "string" || isObject(n)).length > 0,
  apply(root, rng) {
    const payload = rng.pick(LOOKALIKE_PAYLOADS);
    const strPaths = collectPaths(root, (n) => typeof n === "string");
    const objPaths = collectPaths(root, isObject);
    // Same placement policy as DelimiterInject: prefer replacing an existing
    // string; fall back to adding a key on an object.
    const replaceString = strPaths.length > 0 && (objPaths.length === 0 || rng.bool());
    if (replaceString) {
      const path = strPaths[rng.int(strPaths.length)];
      return { node: replaceAt(root, path, payload), detail: `string -> ${JSON.stringify(payload)}` };
    }
    const path = objPaths[rng.int(objPaths.length)];
    const obj = { ...(getAt(root, path) as { [k: string]: GNode }) };
    obj["lk"] = payload;
    return { node: replaceAt(root, path, obj), detail: `add "lk": ${JSON.stringify(payload)}` };
  },
};

// O12 EmptyKeyNonPrimitive: the toon-python#64 class. An empty-string key over a
// NON-PRIMITIVE value ({"": {...}} / {"": [...]}) -- the shape no seed and no
// other operator produces, which is why #64 was found by hand. Primitive values
// under "" encode fine; the trigger is non-primitive only, so the palette is
// exactly containers. Numbers inside palette values are minted as lexemes
// (rawNum), never via an f64. Fresh nodes per apply -- no shared references.
const EMPTY_KEY_VALUES: { make: () => GNode; label: string }[] = [
  { make: () => ({}), label: "{}" },
  { make: () => [], label: "[]" },
  { make: () => ({ k: rawNum("1") }), label: '{"k":1}' },
  { make: () => [rawNum("1")], label: "[1]" },
];
export const EmptyKeyNonPrimitive: Operator = {
  name: "EmptyKeyNonPrimitive", tier: 3, weight: 1,
  applicable: (r) => collectPaths(r, isObject).length > 0,
  apply(root, rng) {
    const path = target(root, rng, isObject);
    const choice = rng.pick(EMPTY_KEY_VALUES);
    const obj = { ...(getAt(root, path) as { [k: string]: GNode }) };
    obj[""] = choice.make();
    return { node: replaceAt(root, path, obj), detail: `add "": ${choice.label}` };
  },
};

// --------------------------------------------------------------------------
// TIER 4 — deep nesting: the OVER-tested region per toon#310. Kept for contrast
//          (deep+wide combos), deliberately low weight.
// --------------------------------------------------------------------------
export const NestDeep: Operator = {
  name: "NestDeep", tier: 4, weight: 1,
  applicable: () => true,
  apply(root, rng) {
    const depth = rng.pick([4, 16]);
    const path = target(root, rng, () => true);
    let wrapped = clone(getAt(root, path));
    for (let i = 0; i < depth; i++) wrapped = { n: wrapped };
    return { node: replaceAt(root, path, wrapped), detail: `wrap depth ${depth}` };
  },
};

export const OPERATORS: Operator[] = [
  WidenObject, ScaleArray, GrowTable, WidenRow, PerturbUniformity, EmptyContainerMix,
  BumpNumber, NumberForm, DelimiterInject, LookalikeInject, EmptyKeyNonPrimitive, NestDeep,
];
