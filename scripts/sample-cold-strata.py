"""Seeded stratified sample of COLD test rows by fine-grained label (ids only, no text).
usage: python3 -I scripts/sample-cold-strata.py data/cold-eval/test.jsonl data/cold-eval/strata-1000.jsonl [per_class=250]
"""
import json
import random
import sys

src, dst = sys.argv[1], sys.argv[2]
per = int(sys.argv[3]) if len(sys.argv) > 3 else 250
by = {}
for line in open(src, encoding="utf-8"):
    r = json.loads(line)
    by.setdefault(r["fine"], []).append(r["i"])
rng = random.Random(20261011)
out = []
for fine in sorted(k for k in by if k is not None):
    pool = sorted(by[fine])
    out += [{"i": i, "fine": fine} for i in rng.sample(pool, min(per, len(pool)))]
rng.shuffle(out)
with open(dst, "w", encoding="utf-8") as f:
    for o in out:
        f.write(json.dumps(o) + "\n")
print(json.dumps({"per_class": {str(k): min(per, len(v)) for k, v in by.items() if k is not None}, "total": len(out)}))
