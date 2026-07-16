# Upstream filing: TS decoder out-of-range precision loss
# Filed against github.com/toon-format/toon — issue number TBD after filing

TITLE:
decode() silently approximates out-of-range integer tokens; no documented
out-of-range policy (§4 MUST), while docs claim lossless round-trips

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
// Expected (lossless-first): { unsafe: 9007199254740993n } or { unsafe: "9007199254740993" }
// Or (documented-policy branch): an approximate value, per a documented policy
// Actual: { unsafe: 9007199254740992 } — approximate value, no error, no documented policy
```

No out-of-range policy is documented anywhere in the repository (README,
docs/, API reference). The documentation instead makes the opposite claim in
several places: "deterministic, lossless round-trips" (docs/index.md,
packages/toon/README.md), "round-trips preserve all data and structure" and
"`decode(encode(x))` always equals `x`" (docs/guide/getting-started.md),
"TOON provides lossless round-trips after normalization"
(docs/reference/api.md) — where the named normalization examples are non-JSON
host types like `Date`, not plain JSON numbers.

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

The lossless machinery already exists in this codebase for the encoder's
host-value path: `packages/toon/src/encode/normalize.ts` converts an
out-of-range **BigInt** input to a string (quoted in output) — exactly the
lossless option §2 describes. The result is an asymmetry: the host value
`BigInt("9007199254740993")` survives encoding losslessly, while the same
mathematical value arriving as a wire token through `decode()` is silently
approximated.

Scope note: this report deliberately targets the **decode** path. On the
encode side, precision is typically lost at JS host ingestion
(`JSON.parse` rounds `2^53+1` before the library sees it), which is §3
host-normalization territory with its own documentation requirement — but the
decoder receives the exact token and the loss occurs inside the library, so
§4 governs directly.

Per §4, any of these would resolve the issue: returning a BigInt
(higher-precision type), returning a string, or documenting an
approximate-value policy — with lossless-first RECOMMENDED for a format whose
stated purpose is data interchange. At minimum, the MUST-document requirement
is currently unmet, and the existing "lossless" documentation claims are
contradicted by the behavior.

Surfaced by [toon-diff](https://github.com/antrixy/toon-diff) differential
testing; seed case 013-precision-loss-2pow53plus1.json. Versions:
`@toon-format/toon` 2.3.0, `toon_format` (Python) 0.9.0b1, `toon-format`
(Rust) 0.5.0, spec v3.3 / CHANGELOG [1.3] 2025-10-31.
