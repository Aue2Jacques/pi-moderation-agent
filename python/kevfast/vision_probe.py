"""Can a text-trained Kev checkpoint read an image without image training? Kev keeps only Qwen3.5's language model; the
base checkpoint (Qwen3_5ForConditionalGeneration) also has a vision encoder. This probe puts the checkpoint's merged
language weights into the full multimodal base, renders comments as images, and asks Kev's questions with the image in
the state (native layout: state, then one question per pass).
  1 parity: text through the multimodal path vs kev's own DecisionModel.probs (must agree: the swap is right)
  2 text vs image: the same test texts as plain text and as rendered screenshots; AUROC against the platform labels
  3 speed: per-image latency (batch 1), image token count
usage (kev venv): python -m kevfast.vision_probe <run> <wire json> <texts jsonl with id,text> <labels dir> <font> [n=200]"""
import json, statistics as st, sys, textwrap, time
from dataclasses import replace

import torch
import torch.nn.functional as F
from PIL import Image, ImageDraw, ImageFont

run, wire_path, texts_path, labels_dir, font_path = sys.argv[1:6]
n = int(sys.argv[6]) if len(sys.argv) > 6 else 200
from kev.checkpoint import Checkpoint, LoadOptions
from kev.model import SPECIAL, encode
from kev.api import render, option_text
from transformers import AutoImageProcessor, AutoTokenizer, Qwen3_5ForConditionalGeneration

ck = Checkpoint(run)
tok, kev = ck.load("cuda", replace(LoadOptions.from_env(), dtype=torch.bfloat16, cuda_graphs=False, fused=False, backend="torch", merge=True))
kev.eval()
base = ck.meta.base
from huggingface_hub import snapshot_download
bdir = snapshot_download(base, allow_patterns=["*.json", "*.safetensors", "*.txt"])
wire = json.load(open(wire_path))
qs = {k: q for k, q in wire.items() if k in ("ABUSE-001", "MARKETING-003")}
rows = [json.loads(l) for l, _ in zip(open(texts_path), range(n))]


def state(text=None, image=False):
    c = {"text": text, "scene": "comment"} if not image else {"image": "@@IMG@@", "scene": "comment"}
    return render({"content": c, "evidence": []}).replace("@@IMG@@", IMG)


IMG = "<|vision_start|><|image_pad|><|vision_end|>"
# reference answers from kev's own, untouched path (LoRA as loaded), before anything is swapped
refs = []
for r in rows[:20]:
    rec = {"state": state(r["text"]), "questions": [{"instr": render(q["instructions"]), "options": [option_text(o, d) for o, d in q["criteria"].items()], "label": 0} for q in qs.values()]}
    refs.append([p.float().cpu() for p in kev.probs(encode(tok, rec))])
lm = kev.lm.merge_and_unload() if hasattr(kev.lm, "merge_and_unload") else kev.lm          # fold the LoRA into plain weights
sd = {k: v.to("cpu") for k, v in lm.state_dict().items()}
kev.lm = None; del lm; torch.cuda.empty_cache()
mm = Qwen3_5ForConditionalGeneration.from_pretrained(bdir, dtype=torch.bfloat16)          # CPU first: two LMs do not fit 16 GB
missing, unexpected = mm.model.language_model.load_state_dict(sd, strict=False)
print(json.dumps({"lm_swap_missing": len(missing), "unexpected": len(unexpected)}), flush=True)
if missing or unexpected: raise SystemExit(f"language weights did not map: missing {missing[:3]} unexpected {unexpected[:3]}")
del sd
mm = mm.to("cuda").eval()
improc = AutoImageProcessor.from_pretrained(bdir, use_fast=False)   # the image processor alone (the video one needs torchvision)
btok = AutoTokenizer.from_pretrained(bdir)
MERGE = getattr(improc, "merge_size", 2)


