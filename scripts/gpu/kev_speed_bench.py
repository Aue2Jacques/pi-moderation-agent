"""Kev-4B inference optimisation ladder on one GPU: each stage adds one change and is measured the same way.
  speed  : rules-first rows (rules prefix cached once, comment + short question branches per item, proto.py layout),
           512 test texts; throughput at batch 32 and single-item latency (batch 1, 64 items); eager, no CUDA graphs
  drift  : the trained native layout (state = comment, full rule questions + confirm copies), 200 texts, answer
           probabilities against the bf16 stage-0 answers: max / mean |dp| and changed top choices
Stages: S0 bf16 (kev fused kernels) -> S1 + FP8 GEMMs (e4m3, per-row weight scales, per-token dynamic activation scales,
torch._scaled_mm) -> S2 + length bucketing (items sorted by token count before batching: less padding) -> S3 one-line
question branches (rule text only in the cached prefix) -> S4 without the confirm copies. S3/S4 change the input layout,
so they are speed only until a checkpoint is trained on them.
usage (GPU server, kev venv; PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True):
  python scripts/gpu/kev_speed_bench.py <run dir> <wire questions json> <requests-text.jsonl (ids)> <eval20k.jsonl>
wire questions json = buildQuestions(comment-scene questions, inCallConfirm) as eval-test.ts sends them (6 keys)."""
import json, sys, time, statistics as st
from dataclasses import replace
import torch, torch.nn.functional as TF
import kev.fused_qwen35 as fq
from kev.checkpoint import Checkpoint, LoadOptions, fused_available
from kev.model import user_tokens, SPECIAL, encode
from kev.api import render, option_text

run, wire_path, ids_path, eval_path = sys.argv[1:5]
ck = Checkpoint(run)
tok, model = ck.load("cuda", replace(LoadOptions.from_env(), dtype=torch.bfloat16, cuda_graphs=False, fused=fused_available(), backend="torch"))
model.eval()
wire = json.load(open(wire_path))
ids = [json.loads(l)["id"] for l in open(ids_path)][:512]
want = set(ids); texts = {}
for l in open(eval_path):
    r = json.loads(l)
    if r["id"] in want: texts[r["id"]] = r["text"]
T = [texts[i] for i in ids]
SH = {"violate": "违规", "none": "不违规", "unknown": "无法判断"}
q_id, o_id, c_id, d_id = (tok.convert_tokens_to_ids(t) for t in SPECIAL[1:])
S0_ID = tok.convert_tokens_to_ids(SPECIAL[0])
sync = torch.cuda.synchronize

# ---- rules-first rows (speed)
rules = {k: {"instructions": q["instructions"], "options": q["criteria"]} for k, q in wire.items() if "#" not in k}
P = [S0_ID] + user_tokens(tok, render({"rules": rules}) + "\n"); Ls = len(P)
branches = []
for k, q in wire.items():
    b = [q_id] + user_tokens(tok, f"按上面的规则 {k.split('#')[0]} 判断这条内容")
    for o in q["criteria"]: b += [o_id] + user_tokens(tok, SH.get(o, o)) + [c_id]
    branches += b + [d_id]
ROWS = {t: user_tokens(tok, render({"content": {"text": t, "scene": "comment"}, "evidence": []})) + branches for t in T}

def prefix():
    with torch.no_grad():
        return model.prefix({"ids": P, "pos": list(range(Ls)), "seg": [0] * Ls})[1]

@torch.no_grad()
def rf_pass(batch, cache):
    return model._rows_hidden([(ROWS[t], list(range(Ls, Ls + len(ROWS[t])))) for t in batch], cache=cache, prefix_len=Ls)

# ---- native layout (drift)
def native_rec(text):
    return {"state": render({"content": {"text": text, "scene": "comment"}, "evidence": []}),
            "questions": [{"instr": render(q["instructions"]), "options": [option_text(k, v) for k, v in q["criteria"].items()], "label": 0} for q in wire.values()]}
NAT = [encode(tok, native_rec(t)) for t in T[:200]]
def native_probs():
    return [[p.float() for p in model.probs(e)] for e in NAT]

def measure(stage, order):
    cache = prefix()
    rf_pass(order[:32], cache); sync()
    t0 = time.time(); real = padded = 0
    for s in range(0, len(order), 32):
        b = order[s:s + 32]; rf_pass(b, cache)
        L = [len(ROWS[t]) for t in b]; real += sum(L); padded += max(L) * len(L)
    sync(); thr = len(order) / (time.time() - t0)
    lat = []
    for t in T[:64]:
        a = time.time(); rf_pass([t], cache); sync(); lat.append((time.time() - a) * 1000)
    return {"stage": stage, "items_per_s_batch32": round(thr, 1), "single_ms_p50": round(st.median(lat), 1),
            "padding_waste_pct": round(100 * (1 - real / padded), 1), "tokens_per_s": round(real / (len(order) / thr))}

