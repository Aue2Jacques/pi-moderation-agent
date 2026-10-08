"""Score the v2 policy prompt (two models) on a COLD subset and compare with the old fragment decomposition on the SAME rows.
Prints aggregates only.
usage: python3 -I scripts/score-v2.py <ids.jsonl> <test-run1.jsonl> <v2A.jsonl> <v2B.jsonl> <oldA.jsonl> <oldB.jsonl>
"""
import json
import sys
from collections import Counter, defaultdict

ids_p, jev_p, va_p, vb_p, oa_p, ob_p = sys.argv[1:7]
FINE = {0: "安全·其他", 1: "冒犯·攻击个人", 2: "冒犯·攻击群体", 3: "安全·反偏见"}
CATS = ["放行", "限流", "下架"]


def load(p):
    out = {}
    for l in open(p, encoding="utf-8"):
        if l.strip():
            r = json.loads(l)
            if r["i"] not in out or r.get("ok", r.get("status") == "ok"):
                out[r["i"]] = r
    return out


rows = [json.loads(l) for l in open(ids_p) if l.strip()]
ids = [r["i"] for r in rows]
fine = {r["i"]: r["fine"] for r in rows}
jev = load(jev_p)
VA, VB, OA, OB = load(va_p), load(vb_p), load(oa_p), load(ob_p)
na, nb = next(iter(VA.values()))["model"], next(iter(VB.values()))["model"]


def num(level):
    return int(level[1]) if level and level[0] == "S" and level[1].isdigit() else None


def bucket(level):
    n = num(level)
    return None if n is None else ("放行" if n <= 1 else ("限流" if n == 2 else "下架"))


def agreement(A, B, label):
    ok = [i for i in ids if A.get(i, {}).get("ok") and B.get(i, {}).get("ok")]
    bk = [(bucket(A[i]["level"]), bucket(B[i]["level"])) for i in ok]
    po = sum(x == y for x, y in bk) / len(ok)
    pa, pb = Counter(x for x, _ in bk), Counter(y for _, y in bk)
    pe = sum(pa[c] / len(ok) * pb[c] / len(ok) for c in CATS)
    kappa = (po - pe) / (1 - pe) if pe < 1 else 1.0
    exact = sum(A[i]["level"] == B[i]["level"] for i in ok) / len(ok)
    print(f"{label}: n={len(ok)}  严重度完全一致 {exact:.1%}  处置大类一致 {po:.1%}  kappa {kappa:.3f}")
    return ok, bk


print(json.dumps({"rows": len(ids), f"v2 {na} ok": sum(1 for i in ids if VA.get(i, {}).get("ok")), f"v2 {nb} ok": sum(1 for i in ids if VB.get(i, {}).get("ok"))}, ensure_ascii=False))
for nm, d in ((na, VA), (nb, VB)):
    m = sorted(d[i]["ms"] for i in ids if d.get(i, {}).get("ok"))
    print(f"v2 {nm}: 单条耗时 p50 {m[len(m) // 2]}ms p95 {m[int(len(m) * .95)]}ms")

print("\n== 两个模型一致性：新版 vs 旧版（同一批条目）")
ok, bk = agreement(VA, VB, "新版 v2（先判违规）")
agreement(OA, OB, "旧版（按片段拆）  ")
conf = Counter(bk)
print(f"新版处置交叉表（行={na}，列={nb}）")
for x in CATS:
    print(f"  {x}: " + "  ".join(f"{y} {conf[(x, y)]}" for y in CATS))

print("\n== 新版：各模型的判断分布")
for nm, d in ((na, VA), (nb, VB)):
    rs = [d[i] for i in ids if d.get(i, {}).get("ok")]
    dec = Counter(r["decision"] for r in rs)
    rule = Counter(r.get("rule") for r in rs if r["decision"] == "违规")
    bok = sum(1 for r in rs if r.get("basis_ok")) / len(rs)
    print(f"  {nm}: " + "、".join(f"{k} {v}" for k, v in dec.most_common()) + f"；违规里 " + "、".join(f"{k} {v}" for k, v in rule.most_common()) + f"；依据条目能在规则原文里找到 {bok:.0%}")

print("\n== 新版按 COLD 细分类别（两模型一致时取一致结果）")
by = defaultdict(Counter)
for i, (x, y) in zip(ok, bk):
    by[FINE[fine[i]]][x if x == y else "分歧"] += 1
for k in FINE.values():
    c = by[k]
    n = sum(c.values())
    if n:
        print(f"  {k:10s} n={n:4d}  " + "  ".join(f"{t} {c[t] / n:5.1%}" for t in CATS + ["分歧"]))

print("\n== 新版和 Jev 快判对照（两模型一致的条目）")
cross = Counter()
for i, (x, y) in zip(ok, bk):
    if x != y or i not in jev or jev[i]["status"] != "ok":
        continue
    a = jev[i]["primary"]["ABUSE-001"]["p"]
    b = (jev[i]["copy"] or {}).get("ABUSE-001", jev[i]["primary"]["ABUSE-001"])["p"]
    js = "拦截" if (a + b) / 2 >= 0.9 else ("放行" if a < 0.1 and b < 0.1 else "交agent")
    cross[(js, x)] += 1
for js in ["拦截", "交agent", "放行"]:
    row = [cross[(js, c)] for c in CATS]
    n = sum(row)
    if n:
        print(f"  Jev {js:5s} n={n:4d}  新版: " + "  ".join(f"{c} {v} ({v / n:.0%})" for c, v in zip(CATS, row)))
