"""Owner reading document for the 2-model decomposition run: cases where the models disagree by 2+ levels (seeded sample)
and cases where both models disagree with Jev. Contains dataset text and model-quoted spans: written under data/ (gitignored).
usage: python3 -I scripts/build-decompose-doc.py <cases.jsonl> <test.jsonl> <test-run1.jsonl> <modelA.jsonl> <modelB.jsonl> <out.md> [n_disagree=20]
"""
import json
import random
import sys

cases_p, text_p, jev_p, a_p, b_p, out_p = sys.argv[1:7]
n_dis = int(sys.argv[7]) if len(sys.argv) > 7 else 20
FINE = {0: "安全·其他", 1: "冒犯·攻击个人", 2: "冒犯·攻击群体", 3: "安全·反偏见"}
ACTION = {0: "放行", 1: "放行，进抽查", 2: "限流/折叠", 3: "下架", 4: "下架并标记账号"}


def load(p, key="i"):
    out = {}
    for l in open(p, encoding="utf-8"):
        if l.strip():
            r = json.loads(l)
            if r[key] not in out or r.get("ok", r.get("status") == "ok"):
                out[r[key]] = r
    return out


cases = [json.loads(l) for l in open(cases_p, encoding="utf-8") if l.strip()]
texts = load(text_p)
jev = load(jev_p)
A, B = load(a_p), load(b_p)
rng = random.Random(20261012)
dis = [c for c in cases if c["kind"] == "models_disagree_2plus"]
picked = (
    [("A", "两个模型都说该处理（限流或下架），Jev 却直接放行", c) for c in cases if c["kind"] == "jev_pass_models_act"]
    + [("B", "Jev 直接拦截，两个模型都说该放行", c) for c in cases if c["kind"] == "jev_block_models_pass"]
    + [("C", f"两个模型差两级以上（从 {len(dis)} 条里随机抽 {min(n_dis, len(dis))} 条）", c) for c in rng.sample(dis, min(n_dis, len(dis)))]
)


def model_block(r):
    if not r or not r.get("ok"):
        return ["  - 调用失败"]
    lines = []
    for f, p in zip(r["frags"], r["per"]):
        extra = (f"（例外：{p['exception']}）" if p.get("exception") else "") + ("（自称反对偏见但在侮辱/贬低，例外不成立）" if p.get("inconsistent") else "")
        d3 = f"（{f.get('d3')}）" if f.get("d3") and f.get("d3") != "不适用" else ""
        lines.append(f"  - 「{f.get('span', '')}」对象 {f.get('d2')}{d3}；方式 {f.get('d4')}；表达 {f.get('d5')}；立场 {f.get('d6')} → S{p.get('s') if p.get('s') is not None else 0}{extra}")
    lv = r["level"]
    n = int(lv[1]) if lv[0] == "S" else None
    lines.append(f"  - 结论：**{lv}，{ACTION.get(n, '需要上下文') if not lv.endswith('?') else '需要上下文，交 agent'}**")
    return lines


md = [
    "# 两个模型按片段拆解的分歧条目（2026-10-08）",
    "",
    "给负责人看的。含 COLD 原文，不进 git。开发者没有读过这份文档。",
    "",
    f"背景：从 COLD 测试集四个细分类别各抽 250 条，共 1,000 条，deepseek-v4.1-flash 和 qwen3.8-flash 各按 `docs/policy/abuse-policy-draft.md` 的方案拆解一遍。严重度由代码查表得出。两个模型处置大类一致 71.9%。下面是最值得看的几类条目。",
    "",
    "每条末尾的\"你的判断\"写：该怎么判（放行 / 限流 / 下架），以及哪个模型拆得对、错在哪一步（对象、方式、立场）。值得当判例的标\"判例\"。",
    "",
]
cur = None
n = 0
for grp, title, c in picked:
    if grp != cur:
        md += [f"## {grp}. {title}", ""]
        cur = grp
    i = c["i"]
    n += 1
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
        f"> {texts[i]['text']}",
        "",
        f"- COLD 标签：{FINE.get(texts[i]['fine'], '-')}",
        f"- Jev：{jline}",
        f"- {A[i]['model'] if i in A else 'A'}：",
        *model_block(A.get(i)),
        f"- {B[i]['model'] if i in B else 'B'}：",
        *model_block(B.get(i)),
        "- 你的判断：",
        "",
    ]
open(out_p, "w", encoding="utf-8").write("\n".join(md) + "\n")
print(json.dumps({"out": out_p, "items": n}))
