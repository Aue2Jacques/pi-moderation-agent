"""HTTP load test of a running kevfast (or kev) server: the test texts as /v1/systemone requests in the rules-first
layout (the TS client's rulesFirst form; a KF_QUESTIONS=short server rewrites the questions), at a fixed client
concurrency. Prints throughput and request latency percentiles.
usage: python -m kevfast.loadtest <port> <wire questions json> <texts jsonl> <concurrency> [n=1000] [confirm=on|off]"""
import json, statistics as st, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

port, wire_path, texts_path, conc = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
n = int(sys.argv[5]) if len(sys.argv) > 5 else 1000
confirm = (sys.argv[6] if len(sys.argv) > 6 else "off") == "on"
wire = json.load(open(wire_path))
texts = [json.loads(l)["text"] for l, _ in zip(open(texts_path), range(n))]
rules = {k: {"instructions": q["instructions"], "options": q["criteria"]} for k, q in wire.items() if "#" not in k}
short = {k: {"type": "choice", "instructions": f"按上面的规则 {k.split('#')[0]} 判断这条内容",
             "criteria": {o: {"violate": "违规", "none": "不违规", "unknown": "无法判断"}.get(o, o) for o in q["criteria"]}}
         for k, q in wire.items() if confirm or "#" not in k}


def call(t):
    body = {"model": "kev-latest", "state": {"rules": rules, "content": {"text": t, "scene": "comment"}, "evidence": []}, "questions": short}
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/systemone", json.dumps(body, ensure_ascii=False).encode(), {"content-type": "application/json"})
    a = time.time()
    with urllib.request.urlopen(req, timeout=600) as r: r.read()
    return (time.time() - a) * 1000


for t in texts[:8]: call(t)                       # warm (graph capture for this question set happens on the first)
t0 = time.time()
with ThreadPoolExecutor(conc) as ex: lat = sorted(ex.map(call, texts))
wall = time.time() - t0
print(json.dumps({"concurrency": conc, "requests": len(texts), "wall_s": round(wall, 1), "req_per_s": round(len(texts) / wall, 1),
                  "p50_ms": round(st.median(lat)), "p95_ms": round(lat[int(len(lat) * .95)]), "p99_ms": round(lat[int(len(lat) * .99)])}), flush=True)
