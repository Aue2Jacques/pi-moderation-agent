"""Score an eval-cold.ts output against COLD labels. Uncalibrated (raw) Jev probabilities; never reads text.
Reports: ABUSE score quality (AUC, best F1), the fast path's three-state outcome with the current thresholds
(block: mean of primary+copy >= 0.90 and EX-QUOTE not_applies on both; pass: both copies < 0.10 with choice none
on ABUSE and MARKETING), per COLD fine-grained class, plus calibration error and cost/latency.
usage: python3 -I scripts/score-cold.py data/cold-eval/test-run.jsonl
"""
import json
import sys
from collections import Counter, defaultdict

FINE = {0: "其他安全", 1: "攻击个人", 2: "攻击群体", 3: "反偏见(安全)"}
BLOCK, PASS = 0.90, 0.10

_by_i = {}
for _l in open(sys.argv[1], encoding="utf-8"):
    if _l.strip():
        _r = json.loads(_l)
        if _r["i"] not in _by_i or _r["status"] == "ok":   # a resumed run may retry a failed row: keep the ok line
            _by_i[_r["i"]] = _r
rows = list(_by_i.values())
ok = [r for r in rows if r["status"] == "ok"]
print(json.dumps({"rows": len(rows), "ok": len(ok), "failed": Counter(r["status"] for r in rows if r["status"] != "ok")}, ensure_ascii=False))


def abuse(r, which="primary"):
    a = (r[which] or {}).get("ABUSE-001")
    return a


def mean_p(r):
    a, b = abuse(r), abuse(r, "copy")
    return (a["p"] + b["p"]) / 2 if b else a["p"]


def auc(scores, labels):
    pairs = sorted(zip(scores, labels))
    pos = sum(labels)
    neg = len(labels) - pos
    rank_sum, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        avg_rank = (i + j + 1) / 2
        rank_sum += avg_rank * sum(l for _, l in pairs[i:j])
        i = j
    return (rank_sum - pos * (pos + 1) / 2) / (pos * neg)


labels = [r["label"] for r in ok]
scores = [mean_p(r) for r in ok]
print("\n== ABUSE 分数本身（原始概率，未校准；取原序与副本均值）")
print(f"AUC {auc(scores, labels):.4f}")
best = max(((t / 100, *(lambda tp, fp, fn: (2 * tp / (2 * tp + fp + fn) if tp else 0, tp / (tp + fp) if tp + fp else 0, tp / (tp + fn) if tp + fn else 0))(
    sum(1 for s, l in zip(scores, labels) if s >= t / 100 and l == 1),
    sum(1 for s, l in zip(scores, labels) if s >= t / 100 and l == 0),
    sum(1 for s, l in zip(scores, labels) if s < t / 100 and l == 1))) for t in range(1, 100)), key=lambda x: x[1])
print(f"最佳 F1 阈值 {best[0]:.2f}: F1 {best[1]:.3f}  精确率 {best[2]:.3f}  召回率 {best[3]:.3f}")
for t in (0.5, 0.9):
    tp = sum(1 for s, l in zip(scores, labels) if s >= t and l == 1)
    fp = sum(1 for s, l in zip(scores, labels) if s >= t and l == 0)
    fn = sum(1 for s, l in zip(scores, labels) if s < t and l == 1)
    print(f"阈值 {t:.2f}: 精确率 {tp / (tp + fp) if tp + fp else 0:.3f}  召回率 {tp / (tp + fn):.3f}")
choices = Counter(abuse(r)["choice"] for r in ok)
print("ABUSE 原序答案的选项分布", dict(choices))
hist = Counter(round(s, 1) for s in scores)
print("分数分布（0.1 一档）", dict(sorted(hist.items())))

# ECE on the violate probability as a binary forecast
bins = defaultdict(lambda: [0, 0.0, 0])
for s, l in zip(scores, labels):
    b = min(9, int(s * 10))
    bins[b][0] += 1
    bins[b][1] += s
    bins[b][2] += l
ece = sum(n / len(ok) * abs(ps / n - ls / n) for n, ps, ls in bins.values())
print(f"ECE（10 档）{ece:.4f}；各档 预测均值→实际冒犯比例：" + "  ".join(f"{b / 10:.1f}:{ps / n:.2f}→{ls / n:.2f}(n={n})" for b, (n, ps, ls) in sorted(bins.items())))


def state(r):
    a, b = abuse(r), abuse(r, "copy")
    ex = [(r[w] or {}).get("ABUSE-001.EX-QUOTE") for w in ("primary", "copy")]
    mk = [(r[w] or {}).get("MARKETING-003") for w in ("primary", "copy")]
    if mean_p(r) >= BLOCK and all(e and e["choice"] == "not_applies" for e in ex if e is not None):
        return "拦截"
    both_low = lambda xs: all(x and x["p"] < PASS and x["choice"] == "none" for x in xs if x is not None)
    if both_low([a, b]) and both_low(mk):
        return "放行"
    return "疑似"


print("\n== 快判三态（当前阈值：拦截 ≥0.90，放行 <0.10 且两份都满足）")
by = defaultdict(Counter)
for r in ok:
    by["全部"][state(r)] += 1
    by[f"label={r['label']}"][state(r)] += 1
    if r.get("fine") is not None:
        by[FINE[r["fine"]]][state(r)] += 1
for k in ["全部", "label=0", "label=1", *FINE.values()]:
    if k in by:
        c = by[k]
        n = sum(c.values())
        print(f"{k:12s} n={n:5d}  拦截 {c['拦截'] / n:6.1%}  放行 {c['放行'] / n:6.1%}  疑似 {c['疑似'] / n:6.1%}")
exq = Counter((r["primary"].get("ABUSE-001.EX-QUOTE") or {}).get("choice") for r in ok)
print("EX-QUOTE 原序答案分布", dict(exq))

lat = sorted(r["latency_ms"] for r in ok)
tin = sum(r["usage"]["input"] for r in ok)
tout = sum(r["usage"]["output"] for r in ok)
print(f"\n延迟 p50 {lat[len(lat) // 2]}ms  p95 {lat[int(len(lat) * 0.95)]}ms；token 入 {tin} 出 {tout}（平均每条 {tin / len(ok):.0f}/{tout / len(ok):.0f}）")
