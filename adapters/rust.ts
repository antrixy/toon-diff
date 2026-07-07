// adapters/rust.ts — official Rust implementation (toon-format crate), via the
// compiled bridge binary in one-shot mode. The Rust analogue of adapters/python.ts.
//
// Build the bridge first (see adapters/RUST-NOTES.md):
//   (cd adapters/rust-bridge && cargo build --release)
//
// The adapter runs the compiled binary at
//   adapters/rust-bridge/target/release/toon-bridge
// or wherever $TOON_RUST_BRIDGE points. It spawns the BINARY, never `cargo run`,
// so no build check is paid per call.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPEC_VERSION_CLAIMS, type Adapter } from "./contract.ts";

const BIN =
  process.env.TOON_RUST_BRIDGE ??
  fileURLToPath(new URL("./rust-bridge/target/release/toon-bridge", import.meta.url));

function run(mode: "encode" | "decode", input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, [mode]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(new Error(`rust bridge spawn failed (${BIN}): ${e.message}`)),
    );
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`rust ${mode} failed: ${err}`)),
    );
    p.stdin.end(input);
  });
}

export const rustAdapter: Adapter = {
  name: "rust",
  specVersion: SPEC_VERSION_CLAIMS.rust,
  encode: (jsonText) => run("encode", jsonText),
  decode: (toonText) => run("decode", toonText),
};
