"""Speed ladder through kevfast: each row turns on one more switch. Throughput at batch 32 (512 texts) and single-request
latency (batch 1, 64 texts), CUDA-synchronised wall time, after a warm-up. Answers are not checked here (layout and
question switches need a checkpoint trained on them; fp8 drift is measured by check_parity-style runs).
usage (kev venv): python -m kevfast.bench <run> <wire questions json> <texts jsonl> [n=512]"""
import json, statistics as st, sys, time

import torch

from kevfast.common import load, to_engine_request
from kevfast.engine import Engine, Options

run, wire_path, texts_path = sys.argv[1:4]
n = int(sys.argv[4]) if len(sys.argv) > 4 else 512
texts = [json.loads(l)["text"] for l, _ in zip(open(texts_path), range(n))]
wire = json.load(open(wire_path))
rules = {k: {"instructions": q["instructions"], "options": q["criteria"]} for k, q in wire.items() if "#" not in k}
short = {k: {"type": "choice", "instructions": f"按上面的规则 {k.split('#')[0]} 判断这条内容",
             "criteria": {o: {"violate": "违规", "none": "不违规", "unknown": "无法判断"}.get(o, o) for o in q["criteria"]}} for k, q in wire.items()}

LADDER = [   # each row turns on one more switch; branch_mode / cuda_graphs mostly change single-request latency
    ("E0 native layout, full questions + copies, bf16 (Kev's computation, packed, no padding)", Options(branch_mode="two_pass", cuda_graphs=False)),
    ("E1 + rules_first (rules block cached once, comment computed once)", Options(layout="rules_first", branch_mode="two_pass", cuda_graphs=False)),
    ("E2 + short questions (rule key + short labels)", Options(layout="rules_first", questions="short", branch_mode="two_pass", cuda_graphs=False)),
    ("E3 + no confirm copies", Options(layout="rules_first", questions="short", confirm=False, branch_mode="two_pass", cuda_graphs=False)),
    ("E4 + fp8 auto (FP8 only for passes >= 512 tokens)", Options(layout="rules_first", questions="short", confirm=False, fp8="auto", branch_mode="two_pass", cuda_graphs=False)),
    ("E5 + branch_mode auto (calls of <= 4 requests in one pass)", Options(layout="rules_first", questions="short", confirm=False, fp8="auto", branch_mode="auto", cuda_graphs=False)),
    ("E6 + cuda graphs for small calls, fp8 on (one copy of the weights: auto keeps bf16 + FP8 and leaves no room for graphs on 16 GB)",
     Options(layout="rules_first", questions="short", confirm=False, fp8="on", branch_mode="auto", cuda_graphs=True)),
]


def requests(opts, batch):
    out = []
    for t in batch:
        content = {"content": {"text": t, "scene": "comment"}, "evidence": []}
        if opts.layout == "rules_first": out.append(to_engine_request({"rules": rules, **content}, short, opts.layout, opts.confirm)[0])
        else: out.append(to_engine_request(content, wire, opts.layout, opts.confirm)[0])
    return out


tok, model = load(run)
results = []
only = [x for x in __import__("os").environ.get("KF_BENCH_ONLY", "").split(",") if x]   # e.g. KF_BENCH_ONLY=E6
for name, opts in LADDER:
    if only and name.split()[0] not in only: continue
    eng = Engine(tok, model, opts)
    if opts.cuda_graphs:   # what serve.py does at start-up: capture the single-request buckets before traffic
        r0 = requests(opts, texts[:1])[0]
        eng.warm_graphs(r0["prefix"], r0["questions"], max_tokens=int(__import__("os").environ.get("KF_WARM_MAX_TOKENS", 128)))
    sync = torch.cuda.synchronize
    eng.answer(requests(opts, texts[:32])); sync()
    t0 = time.time()
    for s in range(0, len(texts), 32): eng.answer(requests(opts, texts[s:s + 32]))
    sync(); thr = len(texts) / (time.time() - t0)
    lat = []
    for t in texts[:64]:
        a = time.time(); eng.answer(requests(opts, [t])); sync(); lat.append((time.time() - a) * 1000)
    r = {"stage": name, "items_per_s_batch32": round(thr, 1), "single_ms_p50": round(st.median(lat), 1), "single_ms_p95": round(sorted(lat)[int(len(lat) * .95)], 1),
         "gpu_mem_gib": round(torch.cuda.max_memory_allocated() / 2 ** 30, 2), "options": opts.describe()}
    results.append(r); print(json.dumps(r, ensure_ascii=False), flush=True)
    torch.cuda.reset_peak_memory_stats()
    del eng; torch.cuda.empty_cache()
print("BENCH_DONE")