def drift(base, cur):
    dps, flips, n = [], 0, 0
    for pb, pc in zip(base, cur):
        for a, b in zip(pb, pc):
            dps.append(float((a - b).abs().max())); n += 1; flips += int(a.argmax() != b.argmax())
    return {"max_dp": round(max(dps), 4), "mean_dp": round(st.mean(dps), 5), "top_choice_changed": f"{flips}/{n}"}

results = []
base = native_probs()
results.append({**measure("S0 bf16 (fused kernels)", T), "drift": "reference"}); print(json.dumps(results[-1], ensure_ascii=False), flush=True)

# ---- S1: FP8 GEMMs (the bf16 weights are freed: each fused projection becomes a placeholder the F.linear shim maps to its FP8 copy)
FP8 = {}
def q8(w):
    s = (w.float().abs().amax(1, keepdim=True) / 448).clamp(min=1e-12)
    return (w.float() / s).to(torch.float8_e4m3fn), s.t().contiguous()
def fp8_linear(x, w8, sw, bias=None):
    shp = x.shape; x2 = x.reshape(-1, shp[-1])
    M = x2.shape[0]; pad = (-M) % 16
    if pad: x2 = TF.pad(x2, (0, 0, 0, pad))
    sa = (x2.abs().amax(1, keepdim=True).float() / 448).clamp(min=1e-12)
    y = torch._scaled_mm((x2 * (1 / sa).to(x2.dtype)).to(torch.float8_e4m3fn), w8.t(), scale_a=sa, scale_b=sw, out_dtype=torch.bfloat16)
    if pad: y = y[:M]
    if bias is not None: y = y + bias
    return y.reshape(*shp[:-1], -1)
class Fp8Linear(torch.nn.Module):
    def __init__(self, lin):
        super().__init__(); self.w8, self.sw = q8(lin.weight); self.bias = lin.bias
    def forward(self, x): return fp8_linear(x, self.w8, self.sw, self.bias)
class Shim:
    def __getattr__(self, k): return getattr(TF, k)
    @staticmethod
    def linear(x, w, b=None):
        e = FP8.get(id(w))
        return fp8_linear(x, *e, b) if e else TF.linear(x, w, b)
with torch.no_grad():
    for layer in model.lm.layers:
        for m in (layer.linear_attn if layer.block_type == "linear_attention" else layer.self_attn, layer.mlp):
            for name in ("in_proj", "qkv", "gate_up"):
                if hasattr(m, name):
                    e = q8(getattr(m, name)); ph = torch.empty(0, device="cuda"); setattr(m, name, ph); FP8[id(ph)] = e
            for name in ("out_proj", "o_proj", "down_proj"):
                lin = getattr(m, name, None)
                if isinstance(lin, torch.nn.Linear): setattr(m, name, Fp8Linear(lin))
torch.cuda.empty_cache()
fq.F = Shim()
results.append({**measure("S1 + FP8 GEMMs", T), "drift": drift(base, native_probs())}); print(json.dumps(results[-1], ensure_ascii=False), flush=True)

# ---- S2: length bucketing
order = sorted(T, key=lambda t: len(ROWS[t]))
results.append({**measure("S2 + length bucketing", order), "drift": "same as S1 (batching only)"}); print(json.dumps(results[-1], ensure_ascii=False), flush=True)

# ---- S3 / S4: shorter question branches (speed only: the checkpoint is not trained on them, answers not meaningful)
def short_branches(with_copies):
    out = []
    for k, q in wire.items():
        if "#" in k and not with_copies: continue
        b = [q_id]
        for o in q["criteria"]: b += [o_id] + user_tokens(tok, {"violate": "是", "none": "否"}.get(o, "不确定")) + [c_id]
        out += b + [d_id]
    return out
for stage, copies in (("S3 + one-line questions (rule text only in the cached prefix)", True), ("S4 + no confirm copies", False)):
    br = short_branches(copies)
    ROWS = {t: user_tokens(tok, render({"content": {"text": t, "scene": "comment"}, "evidence": []})) + br for t in T}
    order = sorted(T, key=lambda t: len(ROWS[t]))
    results.append({**measure(stage, order), "row_tokens_median": st.median(len(r) for r in ROWS.values()), "drift": "needs retraining"}); print(json.dumps(results[-1], ensure_ascii=False), flush=True)
print(json.dumps({"gpu": torch.cuda.get_device_name(), "rules_prefix_tokens": Ls, "fp8_weights": len(FP8)}))
print("BENCH_DONE")
