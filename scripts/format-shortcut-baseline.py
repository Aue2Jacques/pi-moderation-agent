"""Shortcut check: how well do surface features alone (length, links, @, [emoji codes], traditional characters, newlines,
contact info) predict the binary label? A set without source artifacts should give an AUC close to 0.5. Counts only.
usage: python -I scripts/format-shortcut-baseline.py [data/eval/eval20k.jsonl]   (.venv-data: scikit-learn)
"""
import json
import math
import os
import sys

from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import cross_val_predict

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))
from surface import flags  # noqa: E402

path = sys.argv[1] if len(sys.argv) > 1 else "data/eval/eval20k.jsonl"
rows = [json.loads(l) for l in open(path, encoding="utf-8")]
X = [[math.log1p(len(r["text"]))] + [float(v) for v in flags(r["text"]).values()] for r in rows]
y = [r["label_bin"] for r in rows]


def oof_auc(feats):
    p = cross_val_predict(LogisticRegression(max_iter=2000), feats, y, cv=5, method="predict_proba")[:, 1]
    return round(roc_auc_score(y, p), 3)


print(json.dumps({"all": {"n": len(y), "auc_surface_only": oof_auc(X), "auc_length_only": oof_auc([[x[0]] for x in X])}}))
# adversarial and injection items carry markers on purpose and are reported as their own paired slices
keep = [k for k, r in enumerate(rows) if r["group"] not in ("adversarial", "injection")]
X, y = [X[k] for k in keep], [y[k] for k in keep]
print(json.dumps({"natural_only": {"n": len(y), "auc_surface_only": oof_auc(X), "auc_length_only": oof_auc([[x[0]] for x in X])}}))
