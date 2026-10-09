"""GPU check: kevfast in native/full mode against kev's own path (DecisionModel.probs on kev.model.encode), same
checkpoint, same texts. Prints max / mean |dp| and changed top choices; bf16 noise is the expected level.
usage (kev venv): python -m kevfast.check_parity <run> <wire questions json> <texts jsonl with "text"> [n=48]"""
import json, statistics as st, sys

import torch

from kevfast.common import load, to_engine_request
from kevfast.engine import Engine, Options

run, wire_path, texts_path = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 48
tok, model = load(run)
wire = json.load(open(wire_path))
texts = [json.loads(l)["text"] for l, _ in zip(open(texts_path), range(n))]
eng = Engine(tok, model, Options())
from kev.model import encode
from kev.api import render, option_text
dps, flips, total = [], 0, 0
for s in range(0, len(texts), 16):
    batch = texts[s:s + 16]
    reqs = [to_engine_request({"content": {"text": t, "scene": "comment"}, "evidence": []}, wire, "native", True)[0] for t in batch]
    got = eng.answer(reqs)
    for t, g in zip(batch, got):
        rec = {"state": render({"content": {"text": t, "scene": "comment"}, "evidence": []}),
               "questions": [{"instr": render(q["instructions"]), "options": [option_text(k, v) for k, v in q["criteria"].items()], "label": 0} for q in wire.values()]}
        ref = model.probs(encode(tok, rec))
        for a, b in zip(ref, g):
            a, b = a.float().cpu(), b.float().cpu()
            dps.append(float((a - b).abs().max())); flips += int(a.argmax() != b.argmax()); total += 1
print(json.dumps({"questions": total, "max_dp": round(max(dps), 4), "mean_dp": round(st.mean(dps), 5), "top_choice_changed": flips}))
