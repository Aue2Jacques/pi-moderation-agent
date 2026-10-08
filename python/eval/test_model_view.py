import json
import os

from eval.model_view import eval_clean, model_view

CASES = json.load(open(os.path.join(os.path.dirname(__file__), "..", "..", "rules", "model-view-cases.json"), encoding="utf-8"))


def test_every_shared_case():
    bad = []
    for c in CASES["cases"]:
        got = model_view(eval_clean(c["in"]) if c.get("eval") else c["in"])
        if got != c["out"]:
            bad.append((c["in"], c["out"], got))
    assert not bad, bad


def test_version_matches_the_cases():
    from eval.model_view import VERSION
    assert VERSION == CASES["version"]
