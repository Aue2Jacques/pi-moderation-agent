"""Pilot for the abuse labeling standard (docs/policy/abuse-standard-v3.md). Two subcommands, counts only:
  sample [n=400]  pick dev-split items (abuse 30%, dataset safe 30%, hard negatives 20%, everyday 20%), stratified by
                  slice, fixed seed -> data/eval/pilot-ids.txt
  score           agreement between the two models under v2 and v3 (binary 违规 vs not; v2's 不确定 counts as not),
                  Cohen's kappa, per-question agreement for v3, by group, and the consensus against the original labels
  sample-abuse [n=300]  abuse-only tuning set (keeps the pilot's abuse items) -> data/eval/pilot-abuse-ids.txt
usage: python3 -I scripts/pilot-abuse-standard.py sample|sample-abuse|score   (score reads PILOT_IDS)
"""
import json
import os
import random
import sys
from collections import Counter, defaultdict

EVAL, IDS, RUNS = "data/eval/eval20k.jsonl", "data/eval/pilot-ids.txt", "data/eval/pilot-runs.jsonl"
SHARE = {"abuse": .3, "dataset_safe": .3, "hard_negative": .2, "everyday": .2}
rows = {r["id"]: r for r in map(json.loads, open(EVAL, encoding="utf-8"))}

if sys.argv[1] == "sample-abuse":   # tuning set for the abuse slice: earlier pilot abuse items + dev top-up, by source
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    rng = random.Random(10082)
    prior = [i for i in (l.strip() for l in open(IDS)) if i and rows[i]["group"] == "abuse"]
    pool = defaultdict(list)
    for r in rows.values():
        if r["group"] == "abuse" and r["split"] == "dev" and r["id"] not in prior:
            pool[r["slice"].split("/")[1]].append(r["id"])
    total, picked = sum(len(v) for v in pool.values()), list(prior)
    for src, lst in sorted(pool.items()):
        picked += rng.sample(sorted(lst), min(len(lst), round((n - len(prior)) * len(lst) / total)))
    open("data/eval/pilot-abuse-ids.txt", "w").write("\n".join(sorted(set(picked))) + "\n")
    print(json.dumps({"picked": len(set(picked)), "kept_from_pilot": len(prior), "by_source": Counter(rows[i]["slice"].split("/")[1] for i in set(picked))}))
    sys.exit()

if sys.argv[1] == "sample":
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 400
    rng = random.Random(1008)
    picked = []
    for g, share in SHARE.items():
        pool = defaultdict(list)
        for r in rows.values():
            if r["group"] == g and r["split"] == "dev":
                pool[r["slice"]].append(r["id"])
        total = sum(len(v) for v in pool.values())
        want = round(n * share)
        for s, ids in sorted(pool.items()):
            k = max(1, round(want * len(ids) / total))
            picked += rng.sample(sorted(ids), min(k, len(ids)))
    open(IDS, "w").write("\n".join(sorted(set(picked))) + "\n")
    print(json.dumps({"picked": len(set(picked)), "by_group": Counter(rows[i]["group"] for i in set(picked))}))
    sys.exit()

IDS_FILE = os.environ.get("PILOT_IDS", IDS)
ids = [l.strip() for l in open(IDS_FILE) if l.strip()]
LABELERS = ["deepseek-v4.1-flash", "qwen3.8-flash"]   # the label pair; anyone else (jev) is measured against them
QS = ("q1", "q2", "q3", "q4", "q5", "q6", "q7")

# runs[(prompt, rep, temp)][model][id] = row ; a config is one way of asking
runs = defaultdict(lambda: defaultdict(dict))
fails = Counter()
for r in map(json.loads, open(RUNS, encoding="utf-8")):
    cfg = (r["prompt"], r.get("rep", 1), r.get("temp"))
    if r["ok"]:
        runs[cfg][r["model"]][r["id"]] = r
    else:
        fails[(cfg, r["model"], r["id"])] += 1


def kappa(pairs):
    n = len(pairs)
    po = sum(a == b for a, b in pairs) / n
    ca, cb = Counter(a for a, _ in pairs), Counter(b for _, b in pairs)
    pe = sum(ca[k] * cb[k] for k in set(ca) | set(cb)) / n / n
    return (po - pe) / (1 - pe) if pe < 1 else 1.0


def name(cfg, m):
    p, rep, t = cfg
    return f"{m}[{p} rep{rep}{'' if t is None else f' T={t}'}]"


def compare(ca, ma, cb, mb, questions=False):
    A, B = runs[ca][ma], runs[cb][mb]
    both = [i for i in ids if i in A and i in B]
    missing = {name(ca, ma): sum(1 for i in ids if i not in A), name(cb, mb): sum(1 for i in ids if i not in B)}
    if not both:
        return
    v = lambda r: r["decision"] == "违规"
    pairs = [(v(A[i]), v(B[i])) for i in both]
    print(f"\n== {name(ca, ma)} vs {name(cb, mb)}: n {len(both)} (missing {missing})")
    print(f"   binary agreement {sum(x == y for x, y in pairs) / len(pairs):.1%}  kappa {kappa(pairs):.2f}  "
          f"violation rate {sum(x for x, _ in pairs) / len(pairs):.1%} / {sum(y for _, y in pairs) / len(pairs):.1%}")
    by = defaultdict(list)
    for i, (x, y) in zip(both, pairs):
        by[rows[i]["group"]].append(x == y)
    print("   by group: " + "  ".join(f"{g} {sum(v_) / len(v_):.1%} (n {len(v_)})" for g, v_ in sorted(by.items())))
    if questions and "facts" in A[both[0]] and "facts" in B[both[0]]:
        for q in QS:
            qa = [(A[i]["facts"][q], B[i]["facts"][q]) for i in both]
            print(f"   {q}: agreement {sum(x == y for x, y in qa) / len(qa):.1%}  kappa {kappa(qa):.2f}  'yes' {sum(x for x, _ in qa)}/{sum(y for _, y in qa)}")


cfgs = sorted(runs, key=lambda c: (c[0], c[1], -1 if c[2] is None else c[2]))
print("configs:", [(c, {m: len(v) for m, v in runs[c].items()}) for c in cfgs])
print("failed calls (not recovered):", Counter((name(c, m)) for (c, m, i) in fails if i not in runs[c][m]))
for c in cfgs:                                     # the two labelers, same way of asking
    if all(m in runs[c] for m in LABELERS):
        compare(c, LABELERS[0], c, LABELERS[1], questions=c[0].startswith("v3"))
for c in cfgs:                                     # each model against itself: same prompt and temperature, rep 1 vs 2
    if c[1] == 1 and (c[0], 2, c[2]) in runs:
        for m in runs[c]:
            if m in runs[(c[0], 2, c[2])]:
                compare(c, m, (c[0], 2, c[2]), m)
for c in cfgs:                                     # jev (or any other judge) against each labeler
    for other in sorted(set(runs[c]) - set(LABELERS)):
        for m in LABELERS:
            if m in runs[c]:
                compare(c, m, c, other, questions=True)
