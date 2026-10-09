"""GPU checks against kev's own path (DecisionModel.probs on kev.model.encode), same checkpoint, same texts:
  native  kevfast native/full (two_pass, dense padded + CUDA graphs) vs kev on the native record: must agree to bf16 noise
  *-varlen  two_pass as packed varlen passes (dense=False)
  *-rows  the same with branch_mode=rows (one pass, the comment recomputed per question), 16 requests per call
  rules-rows-graph  one request per call: the padded rows path replayed from CUDA graphs
  native-fp8 (--fp8)  fp8=on against kev in bf16: the FP8 rounding drift (expected to exceed bf16 noise)
  rules   kevfast rules_first/full vs kev on the same tokens as one state ([<state>] rules + "\\n" + content): the cached
          prefix + per-segment attention path must agree to bf16 noise too (the checkpoint is not trained on this layout,
          so only agreement is meaningful, not the answers)
Prints max / mean |dp| and changed top choices per check.
usage (kev venv): python -m kevfast.check_parity <run> <wire questions json> <texts jsonl with "text"> [n=48]"""
import json, statistics as st, sys

from kevfast.common import load, to_engine_request
from kevfast.engine import Engine, Options

run, wire_path, texts_path = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else 48
tok, model = load(run)
wire = json.load(open(wire_path))
texts = [json.loads(l)["text"] for l, _ in zip(open(texts_path), range(n))]
from kev.model import encode, user_tokens, SPECIAL, rows_of
from kev.api import render, option_text
rules = {k: {"instructions": q["instructions"], "options": q["criteria"]} for k, q in wire.items() if "#" not in k}


def kev_rows_first(t):
    """kev's own row computation on exactly the token sequence kevfast builds for rules_first."""
    import torch, torch.nn.functional as F
    content = {"content": {"text": t, "scene": "comment"}, "evidence": []}
    er = to_engine_request({"rules": rules, **content}, wire, "rules_first", True)[0]
    eng0 = engines["rules"]
    S = [tok.convert_tokens_to_ids(SPECIAL[0])] + user_tokens(tok, er["prefix"] + "\n") + user_tokens(tok, er["content"])
    rows = []
    for q in er["questions"]:
        b = eng0.branch_tokens(q)
        rows.append(b)
    with torch.no_grad():
        Ls, cache, _ = model.prefix({"ids": S, "pos": list(range(len(S))), "seg": [0] * len(S)})
        hs = model._rows_hidden([(b, list(range(Ls, Ls + len(b)))) for b in rows], cache=cache, prefix_len=Ls)
    out = []
    for h, b in zip(hs, rows):
        oe = [j for j, x in enumerate(b) if x == eng0.c_id]
        out.append(F.softmax(model.head(h[len(b) - 1], h[torch.tensor(oe, device=h.device)]), -1).cpu())
    return out


engines = {"native": Engine(tok, model, Options(branch_mode="two_pass")), "rules": Engine(tok, model, Options(layout="rules_first", branch_mode="two_pass")),
           "native-varlen": Engine(tok, model, Options(branch_mode="two_pass", dense=False)), "rules-varlen": Engine(tok, model, Options(layout="rules_first", branch_mode="two_pass", dense=False)),
           "native-rows": Engine(tok, model, Options(branch_mode="rows")), "rules-rows": Engine(tok, model, Options(layout="rules_first", branch_mode="rows"))}
checks = ["native", "rules", "native-varlen", "rules-varlen", "native-rows", "rules-rows", "rules-rows-graph"] + (["native-fp8"] if "--fp8" in sys.argv else [])
for check in checks:
    if check == "native-fp8":   # last: fp8=on frees the bf16 weights; the reference answers below are computed first
        refs = {}
        for t in texts:
            rec = {"state": render({"content": {"text": t, "scene": "comment"}, "evidence": []}),
                   "questions": [{"instr": render(q["instructions"]), "options": [option_text(k, v) for k, v in q["criteria"].items()], "label": 0} for q in wire.values()]}
            refs[t] = model.probs(encode(tok, rec))
        engines["native-fp8"] = Engine(tok, model, Options(fp8="on"))
    eng = engines["rules-rows" if check == "rules-rows-graph" else check]; name = check.split("-")[0]
    step = 1 if check == "rules-rows-graph" else 16          # one request per call: the CUDA-graph path
    dps, flips, total = [], 0, 0
    for s in range(0, len(texts) if step == 16 else 16, step):
        batch = texts[s:s + step]
        if name == "native":
            reqs = [to_engine_request({"content": {"text": t, "scene": "comment"}, "evidence": []}, wire, "native", True)[0] for t in batch]
        else:
            reqs = [to_engine_request({"rules": rules, "content": {"text": t, "scene": "comment"}, "evidence": []}, wire, "rules_first", True)[0] for t in batch]
        got = eng.answer(reqs)
        for t, g in zip(batch, got):
            if check == "native-fp8":
                ref = refs[t]
            elif name == "native":
                rec = {"state": render({"content": {"text": t, "scene": "comment"}, "evidence": []}),
                       "questions": [{"instr": render(q["instructions"]), "options": [option_text(k, v) for k, v in q["criteria"].items()], "label": 0} for q in wire.values()]}
                ref = model.probs(encode(tok, rec))
            else:
                ref = kev_rows_first(t)
            for a, b in zip(ref, g):
                a, b = a.float().cpu(), b.float().cpu()
                dps.append(float((a - b).abs().max())); flips += int(a.argmax() != b.argmax()); total += 1
    for e in engines.values(): e.graphs.clear(); e.graph_pool = None
    import torch; torch.cuda.empty_cache()
    print(json.dumps({"check": check, "questions": total, "max_dp": round(max(dps), 4), "mean_dp": round(st.mean(dps), 5), "top_choice_changed": flips}), flush=True)
