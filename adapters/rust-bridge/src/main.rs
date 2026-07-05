// adapters/rust-bridge/src/main.rs
//
// Bridge to the official toon-format crate (toon-format/toon-rust). It is the
// Rust analogue of adapters/adapter.py: SAME two modes, SAME NDJSON serve
// protocol, so the persistent-process fuzz pattern works identically for Rust.
//
//   one-shot (used by cli-v2 and the manual smoke test):
//       toon-bridge encode < in > out      # JSON text -> TOON text
//       toon-bridge decode < in > out      # TOON text -> JSON text
//     Reads all of stdin, writes the raw result to stdout, exits. A failing
//     encode/decode prints to stderr and exits nonzero (the one-shot TS adapter
//     turns that into a per-call rejection).
//
//   serve (persistent, for big fuzz sweeps):
//       toon-bridge serve
//     Newline-delimited JSON, one request per line, one response per line:
//         request:  {"op":"encode"|"decode","data":"<text>"}
//         response: {"ok":true,"data":"<text>"} | {"ok":false,"error":"<msg>"}
//     One long-lived process handles every case, so a sweep pays the process
//     startup cost ONCE. A failing encode/decode is CAUGHT and returned as an
//     error response — the process stays alive — matching adapter.py's serve
//     loop and the one-shot's per-call failure surface.
//
// NDJSON framing is deliberate, exactly as in adapter.py: TOON payloads are
// multi-line, but serde_json escapes every newline inside a string, so one
// request and one response are each exactly one physical line. That makes the
// frame boundary unambiguous.
//
// serde_json features (see Cargo.toml and adapters/RUST-NOTES.md):
//   * preserve_order  ON  — object key order reaches toon-format's encoder
//     intact, matching what the TS/Python adapters feed their encoders. Key
//     order is a documented fault line (gen/DESIGN.md); a key-sorting bridge
//     (serde_json's BTreeMap default) would contaminate it with an artifact.
//   * arbitrary_precision  OFF — i64/u64/f64 IS the Rust number model the
//     roadmap wants in the matrix. A number beyond u64 range loses precision at
//     serde_json::from_str, exactly as a real toon-format user's pipeline does —
//     symmetric to the TS adapter losing >2^53 at JSON.parse. The oracle and
//     shrinker attribute that loss correctly, so it is a real finding, not a
//     harness artifact.

use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead, Read, Write};

#[derive(Deserialize)]
struct Req {
    op: String,
    data: String,
}

/// The one place encode/decode happen. Decode uses the library default
/// (strict + coerce_types), the spec-faithful decoder — same posture as the
/// TS/Python adapters calling decode() with no options.
///
/// NOTE: if the pinned toon-format version lacks the `_default` helpers, swap to
/// the always-present option form:
///   encode: toon_format::encode(&v, &toon_format::EncodeOptions::default())
///   decode: toon_format::decode(data, &toon_format::DecodeOptions::default())
fn run_one(op: &str, data: &str) -> Result<String, String> {
    match op {
        "encode" => {
            let v: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
            toon_format::encode_default(&v).map_err(|e| e.to_string())
        }
        "decode" => {
            let v: Value = toon_format::decode_default(data).map_err(|e| e.to_string())?;
            serde_json::to_string(&v).map_err(|e| e.to_string())
        }
        other => Err(format!("unknown op {other}")),
    }
}

fn serve() -> io::Result<()> {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Req>(&line) {
            Ok(req) => match run_one(&req.op, &req.data) {
                Ok(data) => serde_json::json!({ "ok": true, "data": data }),
                Err(err) => serde_json::json!({ "ok": false, "error": err }),
            },
            Err(e) => serde_json::json!({ "ok": false, "error": format!("bad request frame: {e}") }),
        };
        // to_string escapes every newline inside `data`, so one response == one
        // physical line. serialization of this small object cannot realistically
        // fail; fall back to a valid error frame rather than panic if it ever does.
        let framed = serde_json::to_string(&resp)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"response serialize failed\"}".into());
        writeln!(out, "{framed}")?;
        out.flush()?;
    }
    Ok(())
}

fn one_shot(mode: &str) -> io::Result<()> {
    let mut data = String::new();
    io::stdin().lock().read_to_string(&mut data)?;
    match run_one(mode, &data) {
        Ok(result) => {
            io::stdout().lock().write_all(result.as_bytes())?;
            Ok(())
        }
        Err(err) => {
            eprintln!("{mode} failed: {err}");
            std::process::exit(1);
        }
    }
}

fn main() -> io::Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "serve".into());
    match mode.as_str() {
        "serve" => serve(),
        "encode" | "decode" => one_shot(&mode),
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    }
}
