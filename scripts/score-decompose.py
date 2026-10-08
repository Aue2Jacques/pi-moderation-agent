"""Compare two models' fragment-level decompositions on COLD rows, against COLD labels and Jev's fast path.
Prints aggregates only (no text, no spans). Also writes an owner reading-list of ids (for build-decompose-doc).
usage: python3 -I scripts/score-decompose.py <ids.jsonl> <test-run1.jsonl> <modelA.jsonl> <modelB.jsonl> <cases-out.jsonl>
"""
import json
import sys
from collections import Counter, defaultdict

ids_p, jev_p, a_p, b_p, cases_p = sys.argv[1:6]
FINE = {0: "安全·其他", 1: "冒犯·攻击个人", 2: "冒犯·攻击群体", 3: "安全·反偏见"}


def load(p):
    out = {}
    for l in open(p, encoding="utf-8"):
        if l.strip():
            r = json.loads(l)
            if r["i"] not in out or r.get("ok", r.get("status") == "ok"):
                out[r["i"]] = r
    return out


ids = [json.loads(l)["i"] for l in open(ids_p) if l.strip()]
fine = {json.loads(l)["i"]: json.loads(l)["fine"] for l in open(ids_p) if l.strip()}
jev = load(jev_p)
A, B = load(a_p), load(b_p)
name_a = next(iter(A.values()))["model"]
name_b = next(iter(B.values()))["model"]


def num(level):
    return int(level[1]) if level and level[0] == "S" else None


def bucket(level):
    n = num(level)
    if n is None:
        return None
    return "放行" if n <= 1 else ("限流" if n == 2 else "下架")


def jev_state(r):
    a = r["primary"]["ABUSE-001"]["p"]
    b = (r["copy"] or {}).get("ABUSE-001", r["primary"]["ABUSE-001"])["p"]
    mean = (a + b) / 2
    return "拦截" if mean >= 0.9 else ("放行" if a < 0.1 and b < 0.1 else "交agent")


ok = [i for i in ids if A.get(i, {}).get("ok") and B.get(i, {}).get("ok")]
print(json.dumps({"sampled": len(ids), f"{name_a}_ok": sum(1 for i in ids if A.get(i, {}).get("ok")), f"{name_b}_ok": sum(1 for i in ids if B.get(i, {}).get("ok")), "both_ok": len(ok)}, ensure_ascii=False))
ms = lambda d: sorted(d[i]["ms"] for i in ids if d.get(i, {}).get("ok"))
for nm, d in ((name_a, A), (name_b, B)):
    m = ms(d)
    print(f"{nm}: 单条耗时 p50 {m[len(m) // 2]}ms p95 {m[int(len(m) * .95)]}ms")

# 1. inter-model agreement
exact = sum(A[i]["level"] == B[i]["level"] for i in ok)
within1 = sum(abs(num(A[i]["level"]) - num(B[i]["level"])) <= 1 for i in ok)
bk = [(bucket(A[i]["level"]), bucket(B[i]["level"])) for i in ok]
same_bucket = sum(x == y for x, y in bk)
cats = ["放行", "限流", "下架"]
po = same_bucket / len(ok)
pa = Counter(x for x, _ in bk)
pb = Counter(y for _, y in bk)
pe = sum(pa[c] / len(ok) * pb[c] / len(ok) for c in cats)
kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
print(f"\n== 两个模型一致性（{len(ok)} 条）")
print(f"严重度完全一致 {exact / len(ok):.1%}；差一级以内 {within1 / len(ok):.1%}；处置大类一致 {po:.1%}；Cohen's kappa（处置大类）{kappa:.3f}")
conf = Counter(bk)
print("处置大类交叉表（行=" + name_a + "，列=" + name_b + "）")
for x in cats:
    print(f"  {x}: " + "  ".join(f"{y} {conf[(x, y)]}" for y in cats))

# 2. our severity by COLD fine class (consensus = both models agree on bucket)
print("\n== 按 COLD 细分类别，我们的处置（两模型一致时取一致结果；不一致记为'分歧'）")
by = defaultdict(Counter)
for i in ok:
    x, y = bk[ok.index(i)]
    by[FINE[fine[i]]][x if x == y else "分歧"] += 1
for k in FINE.values():
    c = by[k]
    n = sum(c.values())
    if n:
        print(f"  {k:10s} n={n:4d}  " + "  ".join(f"{t} {c[t] / n:5.1%}" for t in ["放行", "限流", "下架", "分歧"]))

# 3. vs Jev fast path
print("\n== 和 Jev 快判对照（两模型一致的条目）")
cross = Counter()
cases = []
for i in ok:
    x, y = bucket(A[i]["level"]), bucket(B[i]["level"])
    js = jev_state(jev[i]) if i in jev and jev[i]["status"] == "ok" else "无"
    if x == y:
        cross[(js, x)] += 1
        if js == "放行" and x in ("限流", "下架"):
            cases.append({"i": i, "kind": "jev_pass_models_act", "a": A[i]["level"], "b": B[i]["level"], "jev": js, "fine": fine[i]})
        if js == "拦截" and x == "放行":
            cases.append({"i": i, "kind": "jev_block_models_pass", "a": A[i]["level"], "b": B[i]["level"], "jev": js, "fine": fine[i]})
    elif abs(num(A[i]["level"]) - num(B[i]["level"])) >= 2:
        cases.append({"i": i, "kind": "models_disagree_2plus", "a": A[i]["level"], "b": B[i]["level"], "jev": js, "fine": fine[i]})
for js in ["拦截", "交agent", "放行"]:
    row = [cross[(js, c)] for c in cats]
    n = sum(row)
    if n:
        print(f"  Jev {js:5s} n={n:4d}  我们: " + "  ".join(f"{c} {v} ({v / n:.0%})" for c, v in zip(cats, row)))

# 4. exceptions and consistency
print("\n== 片段与例外")
for nm, d in ((name_a, A), (name_b, B)):
    frs = [(f, p) for i in ok for f, p in zip(d[i]["frags"], d[i]["per"])]
    d6 = Counter(f["d6"] for f, _ in frs)
    ex = Counter(p["exception"] for _, p in frs if p.get("exception"))
    inc = sum(1 for _, p in frs if p.get("inconsistent"))
    nfr = Counter(len(d[i]["frags"]) for i in ok)
    print(f"  {nm}: 片段 {len(frs)}（每条平均 {len(frs) / len(ok):.1f}）；立场分布 " + "、".join(f"{k} {v}" for k, v in d6.most_common()) + f"；例外生效 {dict(ex)}；自称反对偏见但在侮辱/贬低（例外不成立）{inc}")

kinds = Counter(c["kind"] for c in cases)
print("\n== 值得负责人看的条目", dict(kinds))
with open(cases_p, "w", encoding="utf-8") as f:
    for c in cases:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
