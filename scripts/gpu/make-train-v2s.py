# GPU server, one-off: builds /hy-tmp/train/train-v2s.jsonl from train-v1.jsonl and the rules block of train-v2-rf.jsonl (see export-kev-train.ts LAYOUT / QUESTIONS for the regular export).
"""train-v2s: the v1 records (same items, same labels) in the rules-first + short-question form kevfast serves with
KF_LAYOUT=rules_first KF_QUESTIONS=short: state = {rules (the rulesFirst block), content, evidence}; each question =
the rule key with bare option names (empty descriptions)."""
import json, hashlib
rf = json.loads(open("/hy-tmp/train/train-v2-rf.jsonl").readline())
R = rf["state"]["rules"]
names = {k: list(q["criteria"]) for k, q in rf["questions"].items()}
out = open("/hy-tmp/train/train-v2s.jsonl", "w")
n = 0
for l in open("/hy-tmp/train/train-v1.jsonl"):
    x = json.loads(l)
    qs = {k: {"type": "choice", "instructions": k, "criteria": {o: "" for o in names[k]}, "label": q["label"]} for k, q in x["questions"].items()}
    out.write(json.dumps({"state": {"rules": R, **x["state"]}, "questions": qs, "_meta": x["_meta"]}, ensure_ascii=False) + "\n"); n += 1
out.close()
print(n, hashlib.sha256(open("/hy-tmp/train/train-v2s.jsonl", "rb").read()).hexdigest()[:16])
