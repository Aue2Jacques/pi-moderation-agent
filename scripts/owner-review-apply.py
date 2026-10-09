"""Write the owner's decisions from a filled review sheet (scripts/owner-review-sheet.py) back into the label files.

Each item block is `### <std>-<n>　`<id>`` ... `负责人判定：<违规|允许|不确定>[ reason]`. Decided items get label violate /
allow / uncertain with source owner_decided (the votes are kept, plus owner_note); blank decisions are left as they are;
an unknown word or an id the label file does not hold as source=owner stops the run before anything is written.
usage (dev box, repo root): python3 scripts/owner-review-apply.py <sheet.md> [--write]   (default: dry run, counts only)"""
import collections
import json
import re
import sys

WORDS = {"违规": "violate", "允许": "allow", "不确定": "uncertain"}
STD = {"abuse": "abuse-v4.3", "marketing": "marketing-v2"}
HEAD = re.compile(r"^### (abuse|marketing)-\d+\s+`([^`]+)`")
DECIDE = re.compile(r"^负责人判定[：:]\s*(.*)$")


def parse(lines):
    """-> [(standard, id, label or None, note)] in sheet order; raises on an unknown decision word."""
    out, cur = [], None
    for ln in lines:
        m = HEAD.match(ln.strip())
        if m:
            cur = (STD[m.group(1)], m.group(2)); continue
        d = DECIDE.match(ln.strip())
        if d and cur:
            raw = d.group(1).strip()
            if not raw:
                out.append((*cur, None, "")); cur = None; continue
            word = next((w for w in WORDS if raw.startswith(w)), None)
            if word is None: raise ValueError(f"unknown decision for {cur[1]}: {raw!r} (use 违规 / 允许 / 不确定)")
            out.append((*cur, WORDS[word], raw[len(word):].strip(" ，,。:：")))
            cur = None
    return out


def apply(rows, decisions):
    """rows: one label file's records; decisions: {id: (label, note)} for that standard. -> (new rows, counts)."""
    seen, out, c = set(), [], collections.Counter()
    for r in rows:
        if r["id"] in decisions:
            if r.get("source") != "owner": raise ValueError(f"{r['id']} is not an owner item in {r.get('standard')} (source={r.get('source')})")
            label, note = decisions[r["id"]]
            r = {**r, "label": label, "source": "owner_decided", **({"owner_note": note} if note else {})}
            seen.add(r["id"]); c[label] += 1
        out.append(r)
    missing = set(decisions) - seen
    if missing: raise ValueError(f"ids not in the label file: {sorted(missing)[:5]}")
    return out, c


def main(argv):
    sheet, write = argv[1], "--write" in argv
    items = parse(open(sheet, encoding="utf-8").read().splitlines())
    by_std = collections.defaultdict(dict)
    for std, i, label, note in items:
        if label: by_std[std][i] = (label, note)
    report = {"items": len(items), "decided": sum(len(v) for v in by_std.values()), "blank": sum(1 for x in items if x[2] is None)}
    results = {}
    for std, dec in by_std.items():
        path = f"data/eval/labels-{std}.jsonl"
        rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
        results[std] = (path, *apply(rows, dec))
    for std, (path, rows, c) in results.items():
        report[std] = dict(c)
        if write:
            with open(path, "w", encoding="utf-8") as f:
                for r in rows: f.write(json.dumps(r, ensure_ascii=False) + "\n")
    report["written"] = write
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv)
