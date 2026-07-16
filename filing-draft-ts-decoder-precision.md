# Upstream filing: TS decoder out-of-range precision loss
# Filed as https://github.com/toon-format/toon/issues/329 (2026-07-16) — that thread is canonical; this file is the as-filed draft

TITLE:
decode() silently approximates out-of-range integer tokens; no documented
decoder out-of-range policy (§4)

---

## SPEC Version

v3.3

## SPEC Section

Section 4: Decoding Interpretation — numeric parsing of out-of-range tokens
(also §2 round-trip fidelity)

## SPEC Requirement

§4 (Decoding Interpretation), on numeric tokens outside the implementation's
domain:

> If a decoded numeric token is not representable within the implementation's
> documented numeric domain, implementations MAY return a higher-precision
> numeric type, return a string, or return an approximate numeric value if
> that is the documented policy. Implementations MUST document their
> out-of-range policy; lossless-first is RECOMMENDED for libraries intended
> for data interchange or validation.

So returning an approximate numeric value is a permitted branch **only as a
documented policy**, and documenting the out-of-range policy is a MUST
regardless of which branch is taken. §2 additionally requires round-trip
fidelity (CHANGELOG [1.3]: "all implementations MUST preserve round-trip
fidelity (§2)").

## Current Behavior

`@toon-format/toon` 2.3.0's decoder returns a silently approximated value for
a valid, in-grammar integer token:

```ts
import { decode } from "@toon-format/toon";

console.log(decode("unsafe: 9007199254740993"));
// Actual: { unsafe: 9007199254740992 } — approximate value, no error
```

Environment: `@toon-format/toon` 2.3.0, Node 24.4.1, macOS 26.5.1.

I could not find a documented out-of-range policy **for the decoder** in the
README, docs/, or API reference (searched: precision, out-of-range, numeric
domain, MAX_SAFE_INTEGER, lossless, 2^53, IEEE, double precision, bigint).
The encoder's host-value normalization *is* documented — the normalization
table in docs/reference/api.md maps out-of-range `BigInt` to a quoted decimal
string, with `"9007199254740993"` as its example — but no corresponding
statement covers what `decode()` returns for an out-of-range wire token.

The documentation's general claims point the other way: "deterministic,
lossless round-trips" (docs/index.md, packages/toon/README.md), "round-trips
preserve all data and structure" and "`decode(encode(x))` always equals `x`"
(docs/guide/getting-started.md), "TOON provides lossless round-trips after
normalization" (docs/reference/api.md) — where the documented normalization
covers non-JSON host types (`Date`, `BigInt`, `Set`, …), not wire tokens
entering `decode()`.

Cross-implementation status: both other official implementations emit the
token faithfully, and round-trip it losslessly between themselves.

| Encoder → Decoder | Result for `9007199254740993` on the wire |
|---|---|
| python → ts | decoded as `9007199254740992` — **silent precision loss** |
| rust → ts | decoded as `9007199254740992` — **silent precision loss** |
| python ↔ rust | round-trips losslessly, both directions |

The defect is isolated to the TS decoder's numeric path; the wire content is
valid per §4 numeric parsing in every case.

## Additional Context

The lossless machinery exists in this codebase, and is documented — on the
encode side. `packages/toon/src/encode/normalize.ts` converts an out-of-range
`BigInt` to a string (quoted in output), and the api.md normalization table
documents exactly that, using this very value as its example. The result is
an asymmetry within the library's own documented behavior: the host value
`BigInt("9007199254740993")` survives encoding losslessly as
`"9007199254740993"`, while the same mathematical value arriving as a wire
token through `decode()` is silently approximated to `9007199254740992`.

Scope note: this report deliberately targets the **decode** path. On the
encode side, precision for plain numbers is typically lost at JS host
ingestion (`JSON.parse` rounds `2^53+1` before the library sees it), which is
§3 host-normalization territory — and the BigInt route documented above
already offers users a lossless way in. The decoder receives the exact token
and the loss occurs inside the library, so §4 governs directly.

Per §4, any of these would resolve the issue: returning a `BigInt`
(higher-precision type), returning a string (mirroring the documented encoder
behavior for the same values), or documenting an approximate-value policy —
with lossless-first RECOMMENDED for a library whose documentation describes
it as a "drop-in, lossless representation of your existing JSON". At minimum,
the §4 MUST-document requirement for the decoder is currently unmet.

Surfaced by [toon-diff](https://github.com/antrixy/toon-diff) differential
testing; seed case 013-precision-loss-2pow53plus1.json. Versions:
`@toon-format/toon` 2.3.0, `toon_format` (Python) 0.9.0b1, `toon-format`
(Rust) 0.5.0, spec v3.3 / CHANGELOG [1.3] 2025-10-31.
