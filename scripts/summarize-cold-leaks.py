"""Summarize check-cold-leaks.ts output by group. Prints counts only; for rows the second opinion could not settle it
prints GitHub links to the COLD test.csv line (for the project owner), never the text.
usage: python3 -I scripts/summarize-cold-leaks.py data/cold-eval/leak-check.jsonl
"""
import json
import sys
from collections import Counter, defaultdict

FINE = {0: "其他安全", 1: "攻击个人", 2: "攻击群体", 3: "反偏见", None: "-"}
URL = "https://github.com/thu-coai/COLDataset/blob/{branch}/COLDataset/test.csv?plain=1#L{line}"
BRANCH = sys.argv[2] if len(sys.argv) > 2 else "main"
rows = {}
for l in open(sys.argv[1], encoding="utf-8"):
    if l.strip():
        r = json.loads(l)
        if r["i"] not in rows or r["ok"]:
            rows[r["i"]] = r
by = defaultdict(list)
for r in rows.values():
    by[r["group"]].append(r)

names = {"leak": "漏放（COLD=冒犯，快判自动放行）", "ctl_block": "对照：COLD=冒犯，快判自动拦截", "ctl_pass": "对照：COLD=安全，快判自动放行"}
for g in ("leak", "ctl_block", "ctl_pass"):
    rs = [r for r in by[g] if r["ok"]]
    if not rs:
        continue
    n = len(rs)
    co = Counter(r["cold_offensive"] for r in rs)
    ab = Counter(r["abuse_rule"] for r in rs)
    ty = Counter(r["type"] for r in rs)
    fine = Counter(FINE[r["fine"]] for r in rs)
    print(f"\n== {names[g]}  n={n}（失败 {len(by[g]) - n}）")
    print("  按 COLD 定义算冒犯：" + "  ".join(f"{k} {v} ({v / n:.0%})" for k, v in co.most_common()))
    print("  按本平台辱骂规则：  " + "  ".join(f"{k} {v} ({v / n:.0%})" for k, v in ab.most_common()))
    print("  类型：" + "  ".join(f"{k} {v}" for k, v in ty.most_common()))
    if g == "leak":
        print("  COLD 细分：" + "  ".join(f"{k} {v}" for k, v in fine.most_common()))

unsure = [r for r in by["leak"] if r["ok"] and (r["cold_offensive"] == "unsure" or r["abuse_rule"] == "unsure")]
print(f"\n== 漏放组里第二意见也拿不准的 {len(unsure)} 条（COLD test.csv 行链接，正文请负责人自己看）")
for r in sorted(unsure, key=lambda r: r["i"]):
    print("  " + URL.format(branch=BRANCH, line=r["i"] + 2) + f"  （COLD 细分：{FINE[r['fine']]}，Jev 均值 {r['jev_p']}）")
