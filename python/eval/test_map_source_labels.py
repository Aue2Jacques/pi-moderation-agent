"""scripts/map-source-labels.py on synthetic items (no dataset text): the shipped mapping table, rule order, variants,
unmapped items, short items, and the platform-label check leaving the test split out."""
import importlib.util
import os

import pytest

_SPEC = importlib.util.spec_from_file_location("map_source_labels", os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "map-source-labels.py"))
msl = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(msl)
M = msl.load_map()


def item(id_, source, label_orig=None, label_bin=0, text="一段足够长的文本"):
    return {"id": id_, "source": source, "label_orig": label_orig, "label_bin": label_bin, "text_strip": text}


def test_mapping_table_rules():
    items = [
        item("c1", "COLD", "1", 1), item("c3", "COLD", "3", 0),
        item("t3", "ToxiCN", "3", 1), item("t0", "ToxiCN", "0", 1), item("t0s", "ToxiCN", "0", 0), item("t1", "ToxiCN", "1", 1),
        item("h_ind", "HateCheck-zh", "target_indiv_nh", 0), item("h_prof", "HateCheck-zh", "profanity_nh", 0), item("h_slur", "HateCheck-zh", "slur_h", 1),
        item("fraud", "ChineseHarm", "欺诈", 1), item("weibo", "SophonPlus/weibo_senti_100k", "1", 0), item("self", "self-written"),
    ]
    got = {it["id"]: (r["cat"], r["basis"]) for it, r in zip(items, msl.map_items(M, items, {}))}
    assert got["c1"] == ("ABUSE", "dataset") and got["c3"] == ("SAFE", "dataset")          # anti-bias is safe under our rule
    assert got["t3"] == ("ABUSE", "boundary") and got["t0"] == ("ABUSE", "boundary")      # reporting / toxic-not-hate
    assert got["t0s"] == ("SAFE", "dataset") and got["t1"] == ("ABUSE", "dataset")         # label_bin decides before label_orig
    assert got["h_ind"] == ("ABUSE", "remapped") and got["h_prof"] == ("SAFE", "dataset") and got["h_slur"] == ("ABUSE", "dataset")
    assert got["fraud"] == ("MARKETING", "dataset")
    assert got["weibo"] == ("SAFE", "assumed") and got["self"] == ("SAFE", "authored")


def test_variants_follow_the_parent_and_unknown_items_stop_the_run():
    inj, pert = msl.map_items(M, [item("i", "ToxiCN+injection", "3", 1), item("p", "ToxiCN+perturb", "toxic", 1)], {})
    assert (inj["cat"], inj["basis"], inj["variant"]) == ("ABUSE", "boundary", "injection")
    assert (pert["cat"], pert["basis"], pert["variant"]) == ("ABUSE", "derived", "perturbation")
    with pytest.raises(ValueError, match="no mapping rule"):
        msl.map_items(M, [item("x", "NewDataset", "1", 1)], {})
    with pytest.raises(ValueError):
        msl.map_items(M, [item("y", "ChineseHarm", "赌博", 1)], {})                       # a label the table does not know


def test_short_flag_and_split():
    r1, r2 = msl.map_items(M, [item("a", "self-written", text="好"), item("b", "self-written")], {"a": "train"})
    assert r1["short"] is True and r1["split"] == "train" and r2["short"] is False and r2["split"] is None


def test_check_leaves_test_out_and_counts_disagreements():
    mapped = [
        {"id": "a", "split": "train", "source": "S", "cat": "SAFE", "basis": "assumed"},
        {"id": "b", "split": "val", "source": "S", "cat": "SAFE", "basis": "assumed"},
        {"id": "c", "split": "test", "source": "S", "cat": "SAFE", "basis": "assumed"},
        {"id": "d", "split": "train", "source": "T", "cat": "ABUSE", "basis": "dataset"},
        {"id": "e", "split": "train", "source": "T", "cat": "ABUSE", "basis": "dataset"},
    ]
    ab = {"a": "allow", "b": "violate", "c": "violate", "d": "violate", "e": "uncertain"}
    mk = {"a": "allow", "b": "allow", "c": "allow", "d": "violate", "e": "allow"}
    out = msl.check(mapped, ab, mk)
    assert out["basis:assumed"] == {"n": 2, "agree": 1, "SAFE->ABUSE": 1}                    # c (test) not counted
    assert out["basis:dataset"] == {"n": 2, "agree": 1, "platform_uncertain": 1}             # BOTH counts as agreeing with ABUSE


def test_sample_is_train_only_stratified_and_order_independent():
    mapped = [{"id": f"{b}{k}", "split": "train" if k % 4 else "val", "basis": b} for b in ("dataset", "assumed") for k in range(40)]
    a = msl.sample(mapped, {"dataset": 5, "assumed": 3})
    b = msl.sample(list(reversed(mapped)), {"dataset": 5, "assumed": 3})
    assert a == b and len(a) == 8
    assert all(int(i.lstrip("datsetum")) % 4 for i in a)                                       # val items never sampled
    assert sum(i.startswith("dataset") for i in a) == 5
