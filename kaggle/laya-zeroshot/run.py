# Kaggle kernel (GPU): zero-shot Laya on the COLD dev and test splits with the SAME questions we gave Jev
# (rules/prompts/jev-variants.yaml, variants A_choice and C_bool). Writes ids + labels + raw answers only (no text)
# to /kaggle/working/laya-<split>.jsonl. Pushed and fetched from the dev box with scripts/kaggle-run.sh.
import json, os, subprocess, sys, time, urllib.request

def sh(cmd):
    print("+", cmd, flush=True)
    subprocess.run(cmd, shell=True, check=True)

sh(f"{sys.executable} -m pip install -q laya pyyaml")
sh(f"{sys.executable} -m pip show laya | head -2")   # E4: record the installed version in the run log
# dev plan E4: every source pinned (scripts/kaggle-run.sh fills the commits in at push time)
PINS = {"repo": "__REPO_SHA__", "cold": "__COLD_SHA__"}
assert all(not v.startswith("__") for v in PINS.values()), "push with scripts/kaggle-run.sh: it pins every source commit"
print("pins", PINS, flush=True)
sh("git clone -q https://github.com/thu-coai/COLDataset.git /kaggle/temp/cold && cd /kaggle/temp/cold && git checkout -q __COLD_SHA__")
spec_url = "https://raw.githubusercontent.com/Aue2Jacques/pi-moderation-agent/__REPO_SHA__/rules/prompts/jev-variants.yaml"
import yaml
spec = yaml.safe_load(urllib.request.urlopen(spec_url).read().decode("utf-8"))["variants"]

def to_laya(qs):
    out = {}
    for k, q in qs.items():
        if q["type"] == "bool":
            out[k] = {"type": "noul", "instructions": q["instructions"]}
        else:
            out[k] = {"type": q["type"], "instructions": q["instructions"], "criteria": q["criteria"]}
    return out

questions = {**to_laya(spec["A_choice"]), **to_laya(spec["C_bool"])}

import csv, torch
from laya import Router
os.environ.setdefault("LAYA_DEVICE", "cuda" if torch.cuda.is_available() else "cpu")
router = Router(preload=True)
print("device", os.environ["LAYA_DEVICE"], "gpu", torch.cuda.get_device_name(0) if torch.cuda.is_available() else None, flush=True)

for split in ("dev", "test"):
    rows = list(csv.DictReader(open(f"/kaggle/temp/cold/COLDataset/{split}.csv", encoding="utf-8-sig")))
    reqs = [{"state": {"content": {"text": r["TEXT"], "scene": "comment"}}, "questions": questions, "model": "multilingual"} for r in rows]
    t0 = time.time()
    res = router.predict_batch(reqs, batch_size=64, sort_by_length=True)
    dt = time.time() - t0
    with open(f"/kaggle/working/laya-{split}.jsonl", "w", encoding="utf-8") as f:
        for i, (r, a) in enumerate(zip(rows, res)):
            fine = r.get("fine-grained-label")
            f.write(json.dumps({"i": i, "label": int(r["label"]), "fine": int(fine) if fine not in (None, "") else None, "answers": a.get("answers", a)}, ensure_ascii=False, default=float) + "\n")
    print(json.dumps({"split": split, "rows": len(rows), "seconds": round(dt, 1), "per_item_ms": round(1000 * dt / len(rows), 2)}), flush=True)
print("DONE")
