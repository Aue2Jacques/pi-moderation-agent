"""Unify the eval set's labels (owner 2026-10-08: clean the 20k before training): every item's own source label is mapped
to this platform's rules through eval/source-label-map-v1.json — ABUSE (ABUSE-001), MARKETING (MARKETING-003) or SAFE —
with how far the mapping can be trusted (basis: dataset / remapped / boundary / assumed / authored; injection and
perturbation variants follow their parent and say so in `variant`). Texts are not changed and not written; very short
items are flagged.

  map     -> data/eval/source-labels-v1.jsonl  {id, split, source, cat, basis, variant, short, rule}; an item no rule matches
             stops the run (nothing is mapped by default)
  sample  -> data/eval/clean-check-ids.txt: train items for an unbiased check of the mapping, stratified by basis
             (SAMPLE_PER_BASIS), fixed hash order, no text read; label them with the frozen procedure, then `check`
  check   -> how the mapping agrees with the platform labels (frozen procedure, data/eval/labels-*.jsonl) on items that
             carry them, train and val only (the test split is not used to judge the cleaning); counts only

usage (repo root, dev box): python3 scripts/map-source-labels.py map|sample|check
"""
import collections
import json
import os
import sys

MAP_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "eval", "source-label-map-v1.json")
EVAL = "data/eval/eval20k.jsonl"
SPLIT = "data/eval/split-v1.jsonl"
OUT = "data/eval/source-labels-v1.jsonl"
VARIANTS = ("+injection",)
SAMPLE_PER_BASIS = {"dataset": 80, "assumed": 50, "boundary": 30, "authored": 20, "derived": 10, "remapped": 10}


def load_map(path=MAP_PATH):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def match(m, item):
    """(rule index, rule, variant) for an item; raises when no rule matches."""
    source, variant = item["source"], None
    for v in VARIANTS:
        if source.endswith(v):
            source, variant = source[: -len(v)], v.lstrip("+")
    for k, r in enumerate(m["rules"]):
        if r["source"] != source:
            continue
        if "label_orig" in r and r["label_orig"] != item.get("label_orig"):
            continue
        if "label_bin" in r and r["label_bin"] != item.get("label_bin"):
            continue
        return k, r, variant
    raise ValueError(f"no mapping rule for source={item['source']!r} label_orig={item.get('label_orig')!r} label_bin={item.get('label_bin')!r} (id {item['id']})")


def map_items(m, items, split):
    out = []
    for it in items:
        k, r, variant = match(m, it)
        out.append({"id": it["id"], "split": split.get(it["id"]), "source": it["source"], "cat": r["cat"], "basis": r["basis"],
                    "variant": variant or ("perturbation" if r["basis"] == "derived" else None),
                    "short": len(it.get("text_strip") or it.get("text") or "") <= m["short_chars"], "rule": k})
    return out


def sample(mapped, per_basis=SAMPLE_PER_BASIS):
    """Train items only, per basis the first n in a fixed hash order (independent of file order)."""
    import hashlib
    out = []
    for basis, n in per_basis.items():
        pool = sorted((r for r in mapped if r["split"] == "train" and r["basis"] == basis), key=lambda r: hashlib.sha256(f"clean-check-v1|{r['id']}".encode()).hexdigest())
        out += [r["id"] for r in pool[:n]]
    return out


def platform_cat(abuse, marketing):
    """The frozen labels as one category: violate -> that rule (both -> BOTH); both allow -> SAFE; else None."""
    if abuse is None or marketing is None:
        return None
    if abuse == "violate" and marketing == "violate":
        return "BOTH"
    if abuse == "violate":
        return "ABUSE"
    if marketing == "violate":
        return "MARKETING"
    if abuse == "allow" and marketing == "allow":
        return "SAFE"
    return "uncertain"


def check(mapped, labels_abuse, labels_marketing):
    """Agreement of the mapped category with the platform category, per basis and per source (train/val only)."""
    by = collections.defaultdict(collections.Counter)
    for r in mapped:
        if r["split"] == "test":
            continue
        pc = platform_cat(labels_abuse.get(r["id"]), labels_marketing.get(r["id"]))
        if pc is None:
            continue
        for key in (f"basis:{r['basis']}", f"source:{r['source']}"):
            t = by[key]
            t["n"] += 1
            if pc == "uncertain":
                t["platform_uncertain"] += 1
            elif pc == r["cat"] or (pc == "BOTH" and r["cat"] in ("ABUSE", "MARKETING")):
                t["agree"] += 1
            else:
                t[f"{r['cat']}->{pc}"] += 1
    return {k: dict(v) for k, v in sorted(by.items())}


def _jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main(argv):
    phase = argv[1] if len(argv) > 1 else ""
    m = load_map()
    if phase == "map":
        split = {r["id"]: r["split"] for r in _jsonl(SPLIT)}
        mapped = map_items(m, _jsonl(EVAL), split)
        with open(OUT, "w", encoding="utf-8") as f:
            for r in mapped:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        c = collections.Counter((r["split"], r["basis"], r["cat"]) for r in mapped)
        print(json.dumps({"map": m["version"], "items": len(mapped), "short": sum(r["short"] for r in mapped),
                          "by_split_basis_cat": {"|".join(map(str, k)): v for k, v in sorted(c.items())}}, ensure_ascii=False, indent=1))
    elif phase == "sample":
        ids = sample(_jsonl(OUT))
        with open("data/eval/clean-check-ids.txt", "w") as f:
            f.write("\n".join(ids) + "\n")
        print(json.dumps({"sampled": len(ids), "per_basis": SAMPLE_PER_BASIS}))
    elif phase == "check":
        mapped = _jsonl(OUT)
        lab = lambda std: {r["id"]: r["label"] for r in _jsonl(f"data/eval/labels-{std}.jsonl")}
        print(json.dumps(check(mapped, lab("abuse-v4.3"), lab("marketing-v2")), ensure_ascii=False, indent=1))
    else:
        raise SystemExit("usage: map-source-labels.py map|sample|check")


if __name__ == "__main__":
    main(sys.argv)
