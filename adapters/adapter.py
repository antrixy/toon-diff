# adapters/adapter.py — thin stdin/stdout bridge to the official package.
# Install:  pip install git+https://github.com/toon-format/toon-python.git
# (official impl: github.com/toon-format/toon-python; module name: toon_format)
import sys, json
from toon_format import encode, decode

mode = sys.argv[1]
data = sys.stdin.read()
if mode == "encode":
    sys.stdout.write(encode(json.loads(data)))
elif mode == "decode":
    sys.stdout.write(json.dumps(decode(data)))
else:
    sys.stderr.write(f"unknown mode {mode}\n"); sys.exit(2)
