// adapters/python-persistent.ts — persistent-process Python adapter.
//
// Same Adapter contract as adapters/python.ts, but instead of spawning a fresh
// interpreter per call it starts ONE `python3 adapter.py serve` process and
// speaks newline-delimited JSON to it. For a big sweep this turns ~15k process
// spawns into one — which is where the runtime went, not the payload sizes.
//
// Behavior parity with the one-shot adapter is a REQUIREMENT, not a hope: it is
// proven by adapters/selftest-parity.ts before any large run. Two things must
// hold and are checked there:
//   * identical encode/decode OUTPUT on every case, and
//   * encode/decode FAILURES surface as per-call rejections (the serve loop
//     catches them and replies with an error, so one bad case never kills the
//     process or the sweep).
//
// Protocol: strict request/response over one pipe. fuzz.ts awaits each call
// before the next, so at most one request is ever in flight; the FIFO queue below
// keeps responses matched to callers even if that ever stops being true.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SPEC_VERSION_CLAIMS, type Adapter } from "./contract.ts";

const SCRIPT = fileURLToPath(new URL("./adapter.py", import.meta.url));

type Pending = { resolve: (s: string) => void; reject: (e: Error) => void };

let child: ChildProcessWithoutNullStreams | null = null;
let queue: Pending[] = [];
let buf = "";
let dead = false;
let stderrBuf = "";

function ensureChild(): ChildProcessWithoutNullStreams {
  if (child) return child;
  const c = spawn("python3", [SCRIPT, "serve"], { stdio: ["pipe", "pipe", "pipe"] });
  c.stdout.setEncoding("utf-8");

  c.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    // One complete line == one response. Dequeue the oldest waiter for each.
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const p = queue.shift();
      if (!p) continue; // stray line under strict req/resp — shouldn't occur
      try {
        const resp = JSON.parse(line) as { ok: boolean; data?: string; error?: string };
        if (resp.ok) p.resolve(resp.data ?? "");
        else p.reject(new Error("python worker: " + (resp.error ?? "unknown error")));
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)));
      }
    }
  });

  c.stderr.on("data", (d) => (stderrBuf += d));

  const die = (msg: string) => {
    dead = true;
    const err = new Error(msg + (stderrBuf ? `\n${stderrBuf}` : ""));
    for (const p of queue) p.reject(err); // never leave a caller hanging
    queue = [];
    child = null;
  };
  c.on("exit", (code, signal) => {
    if (!dead) die(`python serve process exited (code=${code}, signal=${signal})`);
  });
  c.on("error", (e) => { if (!dead) die(`python serve process error: ${e.message}`); });

  // Don't let the worker outlive the parent as an orphan on normal exit / Ctrl-C.
  process.once("exit", () => { try { c.kill(); } catch { /* noop */ } });
  process.once("SIGINT", () => { try { c.kill(); } catch { /* noop */ } process.exit(130); });
  process.once("SIGTERM", () => { try { c.kill(); } catch { /* noop */ } process.exit(143); });

  child = c;
  dead = false;
  return c;
}

function request(op: "encode" | "decode", data: string): Promise<string> {
  if (dead) return Promise.reject(new Error("python serve adapter is dead"));
  const c = ensureChild();
  return new Promise<string>((resolve, reject) => {
    queue.push({ resolve, reject });
    c.stdin.write(JSON.stringify({ op, data }) + "\n");
  });
}

export const pythonAdapterPersistent: Adapter = {
  name: "python",
  specVersion: SPEC_VERSION_CLAIMS.python,
  encode: (jsonText) => request("encode", jsonText),
  decode: (toonText) => request("decode", toonText),
};

/** Close the worker cleanly. Call before process.exit in long-lived drivers. */
export function shutdownPython(): void {
  if (child) {
    try { child.stdin.end(); child.kill(); } catch { /* noop */ }
    child = null;
  }
}
