"""Data-pipeline test for scripts/split-formal.py (dev plan E7/E8), on a small synthetic eval set: whole families stay
in one part, families with a used member never reach test, and an existing split is never overwritten."""
import json
import os
import subprocess
import sys

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "split-formal.py")


def _write(tmp, items, used_ids):
    os.makedirs(tmp / "data" / "eval", exist_ok=True)
    with open(tmp / "data" / "eval" / "eval20k.jsonl", "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")
    with open(tmp / "data" / "eval" / "pilot-x-ids.txt", "w") as f:
        f.write("\n".join(used_ids) + "\n")


def _items():
    out = []
    for g in ("abuse", "everyday"):
        for k in range(60):
            fam = f"f{g}{k}"
            out.append({"id": f"{g}{k}", "family_id": fam, "group": g})
            if k % 5 == 0:   # every fifth family has a second member (an injection variant)
                out.append({"id": f"{g}{k}inj", "family_id": fam, "group": "injection"})
    return out


def test_families_stay_together_and_used_families_never_reach_test(tmp_path):
    items = _items()
    used = ["abuse0", "abuse1", "everyday2", "abuse5inj"]
    _write(tmp_path, items, used)
    r = subprocess.run([sys.executable, "-I", os.path.abspath(SCRIPT), "0.2"], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    rows = [json.loads(l) for l in open(tmp_path / "data" / "eval" / "split-v1.jsonl")]
    by_fam = {}
    for row in rows:
        by_fam.setdefault(row["family_id"], set()).add(row["split"])
    assert all(len(s) == 1 for s in by_fam.values())
    split_of = {row["id"]: row["split"] for row in rows}
    for u in used:
        assert split_of[u] != "test"
    assert split_of["abuse5"] != "test"   # same family as a used member
    assert {"train", "val", "test"} <= set(split_of.values())
    assert json.loads(r.stdout)["test_with_used_member"] == 0


def test_an_existing_split_is_never_overwritten(tmp_path):
    _write(tmp_path, _items(), [])
    first = subprocess.run([sys.executable, "-I", os.path.abspath(SCRIPT)], cwd=tmp_path, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    second = subprocess.run([sys.executable, "-I", os.path.abspath(SCRIPT)], cwd=tmp_path, capture_output=True, text=True)
    assert second.returncode != 0 and "never overwritten" in (second.stderr + second.stdout)


def test_refuses_an_eval_set_without_families(tmp_path):
    _write(tmp_path, [{"id": "a", "group": "abuse"}], [])
    r = subprocess.run([sys.executable, "-I", os.path.abspath(SCRIPT)], cwd=tmp_path, capture_output=True, text=True)
    assert r.returncode != 0 and "family_id" in (r.stderr + r.stdout)
