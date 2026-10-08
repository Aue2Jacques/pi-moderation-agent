"""Pick a seeded sample of COLD test rows by fast-path outcome, for a blind second opinion (scripts/check-cold-leaks.ts).
Groups: leak = COLD offensive but auto-passed; ctl_block = offensive and auto-blocked; ctl_pass = safe and auto-passed.
Writes ids and groups only (no text). The same state() as scripts/score-cold.py.
usage: python3 -I scripts/sample-cold-leaks.py data/cold-eval/test-run1.jsonl data/cold-eval/leak-sample.jsonl [n_leak=100] [n_ctl=50]
"""
import json
import random
import sys

BLOCK, PASS = 0.90, 0.10
src, dst = sys.argv[1], sys.argv[2]
n_leak = int(sys.argv[3]) if len(sys.argv) > 3 else 100
n_ctl = int(sys.argv[4]) if len(sys.argv) > 4 else 50

by_i = {}
for line in open(src, encoding="utf-8"):
    if line.strip():
        r = json.loads(line)
        if r["i"] not in by_i or r["status"] == "ok":
            by_i[r["i"]] = r
rows = [r for r in by_i.values() if r["status"] == "ok"]


def state(r):
    a, b = r["primary"].get("ABUSE-001"), (r["copy"] or {}).get("ABUSE-001")
    mean = (a["p"] + b["p"]) / 2 if b else a["p"]
    ex = [(r[w] or {}).get("ABUSE-001.EX-QUOTE") for w in ("primary", "copy")]
    mk = [(r[w] or {}).get("MARKETING-003") for w in ("primary", "copy")]
    if mean >= BLOCK and all(e and e["choice"] == "not_applies" for e in ex if e is not None):
        return "block"
    low = lambda xs: all(x and x["p"] < PASS and x["choice"] == "none" for x in xs if x is not None)
    return "pass" if low([a, b]) and low(mk) else "suspicious"


groups = {
    "leak": [r for r in rows if r["label"] == 1 and state(r) == "pass"],
    "ctl_block": [r for r in rows if r["label"] == 1 and state(r) == "block"],
    "ctl_pass": [r for r in rows if r["label"] == 0 and state(r) == "pass"],
}
rng = random.Random(20261010)
out = []
for g, n in (("leak", n_leak), ("ctl_block", n_ctl), ("ctl_pass", n_ctl)):
    pool = sorted(groups[g], key=lambda r: r["i"])
    for r in rng.sample(pool, min(n, len(pool))):
        out.append({"i": r["i"], "group": g, "label": r["label"], "fine": r["fine"], "jev_p": round(((r["primary"]["ABUSE-001"]["p"]) + ((r["copy"] or {}).get("ABUSE-001", r["primary"]["ABUSE-001"])["p"])) / 2, 3)})
rng.shuffle(out)   # interleave groups so request order carries no signal
with open(dst, "w", encoding="utf-8") as f:
    for o in out:
        f.write(json.dumps(o, ensure_ascii=False) + "\n")
print(json.dumps(dict({g: len(v) for g, v in groups.items()}, sampled=len(out))))
