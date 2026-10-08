"""Format and label profile of the 20k set, per source. Counts only (no text is printed).
Shows where sources differ in surface form (length, links, @mentions, #topics#, [emoji codes], traditional characters,
newlines, contact info), because a judge can learn "which source" instead of "violating or not" when those differ.
usage: python3 -I scripts/profile-eval.py [data/eval/eval20k.jsonl]
"""
import json
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from surface import KEYS, flags  # noqa: E402

path = sys.argv[1] if len(sys.argv) > 1 else "data/eval/eval20k.jsonl"
rows = [json.loads(l) for l in open(path, encoding="utf-8")]

by_src = defaultdict(list)
for r in rows:
    by_src[(r["group"], r["source"].split("+")[0], r["label_bin"])].append(r)


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(len(xs) * q))]


keys = KEYS
print("group/source/label | n | len p10/p50/p90 | " + " ".join(keys) + "  (% of items)")
for (g, s, lb), items in sorted(by_src.items()):
    lens = [len(r["text"]) for r in items]
    f = Counter()
    for r in items:
        for k, v in flags(r["text"]).items():
            f[k] += v
    cells = " ".join(f"{k}={100 * f[k] / len(items):.0f}" for k in keys if f[k])
    print(f"{g}/{s}/{lb} | {len(items)} | {pct(lens, .1)}/{pct(lens, .5)}/{pct(lens, .9)} | {cells}")

print("\n== original labels inside each sampled slice (label_orig value counts)")
for (g, s, lb), items in sorted(by_src.items()):
    c = Counter(str(r["label_orig"]) for r in items)
    if len(c) > 1:
        print(f"{g}/{s}/{lb}: {dict(c.most_common(8))}")
