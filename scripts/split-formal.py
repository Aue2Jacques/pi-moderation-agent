"""Formal train / validation / test split of the eval set (dev plan E8), by text family (E6). The 50/50 `split` field the
builder writes stays what it is — temporary; this is a separate, frozen step.

- whole families go to one part (an injection item with its base, an adversarial item with its source, near duplicates)
- a family with ANY member that was ever used to tune or check something (labeling pilots, calibration fit, case pool
  candidates, injection checks, earlier pilot runs) never goes to test
- per group, test and validation each get about `frac` of the items (owner: test 2,000-4,000); families are taken in
  a fixed hash order and a family joins a part only if no group it touches goes over that part's quota
- writes data/eval/split-v1.jsonl ({id, family_id, split}) and eval/split-v1.manifest.jsonl (the same, plus group, no
  text; committed); refuses to overwrite an existing split (a new split is v2)
Ratios are TEMPORARY (70/15/15) until the owner sets them (dev plan §8). Prints counts only.
usage: python3 -I scripts/split-formal.py [frac=0.15]
"""
import glob
import hashlib
import json
import os
import sys
from collections import Counter, defaultdict

FRAC = float(sys.argv[1]) if len(sys.argv) > 1 else 0.15
OUT, MANIFEST = "data/eval/split-v1.jsonl", "eval/split-v1.manifest.jsonl"
if os.path.exists(OUT) or os.path.exists(MANIFEST):
    sys.exit(f"{OUT} or {MANIFEST} exists: a frozen split is never overwritten (make split-v2)")
items = [json.loads(l) for l in open("data/eval/eval20k.jsonl", encoding="utf-8") if l.strip()]
if any("family_id" not in it for it in items):
    sys.exit("eval20k.jsonl has no family_id: rebuild it with scripts/build-eval20k.py (dev plan E6)")

# every id that was ever used to tune or check something
used = set()
def ids_from_txt(p):
    used.update(l.strip() for l in open(p) if l.strip())
def ids_from_jsonl(p, key="id"):
    for l in open(p, encoding="utf-8"):
        if l.strip():
            v = json.loads(l).get(key)
            if v:
                used.add(v)
for p in glob.glob("data/eval/*-ids.txt") + glob.glob("data/cases/*.txt"):
    ids_from_txt(p)
for p in glob.glob("data/eval/label-pilot-*.jsonl") + glob.glob("data/eval/labels-*.jsonl") + ["data/eval/pilot-runs.jsonl", "data/eval/injection-pairs.jsonl", "data/calib/platform-input.jsonl"]:
    if os.path.exists(p):
        ids_from_jsonl(p)
for p in glob.glob("data/cases/*.jsonl"):
    ids_from_jsonl(p, "eval_id")

fam = defaultdict(list)
for it in items:
    fam[it["family_id"]].append(it)
used_fam = {f for f, ms in fam.items() if any(m["id"] in used for m in ms)}
group_n = Counter(it["group"] for it in items)
quota = {g: round(FRAC * n) for g, n in group_n.items()}
filled = {"test": Counter(), "val": Counter()}
assign = {}
order = sorted(fam, key=lambda f: hashlib.sha256(f"split-v1|{f}".encode()).hexdigest())
for part in ("test", "val"):
    for f in order:
        if f in assign or (part == "test" and f in used_fam):
            continue
        need = Counter(m["group"] for m in fam[f])
        if all(filled[part][g] + c <= quota[g] for g, c in need.items()):
            assign[f] = part
            filled[part].update(need)
for f in fam:
    assign.setdefault(f, "train")

os.makedirs("eval", exist_ok=True)
with open(OUT, "w", encoding="utf-8") as o, open(MANIFEST, "w", encoding="utf-8") as m:
    for it in sorted(items, key=lambda x: x["id"]):
        row = {"id": it["id"], "family_id": it["family_id"], "split": assign[it["family_id"]]}
        o.write(json.dumps(row) + "\n")
        m.write(json.dumps({**row, "group": it["group"]}) + "\n")
by = Counter((assign[it["family_id"]], it["group"]) for it in items)
print(json.dumps({
    "frac": FRAC, "items": len(items), "families": len(fam), "used_ids": len(used), "used_families": len(used_fam),
    "by_split": dict(Counter(assign[it["family_id"]] for it in items)),
    "by_split_group": {p: {g: by[(p, g)] for g in sorted(group_n)} for p in ("train", "val", "test")},
    "test_with_used_member": sum(1 for f, p in assign.items() if p == "test" and f in used_fam),
    "manifest_sha": hashlib.sha256(open(MANIFEST, "rb").read()).hexdigest()[:16],
}, ensure_ascii=False, indent=1))
