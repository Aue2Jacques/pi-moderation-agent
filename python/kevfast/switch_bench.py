"""What it costs to turn a GPU from offline work into a judge and back (docs/gpu-scheduling-plan-2026-10-10.md).

Measures on the local card, each round in a fresh process, nothing else on the GPU:
- judge start: spawn `kevfast.serve` -> /v1/models answers (model load, FP8 conversion), then the first request (CUDA
  graph capture for the question set), then 30 single requests; with the page cache dropped first ("cold": weights
  read from disk) and without ("warm": weights already in host RAM);
- judge stop: SIGTERM -> process gone -> GPU memory back to idle;
- GPU memory while serving;
- CUDA context creation in a bare process;
- a LoRA training resume point of the v2s run's size, as a proxy (no training is run): adapter (bf16) + Adam moments
  (fp32 x2) saved with fsync, and loaded back to the GPU.
usage (kev venv, PYTHONPATH=<kevfast parent>): python -m kevfast.switch_bench <run dir> <wire questions json> <texts jsonl> [rounds=3]
Prints one JSON line per measurement."""

import json, os, signal, statistics as st, subprocess, sys, tempfile, time, urllib.request

PORT = 8019


def gpu_mem_mib() -> int:
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    return int(out.split()[0])


def drop_caches() -> bool:
    try:
        subprocess.run("sync; echo 3 > /proc/sys/vm/drop_caches", shell=True, check=True, capture_output=True)
        return True
    except subprocess.CalledProcessError:
        return False


def ready() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/v1/models", timeout=2) as r: return b"kevfast" in r.read()
    except Exception:
        return False


def request_body(wire: dict, text: str) -> bytes:
    rules = {k: {"instructions": q["instructions"], "options": q["criteria"]} for k, q in wire.items() if "#" not in k}
    short = {k: {"type": "choice", "instructions": f"按上面的规则 {k} 判断这条内容",
                 "criteria": {o: {"violate": "违规", "none": "不违规", "unknown": "无法判断"}.get(o, o) for o in q["criteria"]}}
             for k, q in wire.items() if "#" not in k}
    return json.dumps({"model": "kev-latest", "state": {"rules": rules, "content": {"text": text, "scene": "comment"}, "evidence": []}, "questions": short}, ensure_ascii=False).encode()


def call(body: bytes) -> float:
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/systemone", body, {"content-type": "application/json"})
    a = time.perf_counter()
    with urllib.request.urlopen(req, timeout=600) as r: r.read()
    return (time.perf_counter() - a) * 1000


def judge_round(run: str, wire: dict, texts: list, cache: str) -> dict:
    dropped = drop_caches() if cache == "cold" else False
    idle = gpu_mem_mib()
    env = {**os.environ, "KF_LAYOUT": "rules_first", "KF_QUESTIONS": "short", "KF_CONFIRM": "off", "KF_FP8": "on",
           "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
    t0 = time.perf_counter()
    p = subprocess.Popen([sys.executable, "-m", "kevfast.serve", "--run", run, "--port", str(PORT)], env=env,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    while not ready():
        if p.poll() is not None: raise RuntimeError("kevfast.serve exited during start")
        time.sleep(0.1)
    t_ready = time.perf_counter() - t0
    mem_ready = gpu_mem_mib()
    first = call(request_body(wire, texts[0]))
    lat = sorted(call(request_body(wire, t)) for t in texts[1:31])
    mem_serving = gpu_mem_mib()
    t1 = time.perf_counter()
    os.killpg(p.pid, signal.SIGTERM)
    p.wait()
    t_exit = time.perf_counter() - t1
    while gpu_mem_mib() > idle + 64: time.sleep(0.05)
    t_freed = time.perf_counter() - t1
    return {"what": "judge_start_stop", "cache": cache, "page_cache_dropped": dropped, "spawn_to_ready_s": round(t_ready, 2),
            "first_request_ms": round(first), "steady_p50_ms": round(st.median(lat)), "steady_max_ms": round(lat[-1]),
            "ready_to_serving_total_s": round(t_ready + first / 1000, 2), "gpu_mib_ready": mem_ready, "gpu_mib_serving": mem_serving,
            "sigterm_to_exit_s": round(t_exit, 2), "sigterm_to_memory_free_s": round(t_freed, 2)}


def cuda_context() -> dict:
    code = "import time;a=time.perf_counter();import torch;b=time.perf_counter();torch.zeros(1,device='cuda');torch.cuda.synchronize();c=time.perf_counter();print(round(b-a,2),round(c-b,2))"
    t0 = time.perf_counter()
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True).stdout.split()
    return {"what": "cuda_context", "import_torch_s": float(out[0]), "context_s": float(out[1]), "process_total_s": round(time.perf_counter() - t0, 2)}


def resume_point(run: str) -> dict:
    import torch
    adapter_bytes = os.path.getsize(os.path.join(run, "adapter_model.safetensors"))
    n = adapter_bytes // 2                      # bf16 LoRA parameters
    state = {"adapter": torch.randn(n, dtype=torch.bfloat16, device="cuda"),
             "adam_m": torch.randn(n, dtype=torch.float32, device="cuda"), "adam_v": torch.randn(n, dtype=torch.float32, device="cuda")}
    torch.cuda.synchronize()
    d = tempfile.mkdtemp(dir="/hy-tmp/train")
    path = os.path.join(d, "resume.pt")
    t0 = time.perf_counter()
    torch.save({k: v.cpu() for k, v in state.items()}, path)
    with open(path, "rb") as f: os.fsync(f.fileno())
    t_save = time.perf_counter() - t0
    size = os.path.getsize(path)
    del state; torch.cuda.empty_cache()
    t1 = time.perf_counter()
    back = {k: v.to("cuda") for k, v in torch.load(path).items()}
    torch.cuda.synchronize()
    t_load = time.perf_counter() - t1
    del back
    os.replace(path, path + ".done")   # left for the caller to clear; nothing else reads it
    return {"what": "lora_resume_point_proxy", "lora_params_m": round(n / 1e6, 1), "file_mb": round(size / 2**20), "save_fsync_s": round(t_save, 2), "load_to_gpu_s": round(t_load, 2), "dir": d}


def main():
    run, wire_path, texts_path = sys.argv[1:4]
    rounds = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    wire = json.load(open(wire_path))
    texts = [json.loads(l)["text"] for l, _ in zip(open(texts_path), range(40))]
    print(json.dumps(cuda_context()), flush=True)
    for cache in ("cold", "warm"):
        for _ in range(rounds): print(json.dumps(judge_round(run, wire, texts, cache)), flush=True)
    print(json.dumps(resume_point(run)), flush=True)


if __name__ == "__main__":
    main()
