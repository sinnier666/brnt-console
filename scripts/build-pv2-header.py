"""Build a Cookie header from the fresh Cookie-Editor JSON export.

Output: /tmp/pv2-header.txt
Auth-critical cookies first, then the rest. Values are used VERBATIM
(quotes included when present in the export).
"""
import json

SRC = "/home/z/my-project/tmp/pv2-cookies.json"
OUT = "/tmp/pv2-header.txt"

with open(SRC) as f:
    cookies = json.load(f)

# auth-critical cookies first
PRIORITY = ["at-main-av", "sess-at-main-av", "sst-main-av", "x-main-av", "av-profile", "session-token"]
cookies.sort(key=lambda c: PRIORITY.index(c["name"]) if c["name"] in PRIORITY else len(PRIORITY))

header = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
with open(OUT, "w") as f:
    f.write(header)

print(f"{len(cookies)} cookies -> {OUT} ({len(header)} bytes)")
for c in cookies:
    flags = []
    if c.get("httpOnly"): flags.append("httpOnly")
    if c.get("secure"): flags.append("secure")
    if c.get("session"): flags.append("session")
    print(f"  {c['name']:20s} domain={c['domain']:20s} {'/'.join(flags) or '-'}")
