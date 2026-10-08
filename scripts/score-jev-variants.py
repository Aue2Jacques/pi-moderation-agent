"""Compare Jev question variants on a COLD split. Pure Python (no numpy). Aggregates only.
- AUC of each single signal against COLD's binary label
- a small logistic-regression combiner over the C_bool answers (5-fold cross-validated, out-of-fold scores)
- the funnel trade-off at matched error rates: thresholds set so that leak (offensive auto-passed) and false block
  (safe auto-blocked) hit fixed targets; report how much is left for the agent
- whether choice `confidence` tells right from wrong decisions
usage: python3 -I scripts/score-jev-variants.py <baseline-run.jsonl> <A.jsonl> <B.jsonl> <C.jsonl>
"""
import json
import math
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from eval.funnel import funnel  # noqa: E402

base_p, a_p, b_p, c_p = sys.argv[1:5]


def load(p):
    out = {}
    for l in open(p, encoding="utf-8"):
        if l.strip():
            r = json.loads(l)
            if r["i"] not in out or r.get("ok", r.get("status") == "ok"):
                out[r["i"]] = r
    return out


B0, A, B, C = load(base_p), load(a_p), load(b_p), load(c_p)
ids = sorted(i for i in B0 if B0[i].get("status") == "ok" and A.get(i, {}).get("ok") and B.get(i, {}).get("ok") and C.get(i, {}).get("ok"))
y = [B0[i]["label"] for i in ids]
print(json.dumps({"rows_all_ok": len(ids), "A_ok": sum(1 for r in A.values() if r["ok"]), "B_ok": sum(1 for r in B.values() if r["ok"]), "C_ok": sum(1 for r in C.values() if r["ok"])}))
for nm, d in (("A_choice", A), ("B_score", B), ("C_bool", C)):
    ms = sorted(d[i]["ms"] for i in ids)
    tin = sum((d[i].get("usage") or {}).get("input", 0) for i in ids) / len(ids)
    tout = sum((d[i].get("usage") or {}).get("output", 0) for i in ids) / len(ids)
    print(f"{nm}: 延迟 p50 {ms[len(ms) // 2]}ms p95 {ms[int(len(ms) * .95)]}ms；平均 token 入 {tin:.0f} 出 {tout:.0f}")


def auc(s, lab):
    pairs = sorted(zip(s, lab))
    pos = sum(lab)
    neg = len(lab) - pos
    rank, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        rank += (i + j + 1) / 2 * sum(l for _, l in pairs[i:j])
        i = j
    return (rank - pos * (pos + 1) / 2) / (pos * neg)


def base_p_of(i):
    r = B0[i]
    a = r["primary"]["ABUSE-001"]["p"]
    b = (r["copy"] or {}).get("ABUSE-001", r["primary"]["ABUSE-001"])["p"]
    return (a + b) / 2


sig = {
    "现在的做法（选择题，3 题一起问，原序+副本均值）": [base_p_of(i) for i in ids],
    "A 选择题单独问：违规概率": [A[i]["answers"]["abuse"]["probabilities"].get("violate", 0) for i in ids],
    "B 打分题：分数（0–4）": [B[i]["answers"]["severity"]["score"] for i in ids],
}
BOOLS = ["insult_person", "demean_group", "threat", "humiliate_person", "criticize_conduct", "counter_bias", "stereotype"]
for k in BOOLS:
    sig[f"C 是非题：{k}"] = [C[i]["answers"][k]["probability"] for i in ids]

# logistic regression (L2), pure python, standardized features
def standardize(X):
    cols = list(zip(*X))
    mu = [sum(c) / len(c) for c in cols]
    sd = [math.sqrt(sum((v - m) ** 2 for v in c) / len(c)) or 1.0 for c, m in zip(cols, mu)]
    return [[(v - m) / s for v, m, s in zip(row, mu, sd)] for row in X], mu, sd


