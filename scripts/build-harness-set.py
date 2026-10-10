"""Harness showcase set: real test-split texts, balanced by category, to run through the real fast path and the real
agent (scripts/run-ac.ts prepare / run C). The console's Agent page replays the recorded sessions.

Six categories, PER each (default 50): normal (everyday + safe), hard_negative, abuse, adversarial (pinyin / emoji /
space / swap perturbations of abuse), marketing, injection. Inside a category, items the judge was unsure about on the
frozen test run come first (any rule's calibrated violation probability between the pass and block lines, i.e. the ones
the fast path hands to the agent); then the rest of the frozen test run; then other test-split items. Order inside each
tier is a fixed hash, so the set is reproducible. Output is in run-ac's case format (no thread, no account history: the
agent finds what a real first-time poster has). Text stays on the server (data/ is not committed).
usage (repo root, dev box): python3 scripts/build-harness-set.py data/eval/eval20k.jsonl data/eval/test-v1-ids.txt \
  data/eval/test-v1-jev/answers-text.jsonl calib/jev-latest data/harness/h300.jsonl [PER=50]
"""

import hashlib, json, math, sys
from collections import Counter
from pathlib import Path

PASS, BLOCK = 0.1, 0.9
CATS = ["normal", "hard_negative", "abuse", "adversarial", "marketing", "injection"]
EXPECT = {"abuse": ("takedown", ["ABUSE-001"]), "adversarial": ("takedown", ["ABUSE-001"]), "marketing": ("limit", ["MARKETING-003"])}


def cat_of(slice_: str) -> str:
    top = slice_.split("/")[0]
    return {"everyday": "normal", "safe": "normal"}.get(top, top)


def temps(d: str) -> dict:
    out = {}
    for f in Path(d).glob("*.json"):
        c = json.loads(f.read_text())
        q = (c.get("bucket") or {}).get("question")
        if q and c.get("T", 0) > 0 and q not in out: out[q] = c["T"]
    return out


def calibrated_violate(dist: dict, T: float) -> float:
    logits = {k: math.log(max(v, 1e-12)) / T for k, v in dist.items()}
    m = max(logits.values())
    z = sum(math.exp(v - m) for v in logits.values())
    return math.exp(logits.get("violate", -1e9) - m) / z


def unsure(ans: dict, ts: dict) -> bool:
    for q, dist in (ans.get("primary") or {}).items():
        if q == "injection_guard" or q not in ts: continue
        p = calibrated_violate(dist, ts[q])
        if PASS <= p < BLOCK: return True
    return False


def h(x: str) -> str:
    return hashlib.sha256(("harness-v1|" + x).encode()).hexdigest()


def main(eval_path, ids_path, answers_path, calib_dir, out_path, per="50"):
    per = int(per)
    frozen = set(Path(ids_path).read_text().split())
    ts = temps(calib_dir)
    answers = {}
    for line in open(answers_path, encoding="utf-8"):
        a = json.loads(line)
        if a.get("ok") and a.get("view") == "text": answers[a["id"]] = a
    tiers = {c: ([], [], []) for c in CATS}
    for line in open(eval_path, encoding="utf-8"):
        r = json.loads(line)
        if r.get("split") != "test" or not r.get("text"): continue
        c = cat_of(r["slice"])
        if c not in tiers: continue
        a = answers.get(r["id"]) if r["id"] in frozen else None
        tier = 0 if a and unsure(a, ts) else 1 if r["id"] in frozen else 2
        tiers[c][tier].append(r)
    picked, stats = [], {}
    for c in CATS:
        rows = [x for t in tiers[c] for x in sorted(t, key=lambda r: h(r["id"]))][:per]
        stats[c] = {"picked": len(rows), "unsure_first": min(per, len(tiers[c][0])), "pool": [len(t) for t in tiers[c]]}
        picked += [(c, r) for r in rows]
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as out:
        for i, (c, r) in enumerate(picked):
            label = r.get("label_bin") == 1
            disp, rules = EXPECT.get(c, ("pass", [])) if label else ("pass", [])
            if c == "injection": disp, rules = ("human", []) if label else ("pass", [])
            out.write(json.dumps({"case_id": f"h300-{c}-{i:03d}", "kind": c, "source": r["slice"],
                                  "target": {"text": r["text"], "account": f"u_h300_{i:03d}", "mentions": [], "images": []},
                                  "thread": [], "reply_to": None, "history": [],
                                  "expected": {"disposition": disp, "rules": rules}}, ensure_ascii=False) + "\n")
    print(json.dumps({"written": len(picked), "by_category": stats, "calib_questions": sorted(ts)}, ensure_ascii=False))


if __name__ == "__main__":
    main(*sys.argv[1:7])
