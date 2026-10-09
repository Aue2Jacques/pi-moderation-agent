"""Image requests through kevfast: accuracy and speed per configuration. For each config: the rendered test texts at a
given width (smaller image -> fewer image tokens), AUROC per rule against the platform labels, image tokens per item,
single-request latency and throughput (16 per call).
usage (kev venv): python -m kevfast.vision_bench <run> <wire json> <texts jsonl> <font> <labels dir> <layout> <questions> [n=200]"""
import json, statistics as st, sys, time

import torch

from kevfast.common import load, load_vision, to_engine_request
from kevfast.engine import Engine, Options
from kevfast.render import shot

run, wire_path, texts_path, font, labels_dir, layout, questions = sys.argv[1:8]
n = int(sys.argv[8]) if len(sys.argv) > 8 else 200
wire = json.load(open(wire_path))
qs = {k: wire[k] for k in ("ABUSE-001", "MARKETING-003")}
rules = {k: {"instructions": q["instructions"], "options": q["criteria"]} for k, q in wire.items() if "#" not in k}
rows = [json.loads(l) for l, _ in zip(open(texts_path), range(n))]
lab = {k: {json.loads(l)["id"]: json.loads(l)["label"] for l in open(f"{labels_dir}/labels-{s}.jsonl")} for k, s in (("ABUSE-001", "abuse-v4.3"), ("MARKETING-003", "marketing-v2"))}
tok, model = load(run)
visual, improc = load_vision(model)
eng = Engine(tok, model, Options(layout=layout, questions=questions, confirm=False, fp8="on", branch_mode="two_pass"))
eng.attach_vision(visual, improc)


def auroc(pos, neg):
    return None if not pos or not neg else round(sum((p > q) + 0.5 * (p == q) for p in pos for q in neg) / (len(pos) * len(neg)), 4)


def reqs(imgs):
    st_ = lambda im: ({"rules": rules} if layout == "rules_first" else {}) | {"content": {"image": im, "scene": "comment"}, "evidence": []}
    return [to_engine_request(st_(im), qs, layout, False)[0] for im in imgs]


for width in (720, 480, 360):
    imgs = []
    for r in rows:
        im = shot(r["text"], font)
        if width != 720: im = im.resize((width, round(im.height * width / 720)))
        imgs.append(im)
    ntok = [int(g[0].prod()) // eng.merge ** 2 for g in [improc(images=[im], return_tensors="pt")["image_grid_thw"] for im in imgs[:50]]]
    eng.answer(reqs(imgs[:4])); torch.cuda.synchronize()
    pos = {k: ([], []) for k in qs}
    a = time.time()
    outs = []
    for s in range(0, len(imgs), 16): outs += eng.answer(reqs(imgs[s:s + 16]))
    torch.cuda.synchronize(); thr = len(imgs) / (time.time() - a)
    for r, o in zip(rows, outs):
        for k, p in zip(qs, o):
            y = lab[k].get(r["id"])
            if y in ("violate", "allow"): pos[k][0 if y == "violate" else 1].append(float(p[0]))
    lat = []
    for im in imgs[:48]:
        a = time.time(); eng.answer(reqs([im])); torch.cuda.synchronize(); lat.append((time.time() - a) * 1000)
    print(json.dumps({"layout": layout, "questions": questions, "width": width, "image_tokens_p50": st.median(ntok),
                      "auroc": {k: auroc(*pos[k]) for k in qs}, "images_per_s_16": round(thr, 1), "single_ms_p50": round(st.median(lat))}), flush=True)
print("VBENCH_DONE")
