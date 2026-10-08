"""Owner reading document comparing the v2 policy prompt with the old decomposition on the rows the owner already saw
(rows listed in earlier reading documents). Contains dataset text: written under data/ (gitignored).
usage: python3 -I scripts/build-v2-doc.py <owner-ids.jsonl> <test.jsonl> <test-run1.jsonl> <v2A.jsonl> <v2B.jsonl> <oldA.jsonl> <oldB.jsonl> <out.md>
"""
import json
import sys

ids_p, text_p, jev_p, va_p, vb_p, oa_p, ob_p, out_p = sys.argv[1:9]
FINE = {0: "安全·其他", 1: "冒犯·攻击个人", 2: "冒犯·攻击群体", 3: "安全·反偏见"}


def load(p):
    out = {}
    try:
        for l in open(p, encoding="utf-8"):
            if l.strip():
                r = json.loads(l)
                if r["i"] not in out or r.get("ok", r.get("status") == "ok"):
                    out[r["i"]] = r
    except FileNotFoundError:
        pass
    return out


items = [json.loads(l) for l in open(ids_p) if l.strip()]
texts, jev = load(text_p), load(jev_p)
VA, VB, OA, OB = load(va_p), load(vb_p), load(oa_p), load(ob_p)


def v2line(r):
    if not r or not r.get("ok"):
        return "调用失败"
    rule = f" {r.get('rule')}" if r.get("decision") == "违规" and r.get("rule") else ""
    return f"**{r['decision']}{rule}** → {r['level']}，{r['action']}；依据：{r.get('basis', '')}；理由：{r.get('reason', '')}"


def oldline(r):
    return r["level"] if r and r.get("ok") else "-"


md = [
    "# 新版提示词（v2）对照阅读文档（2026-10-11）",
    "",
    "给负责人看的。含 COLD 原文，不进 git。开发者没有读过这份文档。",
    "",
    "新版提示词：`rules/prompts/abuse-policy-v2.txt`（先判违规 / 允许 / 不确定，再按 V2–V4 定轻重）。这里列的都是你之前在两份阅读文档里看到过的条目，每条给出新版两个模型的判断，并附旧版（按片段拆）的结论作对照。",
    "",
    "每条末尾\"你的判断\"写：新版判得对不对；不对的话，问题出在\"允许\"清单、违规清单还是例子。",
    "",
]
cur = None
for n, it in enumerate(items, 1):
    if it["src"] != cur:
        cur = it["src"]
        md += [f"## 来自：{cur}", ""]
    i = it["i"]
    t = texts.get(i)
    j = jev.get(i)
    if j and j.get("status") == "ok":
        a = j["primary"]["ABUSE-001"]["p"]
        b = (j["copy"] or {}).get("ABUSE-001", j["primary"]["ABUSE-001"])["p"]
        js = "拦截" if (a + b) / 2 >= 0.9 else ("放行" if a < 0.1 and b < 0.1 else "交 agent")
        jline = f"{a:.2f} / {b:.2f}，快判结果：{js}"
    else:
        jline = "无数据"
    md += [
        f"### {n}. COLD 第 {i + 2} 行",
        "",
        f"> {t['text'] if t else '（无原文）'}",
        "",
        f"- COLD 标签：{FINE.get(t['fine'], '-') if t else '-'}",
        f"- Jev：{jline}",
        f"- 旧版（按片段拆）：deepseek {oldline(OA.get(i))}，qwen {oldline(OB.get(i))}",
        f"- 新版 deepseek：{v2line(VA.get(i))}",
        f"- 新版 qwen：{v2line(VB.get(i))}",
        "- 你的判断：",
        "",
    ]
open(out_p, "w", encoding="utf-8").write("\n".join(md) + "\n")
print(json.dumps({"out": out_p, "items": len(items)}))