def fit_lr(X, Y, l2=1e-3, iters=400, lr=0.5):
    w = [0.0] * (len(X[0]) + 1)
    n = len(X)
    for _ in range(iters):
        g = [0.0] * len(w)
        for x, t in zip(X, Y):
            z = w[0] + sum(wi * xi for wi, xi in zip(w[1:], x))
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            e = p - t
            g[0] += e
            for k, xi in enumerate(x):
                g[k + 1] += e * xi
        w = [wi - lr * (gi / n + (l2 * wi if k else 0)) for k, (wi, gi) in enumerate(zip(w, g))]
    return w


def oof_lr(feats):
    X = [list(r) for r in zip(*feats)]
    idx = list(range(len(X)))
    random.Random(7).shuffle(idx)
    folds = [idx[k::5] for k in range(5)]
    out = [0.0] * len(X)
    for k in range(5):
        test = set(folds[k])
        tr = [j for j in idx if j not in test]
        Xs, mu, sd = standardize([X[j] for j in tr])
        w = fit_lr(Xs, [y[j] for j in tr])
        for j in folds[k]:
            x = [(v - m) / s for v, m, s in zip(X[j], mu, sd)]
            z = w[0] + sum(wi * xi for wi, xi in zip(w[1:], x))
            out[j] = 1 / (1 + math.exp(-max(-30, min(30, z))))
    return out


sig["C 是非题 7 道 → 组合模型（5 折交叉验证）"] = oof_lr([sig[f"C 是非题：{k}"] for k in BOOLS])
a_conf = [A[i]["answers"]["abuse"]["confidence"] for i in ids]
sig["A+B+C 全部一起 → 组合模型（参考上限，要调 3 次）"] = oof_lr([sig["A 选择题单独问：违规概率"], a_conf, sig["B 打分题：分数（0–4）"]] + [sig[f"C 是非题：{k}"] for k in BOOLS])

print("\n== 区分好坏的能力（AUC，越高越好；对照 COLD 二分类标签）")
for k, s in sig.items():
    print(f"  {auc(s, y):.3f}  {k}")


print("\n== 漏斗取舍：漏放、误拦都按实际值核对（dev plan 2026-10-08 §2.3；旧版按分位数取阈值、同分时会失效，旧数字作废）")
for lt, ft in ((0.15, 0.05), (0.10, 0.03), (0.20, 0.05)):
    print(f"  目标 漏放 ≤{lt:.0%}、误拦 ≤{ft:.0%}：")
    for k in ["现在的做法（选择题，3 题一起问，原序+副本均值）", "A 选择题单独问：违规概率", "B 打分题：分数（0–4）", "C 是非题 7 道 → 组合模型（5 折交叉验证）", "A+B+C 全部一起 → 组合模型（参考上限，要调 3 次）"]:
        r = funnel(sig[k], y, lt, ft)
        print(f"    交 agent {r['to_agent']:6.1%}  实际漏放 {r['leak_actual']:5.1%}  实际误拦 {r['fb_actual']:5.1%}  放行线 <{r['pass_below']:.4g}  拦截线 ≥{r['block_at_or_above']:.4g}  n={r['n']}（违规 {r['n_violating']} / 正常 {r['n_normal']}）  {k}")

# does choice confidence separate right from wrong argmax decisions?
choice = [A[i]["answers"]["abuse"]["choice"] for i in ids]
right = [(c == "violate") == (l == 1) for c, l in zip(choice, y) if c in ("violate", "none")]
confs = [cf for cf, c in zip(a_conf, choice) if c in ("violate", "none")]
print(f"\n== A 选择题的把握度：能否区分判对和判错（AUC）{auc(confs, [1 if r else 0 for r in right]):.3f}；判对率 {sum(right) / len(right):.1%}")
for lo, hi in ((0, .6), (.6, .8), (.8, .9), (.9, .95), (.95, 1.01)):
    sel = [r for r, cf in zip(right, confs) if lo <= cf < hi]
    if sel:
        print(f"    把握度 {lo:.2f}–{min(hi, 1):.2f}: n={len(sel):5d} 判对 {sum(sel) / len(sel):.1%}")
