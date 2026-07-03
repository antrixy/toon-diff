# adapters/adapter.py — bridge to the official toon_format package.
#
# TWO MODES:
#
#   one-shot (unchanged, backward compatible):
#       python3 adapter.py encode < in > out
#       python3 adapter.py decode < in > out
#     Reads all of stdin, writes the result, exits. Used by cli-v2 and by the
#     manual smoke test (echo '{"a":1}' | python3 adapters/adapter.py encode).
#
#   serve (persistent, for big fuzz sweeps):
#       python3 adapter.py serve
#     Speaks newline-delimited JSON, one request per line, one response per line:
#         request:  {"op":"encode"|"decode","data":"<text>"}
#         response: {"ok":true,"data":"<text>"} | {"ok":false,"error":"<traceback>"}
#     One long-lived interpreter handles every case, so a sweep pays the Python
#     startup + import cost ONCE instead of ~15k times. A failing encode/decode is
#     CAUGHT and returned as an error response — the process stays alive — which
#     matches the one-shot behavior where such failures surface per-call rather
#     than aborting the run.
#
# NDJSON framing is deliberate: TOON payloads are multi-line, but JSON escapes
# every newline inside a string, so one request and one response are each exactly
# one physical line. That makes the frame boundary unambiguous.
import sys, json, traceback
from toon_format import encode, decode

def run_one(op, data):
    if op == "encode":
        return encode(json.loads(data))
    if op == "decode":
        return json.dumps(decode(data))
    raise ValueError(f"unknown op {op}")

def serve():
    # Requests from Node arrive as raw UTF-8 (the corpus has emoji, RTL, combining
    # marks); don't let a locale default corrupt them in either direction.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = {"ok": True, "data": run_one(req["op"], req["data"])}
        except Exception:
            resp = {"ok": False, "error": traceback.format_exc()}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()

def one_shot(mode):
    data = sys.stdin.read()
    if mode == "encode":
        sys.stdout.write(encode(json.loads(data)))
    elif mode == "decode":
        sys.stdout.write(json.dumps(decode(data)))
    else:
        sys.stderr.write(f"unknown mode {mode}\n"); sys.exit(2)

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if mode == "serve":
        serve()
    else:
        one_shot(mode)
