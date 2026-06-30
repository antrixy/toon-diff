// adapters/python.ts — official Python implementation, via subprocess.
// Install:  pip install git+https://github.com/toon-format/toon-python.git  (and python3 on PATH)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Adapter } from "./contract.ts";

const SCRIPT = fileURLToPath(new URL("./adapter.py", import.meta.url));

function run(mode: "encode" | "decode", input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("python3", [SCRIPT, mode]);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`python ${mode} failed: ${err}`)),
    );
    p.stdin.end(input);
  });
}

export const pythonAdapter: Adapter = {
  name: "python",
  encode: (jsonText) => run("encode", jsonText),
  decode: (toonText) => run("decode", toonText),
};
