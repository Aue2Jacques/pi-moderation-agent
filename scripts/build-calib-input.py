"""Input for scripts/fit-calib.ts (dev plan 2026-10-08): public labels only, and nothing from the 20k evaluation set.
- COLD dev split: ABUSE-001 label = COLD label; MARKETING-003 = 0 (COLD has no marketing content)
- ChineseHarm benchmark rows NOT sampled into data/eval/eval20k.jsonl: 黑产广告 / 欺诈 -> MARKETING-003 = 1;
  不违规 -> ABUSE-001 = 0, MARKETING-003 = 0
Writes data/calib/fit-input.jsonl ({id, text, labels}); prints counts only.
usage: .venv-data/bin/python -I scripts/build-calib-input.py
"""
import json
import os
from collections import Counter

import pandas as pd

rows, c = [], Counter()
cold = pd.read_csv("data/cold/COLDataset/COLDataset/dev.csv", encoding="utf-8-sig")
for i, r in cold.iterrows():
    rows.append({"id": f"cold-dev-{i}", "text": str(r["TEXT"]), "labels": {"ABUSE-001": int(r["label"]), "MARKETING-003": 0}})
    c[f"cold label={int(r['label'])}"] += 1


def jload(p):
    try:
        return pd.read_json(p)
    except ValueError:
        return pd.read_json(p, lines=True)


# the 20k builder records ChineseHarm rows by their row index in each benchmark file, per slice
taken = {}
for l in open("data/eval/eval20k.jsonl", encoding="utf-8"):
    r = json.loads(l)
    if r["source"] == "ChineseHarm":
        taken.setdefault(r["slice"], set()).add(r["source_ref"])
for name, slice_, labels in (("黑产广告", "marketing/chineseharm/ads", {"MARKETING-003": 1}),
                             ("欺诈", "marketing/chineseharm/fraud", {"MARKETING-003": 1}),
                             ("不违规", "safe/chineseharm", {"ABUSE-001": 0, "MARKETING-003": 0})):
    df = jload(f"data/datasets/ChineseHarm-bench/benchmark/{name}.json")
    skip = taken.get(slice_, set())
    for i, r in df.iterrows():
        if str(i) in skip:
            continue
        rows.append({"id": f"ch-{slice_.split('/')[-1]}-{i}", "text": str(r["文本"]), "labels": labels})
        c[f"chineseharm {name} (not in 20k)"] += 1
    c[f"chineseharm {name} skipped (in 20k)"] += len(skip)

os.makedirs("data/calib", exist_ok=True)
with open("data/calib/fit-input.jsonl", "w", encoding="utf-8") as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(json.dumps({"rows": len(rows), **c}, ensure_ascii=False, indent=1))
