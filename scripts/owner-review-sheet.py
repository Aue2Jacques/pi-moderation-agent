"""usage (dev box, repo root): python3 scripts/owner-review-sheet.py <date>
Owner review sheet for the validation items the frozen labelling procedure left to the owner (source = owner).
Writes data/review/val-owner-items-<date>.md on the dev box (dataset text: never committed, never printed here)."""
import json, sys, datetime
date = sys.argv[1]
val = set(l.strip() for l in open("data/eval/val-all-ids.txt") if l.strip())
text = {}
for l in open("data/eval/eval20k.jsonl"):
    r = json.loads(l)
    if r["id"] in val: text[r["id"]] = r["text"]
name = {"ds": "deepseek", "qw": "qwen", "tie": "gemini 第三票"}
std_title = {"abuse-v4.3": "辱骂（ABUSE-001，标准 v4.3）", "marketing-v2": "营销引流（MARKETING-003，标准 v2）"}
out = [f"# 验证集交负责人判定的条目（{date}）", "",
       "冻结打标流程（deepseek、qwen 各 3 次取多数，分歧交 gemini 第三票）仍定不下来的验证集条目，按规定交负责人判定。目前它们在标签文件里记为 uncertain。",
       "标准原文见仓库 `docs/policy/labeling-standard-v4.md`。",
       "", "**怎么填**：在每条的「负责人判定」后写 `违规` / `允许` / `不确定`（可加一句理由）。填完告诉我，我把结果写回标签文件（来源记为 owner_decided），并重算验证集统计。",
       "", "本文件含数据集原文，只在开发机上，不提交、不外传。", ""]
n = 0
for std in ("abuse-v4.3", "marketing-v2"):
    rows = []
    for l in open(f"data/eval/labels-{std}.jsonl"):
        r = json.loads(l)
        if r.get("source") == "owner" and r["id"] in val: rows.append(r)
    out += [f"## {std_title[std]}：{len(rows)} 条", ""]
    for k, r in enumerate(rows, 1):
        votes = "，".join(f"{name.get(m, m)} {v}" for m, v in r.get("votes", {}).items())
        out += [f"### {std.split('-')[0]}-{k}　`{r['id']}`", "", f"三方投票：{votes}", "", "> " + text.get(r["id"], "（原文缺失）").replace("\n", "\n> "), "",
                "负责人判定：", ""]
        n += 1
open(f"data/review/val-owner-items-{date}.md", "w").write("\n".join(out) + "\n")
print(json.dumps({"items": n, "file": f"data/review/val-owner-items-{date}.md"}))
