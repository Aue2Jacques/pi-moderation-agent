# Kaggle kernel (CPU): score Laya and Kev zero-shot outputs on COLD where they live (kernel_sources), with exactly the
# method used for Jev in scripts/score-jev-variants.py: single-signal AUC, a 5-fold logistic-regression combiner over the
# 7 yes/no questions, and the funnel at matched error rates. Prints a compact summary only; raw files stay on Kaggle.
import glob, gzip, io, json, math, os, random

def find(name):
    hits = [p for p in glob.glob("/kaggle/input/**/*", recursive=True) if os.path.basename(p) in (name, name + ".gz")]
    return hits[0] if hits else None

def rows(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]

BOOLS = ["insult_person", "demean_group", "threat", "humiliate_person", "criticize_conduct", "counter_bias", "stereotype"]

def num(a, *keys):
    """Pull a probability out of an answer whatever the runtime's field names are."""
    if isinstance(a, (int, float)):
        return float(a)
    if not isinstance(a, dict):
        return None
    for k in keys:
        if k in a and isinstance(a[k], (int, float)):
            return float(a[k])
    return None

def choice_p(a):
    if not isinstance(a, dict):
        return None
    probs = a.get("probabilities") or a.get("probs") or a.get("distribution")
    if isinstance(probs, dict):
        return float(probs.get("violate", 0.0))
    return None

def bool_p(a):
    return num(a, "noul", "probability", "p", "value", "true")

def auc(s, y):
    pairs = sorted(zip(s, y)); pos = sum(y); neg = len(y) - pos
    rank, i = 0.0, 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        rank += (i + j + 1) / 2 * sum(l for _, l in pairs[i:j]); i = j
    return (rank - pos * (pos + 1) / 2) / (pos * neg)

def fit_lr(X, Y, iters=400, lr=0.5, l2=1e-3):
    w = [0.0] * (len(X[0]) + 1); n = len(X)
    for _ in range(iters):
        g = [0.0] * len(w)
        for x, t in zip(X, Y):
            z = w[0] + sum(a * b for a, b in zip(w[1:], x)); p = 1 / (1 + math.exp(-max(-30, min(30, z)))); e = p - t
            g[0] += e
            for k, v in enumerate(x):
                g[k + 1] += e * v
        w = [wi - lr * (gi / n + (l2 * wi if k else 0)) for k, (wi, gi) in enumerate(zip(w, g))]
    return w

def standardize(X, ref=None):
    ref = ref or X
    cols = list(zip(*ref)); mu = [sum(c) / len(c) for c in cols]
    sd = [math.sqrt(sum((v - m) ** 2 for v in c) / len(c)) or 1.0 for c, m in zip(cols, mu)]
    return [[(v - m) / s for v, m, s in zip(r, mu, sd)] for r in X], (mu, sd)

def predict(w, X):
    return [1 / (1 + math.exp(-max(-30, min(30, w[0] + sum(a * b for a, b in zip(w[1:], x)))))) for x in X]

def oof(X, y):
    idx = list(range(len(X))); random.Random(7).shuffle(idx); folds = [idx[k::5] for k in range(5)]; out = [0.0] * len(X)
    for k in range(5):
        test = set(folds[k]); tr = [j for j in idx if j not in test]
        Xs, (mu, sd) = standardize([X[j] for j in tr])
        w = fit_lr(Xs, [y[j] for j in tr])
        for j, p in zip(folds[k], predict(w, [[(v - m) / s for v, m, s in zip(X[j], mu, sd)] for j in folds[k]])):
            out[j] = p
    return out

def funnel(s, y, lt, ft):
    # inline copy of python/eval/funnel.py (Kaggle runs this file alone; keep them identical). Thresholds are taken
    # where the ACTUAL leak / false-block rates meet the targets (dev plan 2026-10-08 §2.3); returns the to-agent share.
    pos = [v for v, l in zip(s, y) if l == 1]; neg = [v for v, l in zip(s, y) if l == 0]
    cands = sorted(set(s)) + [math.inf]
    leak = lambda t: sum(1 for v in pos if v < t) / len(pos)
    fb = lambda u: sum(1 for v in neg if v >= u) / len(neg)
    t = max((c for c in cands if leak(c) <= lt), default=min(cands))
    u = min(c for c in cands if fb(c) <= ft)
    t = min(t, u)
    return sum(1 for v in s if t <= v < u) / len(s)

for model in ("laya", "kev"):
    dev_p, test_p = find(f"{model}-dev.jsonl"), find(f"{model}-test.jsonl")
    cfg = find("kev-run.json") if model == "kev" else None
    print(f"\n######## {model}  dev={dev_p}  test={test_p}  config={json.load(open(cfg)) if cfg else '-'}")
    if not dev_p:
        print("no dev output found"); continue
    dev = rows(dev_p)
    first = dev[0]["answers"]
    print("answer shape sample:", json.dumps({k: (sorted(v.keys()) if isinstance(v, dict) else type(v).__name__) for k, v in first.items()}, ensure_ascii=False))
    def feats(r):
        a = r["answers"] if isinstance(r.get("answers"), dict) else {}
        c = choice_p(a.get("abuse"))
        bs = [bool_p(a.get(k)) for k in BOOLS]
        return c, bs
    ok = [(r, *feats(r)) for r in dev]
    ok = [(r, c, bs) for r, c, bs in ok if c is not None and all(b is not None for b in bs)]
    print(f"dev usable rows {len(ok)}/{len(dev)}")
    if len(ok) < 100:
        continue
    y = [r["label"] for r, _, _ in ok]
    sig = {"choice: violate prob": [c for _, c, _ in ok]}
    for k, kname in enumerate(BOOLS):
        sig[f"bool: {kname}"] = [bs[k] for _, _, bs in ok]
    sig["7 bools -> LR (5-fold OOF)"] = oof([bs for _, _, bs in ok], y)
    sig["choice + 7 bools -> LR (5-fold OOF)"] = oof([[c] + bs for _, c, bs in ok], y)
    print("AUC on COLD dev:")
    for k, s in sig.items():
        print(f"  {auc(s, y):.3f}  {k}")
    for lt, ft in ((0.15, 0.05), (0.10, 0.03), (0.20, 0.05)):
        print(f"funnel leak {lt:.0%} / false-block {ft:.0%}: to agent  choice {funnel(sig['choice: violate prob'], y, lt, ft):.1%}  7bool-LR {funnel(sig['7 bools -> LR (5-fold OOF)'], y, lt, ft):.1%}  all-LR {funnel(sig['choice + 7 bools -> LR (5-fold OOF)'], y, lt, ft):.1%}")
    if test_p:
        test = [(r, *feats(r)) for r in rows(test_p)]
        test = [(r, c, bs) for r, c, bs in test if c is not None and all(b is not None for b in bs)]
        yt = [r["label"] for r, _, _ in test]
        Xd = [bs for _, _, bs in ok]; Xs, (mu, sd) = standardize(Xd); w = fit_lr(Xs, y)
        st = predict(w, [[(v - m) / s for v, m, s in zip(bs, mu, sd)] for _, _, bs in test])
        print(f"COLD test (held out; combiner trained on all of dev): choice AUC {auc([c for _, c, _ in test], yt):.3f}  7bool-LR AUC {auc(st, yt):.3f}  n={len(test)}")
print("\nSCORING DONE")
