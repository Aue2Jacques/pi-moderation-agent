"""kevfast's image path against the multimodal reference (vision_probe's saved answers on the same rendered images),
then speed. The engine loads the checkpoint fused (kevfast.common.load) and attaches the base's vision encoder.
usage (kev venv): python -m kevfast.check_vision <run> <wire json> <texts jsonl> <font> <reference jsonl> [n=200]"""
import json, statistics as st, sys, time

import torch

from kevfast.common import load, load_vision, to_engine_request
from kevfast.engine import Engine, Options
from kevfast.render import shot

run, wire_path, texts_path, font, ref_path = sys.argv[1:6]
n = int(sys.argv[6]) if len(sys.argv) > 6 else 200
wire = json.load(open(wire_path))
qs = {k: wire[k] for k in ("ABUSE-001", "MARKETING-003")}
rows = [json.loads(l) for l, _ in zip(open(texts_path), range(n))]
ref = {json.loads(l)["id"]: json.loads(l) for l in open(ref_path)}
tok, model = load(run)
visual, improc = load_vision(model)
imgs = {r["id"]: shot(r["text"], font) for r in rows}


def reqs_for(opts, batch):
    out = []
    for r in batch:
        er = to_engine_request({"content": {"image": imgs[r["id"]], "scene": "comment"}, "evidence": []}, qs, opts.layout, opts.confirm)[0]
        out.append(er)
    return out


eng = Engine(tok, model, Options(fp8="off", branch_mode="two_pass"))
eng.attach_vision(visual, improc)
dps, flips = [], 0
for s in range(0, len(rows), 8):
    batch = rows[s:s + 8]
    for r, got in zip(batch, eng.answer(reqs_for(eng.opts, batch))):
        for k, p in zip(qs, got):
            q = torch.tensor(ref[r["id"]][k]); p = p.float().cpu()
            dps.append(float((p - q).abs().max())); flips += int(p.argmax() != q.argmax())
print(json.dumps({"parity_image_vs_reference": {"questions": len(dps), "max_dp": round(max(dps), 4), "mean_dp": round(st.mean(dps), 5), "top_changed": flips}}), flush=True)

for name, opts in (("native bf16", Options(fp8="off", branch_mode="two_pass")), ("native fp8", Options(fp8="on", branch_mode="two_pass"))):
    e = Engine(tok, model, opts); e.attach_vision(visual, improc)
    e.answer(reqs_for(opts, rows[:4])); torch.cuda.synchronize()
    lat = []
    for r in rows[:64]:
        a = time.time(); e.answer(reqs_for(opts, [r])); torch.cuda.synchronize(); lat.append((time.time() - a) * 1000)
    a = time.time()
    for s in range(0, len(rows), 16): e.answer(reqs_for(opts, rows[s:s + 16]))
    torch.cuda.synchronize(); thr = len(rows) / (time.time() - a)
    print(json.dumps({"config": name, "single_ms_p50": round(st.median(lat)), "single_ms_p95": round(sorted(lat)[int(len(lat) * .95)]), "images_per_s_batch16": round(thr, 1)}), flush=True)
print("CHECK_VISION_DONE")
