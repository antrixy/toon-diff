// adapters/ts.ts — reference TypeScript implementation, in-process.
// Requires:  npm i @toon-format/toon
import { encode, decode } from "@toon-format/toon";
import { SPEC_VERSION_CLAIMS, type Adapter } from "./contract.ts";

export const tsAdapter: Adapter = {
  name: "ts",
  specVersion: SPEC_VERSION_CLAIMS.ts,
  async encode(jsonText) {
    // Safe: quarantined number-cases never reach here (cli filters them first).
    return encode(JSON.parse(jsonText));
  },
  async decode(toonText) {
    return JSON.stringify(decode(toonText));
  },
};
