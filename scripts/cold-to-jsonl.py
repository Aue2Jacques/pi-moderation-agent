"""Convert a COLD csv split to JSONL {i, label, fine, text} for scripts/eval-cold.ts. Prints counts only, never text.
usage: python3 -I scripts/cold-to-jsonl.py data/cold/COLDataset/COLDataset/test.csv data/cold-eval/test.jsonl
"""
import csv
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
n = 0
with open(src, encoding="utf-8-sig") as f, open(dst, "w", encoding="utf-8") as out:
    for i, row in enumerate(csv.DictReader(f)):
        fine = row.get("fine-grained-label")
        out.write(json.dumps({"i": i, "label": int(row["label"]), "fine": int(fine) if fine not in (None, "") else None, "text": row["TEXT"]}, ensure_ascii=False) + "\n")
        n += 1
print(json.dumps({"rows": n, "out": dst}))
