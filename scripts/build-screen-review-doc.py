"""Owner reading doc for the everyday-comment screening (scripts/screen-eval.ts): the items where the two models
disagree, plus a small sample of items both called 违规 (to check the exclusion is right). Writes
data/review/eval20k-screening.md on the dev box; prints counts only (the developer does not read the text).
usage: python3 -I scripts/build-screen-review-doc.py [sample_both=30]
"""
import json
import os
import random
import sys
from collections import defaultdict

MODELS = os.environ.get("SCREEN_MODELS", "qwen3.8-flash,deepseek-v4.1-flash").split(",")   # same pair as screen-eval.ts

n_both = int(sys.argv[1]) if len(sys.argv) > 1 else 30
items = {}
for p in ("data/eval/excluded.jsonl", "data/eval/eval20k.jsonl"):   # excluded items are no longer in the set itself
    if os.path.exists(p):
        for l in open(p, encoding="utf-8"):
            r = json.loads(l)
            items[r["id"]] = r
dec = defaultdict(dict)
for l in open("data/eval/screen.jsonl", encoding="utf-8"):
    r = json.loads(l)
    if r["decision"]:
        dec[r["id"]][r["model"]] = (r["decision"], r.get("rule"))
models = MODELS
split, both = [], []
for i, d in dec.items():
    if i not in items or any(m not in d for m in models):
        continue
    ds = [d[m][0] for m in models]
    if all(x == "违规" for x in ds):
        both.append(i)
    elif "违规" in ds:
        split.append(i)
random.Random(5).shuffle(both)

out = ["# 日常评论筛查：需要负责人看的条目", "",
       "日常评论默认是正常的。两个模型（" + "、".join(models) + "）按 v2 规则各判了一遍。", "",
       "- 第一部分：两家意见不一致（一家判违规、一家没判），目前**保留在正常集里**。请标出你认为该剔除的。",
       f"- 第二部分：两家都判违规、已被剔除的，随机抽 {n_both} 条，请确认剔除是对的。", ""]
for title, ids in (("一、两家意见不一致", sorted(split, key=lambda i: (items[i]["slice"], i))), ("二、两家都判违规（抽样）", both[:n_both])):
    out += [f"## {title}（{len(ids)} 条）", ""]
    for i in ids:
        it = items[i]
        verdict = "；".join(f"{m}: {d[0]}{' ' + d[1] if d[1] else ''}" for m, d in ((m, dec[i][m]) for m in models))
        out += [f"- `{i}`（{it['slice']}）{verdict}", f"  > {it['text'].replace(chr(10), ' ')}", ""]
open("data/review/eval20k-screening.md", "w", encoding="utf-8").write("\n".join(out))
print(json.dumps({"disagree": len(split), "both_violate": len(both), "sampled_both": min(n_both, len(both))}))