def proc(text, images=None, return_tensors="pt"):
    """What the Qwen processor does for one image: pixel values + grid, and <|image_pad|> repeated once per merged patch."""
    s = text[0]
    extra = {}
    if images:
        im = improc(images=images, return_tensors="pt")
        extra = {"pixel_values": im["pixel_values"], "image_grid_thw": im["image_grid_thw"]}
        s = s.replace("<|image_pad|>", "<|image_pad|>" * (int(im["image_grid_thw"][0].prod()) // MERGE ** 2))
    enc = btok([s], return_tensors="pt")
    enc.update(extra)
    enc["mm_token_type_ids"] = (enc["input_ids"] == btok.convert_tokens_to_ids("<|image_pad|>")).long()   # 0 text, 1 image (M-RoPE)
    return enc


def shot(text):
    from kevfast.render import shot as _shot
    return _shot(text, font_path)


@torch.no_grad()
def probs(state_text, image=None):
    """One pass per question: [<state>] state [<q>] instr [<opt>] o [</opt>]... [<decide>] through the multimodal model."""
    out = {}
    for k, q in qs.items():
        s = SPECIAL[0] + state_text + SPECIAL[1] + render(q["instructions"]) + "".join(SPECIAL[2] + option_text(o, d) + SPECIAL[3] for o, d in q["criteria"].items()) + SPECIAL[4]
        enc = proc(text=[s], images=[image] if image is not None else None, return_tensors="pt").to("cuda")
        h = mm.model(**enc).last_hidden_state[0].float()
        ids = enc["input_ids"][0].tolist()
        close = tok.convert_tokens_to_ids(SPECIAL[3])
        oe = [i for i, t in enumerate(ids) if t == close]
        p = F.softmax(kev.head(h[len(ids) - 1], h[torch.tensor(oe, device=h.device)]), -1).cpu()
        out[k] = (p, len(ids))
    return out


lab = {s: {json.loads(l)["id"]: json.loads(l)["label"] for l in open(f"{labels_dir}/labels-{s}.jsonl")} for s in ("abuse-v4.3", "marketing-v2")}
key2lab = {"ABUSE-001": "abuse-v4.3", "MARKETING-003": "marketing-v2"}

# 1 parity on 20 texts: the multimodal path (text only) against kev's untouched answers
dps = []
for r, ref in zip(rows[:20], refs):
    mine = probs(state(r["text"]))
    for (k, (p, _)), pr in zip(mine.items(), ref): dps.append(float((p - pr).abs().max()))
print(json.dumps({"parity_text_vs_kev": {"n": len(dps), "max_dp": round(max(dps), 4), "mean_dp": round(st.mean(dps), 5)}}), flush=True)


def auroc(pos, neg):
    if not pos or not neg: return None
    return round(sum((p > q) + 0.5 * (p == q) for p in pos for q in neg) / (len(pos) * len(neg)), 4)


# 2 text vs image, 3 speed
res = {k: {"text": ([], []), "image": ([], [])} for k in qs}
ref_out = open("/hy-tmp/train/vision-ref.jsonl", "w")                      # per-image answers: the reference for kevfast
agree, lat, ntok = {k: 0 for k in qs}, [], []
for r in rows:
    t = probs(state(r["text"]))
    img = shot(r["text"])
    torch.cuda.synchronize(); a = time.time()
    v = probs(state(image=True), img)
    torch.cuda.synchronize(); lat.append((time.time() - a) * 1000)
    ntok.append(v["ABUSE-001"][1])
    ref_out.write(json.dumps({"id": r["id"], **{k: v[k][0].tolist() for k in qs}}) + "\n")
    for k in qs:
        y = lab[key2lab[k]].get(r["id"])
        pt, pv = float(t[k][0][0]), float(v[k][0][0])          # option 0 = violate
        agree[k] += int(t[k][0].argmax() == v[k][0].argmax())
        if y in ("violate", "allow"):
            res[k]["text"][0 if y == "violate" else 1].append(pt); res[k]["image"][0 if y == "violate" else 1].append(pv)
summary = {k: {"violate_n": len(res[k]["text"][0]), "allow_n": len(res[k]["text"][1]), "auroc_text": auroc(*res[k]["text"]), "auroc_image": auroc(*res[k]["image"]),
               "top_choice_same_text_vs_image_pct": round(100 * agree[k] / len(rows), 1)} for k in qs}
print(json.dumps({"items": len(rows), "per_question": summary,
                  "image_ms_per_item_p50": round(st.median(lat)), "image_ms_p95": round(sorted(lat)[int(len(lat) * .95)]),
                  "tokens_per_question_pass_p50": st.median(ntok), "note": "two question passes per image, eager, bf16, unfused"}, ensure_ascii=False), flush=True)
shot(rows[0]["text"]).save("/hy-tmp/train/vision-probe-sample.png")
print("VISION_DONE")
