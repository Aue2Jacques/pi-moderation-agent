# Kaggle kernel (T4): zero-shot Kev on the COLD dev and test splits with the SAME questions we gave Jev and Laya
# (rules/prompts/jev-variants.yaml: A_choice + C_bool). T4 has no bf16, Kev defaults to bf16 and 4B in fp32 does not fit
# one T4, so we try in order: kev-4b fp16 → kev-4b bf16 → kev-0.8b fp32, and log which one served.
# Output: /kaggle/working/kev-<split>.jsonl with ids + labels + raw answers (no text), and kev-run.json (config used).
import json, os, subprocess, sys, time, urllib.request, csv
from concurrent.futures import ThreadPoolExecutor

def sh(cmd, check=True):
    print("+", cmd, flush=True)
    return subprocess.run(cmd, shell=True, check=check)

sh(f"{sys.executable} -m pip install -q uv pyyaml")
sh("git clone -q --depth 1 https://github.com/thu-coai/COLDataset.git /kaggle/temp/cold || true")
sh("git clone -q --depth 1 https://github.com/jaredpalmer/kev.git /kaggle/temp/kev")
sh("cd /kaggle/temp/kev && uv sync -q --extra serve")
sh("cd /kaggle/temp/kev && uv pip install -q flash-linear-attention || true", check=False)

import yaml
spec = yaml.safe_load(urllib.request.urlopen("https://raw.githubusercontent.com/Aue2Jacques/pi-moderation-agent/main/rules/prompts/jev-variants.yaml").read().decode("utf-8"))["variants"]
def to_kev(qs):
    out = {}
    for k, q in qs.items():
        out[k] = {"type": "noul", "instructions": q["instructions"]} if q["type"] == "bool" else {"type": q["type"], "instructions": q["instructions"], "criteria": q["criteria"]}
    return out
questions = {**to_kev(spec["A_choice"]), **to_kev(spec["C_bool"])}

def post(body, timeout=120):
    req = urllib.request.Request("http://127.0.0.1:8009/v1/systemone", data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read().decode())

def start(run, dtype):
    env = dict(os.environ, KEV_DTYPE=dtype)
    log = open(f"/kaggle/working/kev-serve-{run.split('/')[-1]}-{dtype}.log", "w")
    p = subprocess.Popen(f"cd /kaggle/temp/kev && uv run --extra serve python -m kev.serve --run {run} --port 8009", shell=True, env=env, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(180):                      # up to 15 min for download + load
        time.sleep(5)
        if p.poll() is not None:
            return None
        try:
            r = post({"state": "测试", "model": "kev-latest", "questions": {"q": {"type": "noul", "instructions": "这是测试吗？"}}}, timeout=60)
            if "answers" in r or "nouls" in r or r:
                return p
        except Exception:
            pass
    p.kill()
    return None

served = None
for run, dtype in (("jaredpalmer/kev-4b", "fp16"), ("jaredpalmer/kev-4b", "bf16"), ("jaredpalmer/kev-0.8b", "fp32")):
    t0 = time.time()
    p = start(run, dtype)
    print(json.dumps({"try": run, "dtype": dtype, "ok": p is not None, "s": round(time.time() - t0)}), flush=True)
    if p is not None:
        served = (run, dtype, p)
        break
if not served:
    print("NO_CONFIG_WORKED"); sys.exit(1)
run, dtype, proc = served
json.dump({"run": run, "dtype": dtype}, open("/kaggle/working/kev-run.json", "w"))

for split in ("dev", "test"):
    rows = list(csv.DictReader(open(f"/kaggle/temp/cold/COLDataset/{split}.csv", encoding="utf-8-sig")))
    def one(i):
        r = rows[i]
        body = {"state": {"content": {"text": r["TEXT"], "scene": "comment"}}, "model": "kev-latest", "questions": questions}
        for a in range(3):
            try:
                return i, post(body)
            except Exception as e:
                err = str(e)[:80]; time.sleep(2 * (a + 1))
        return i, {"error": err}
    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        res = dict(ex.map(one, range(len(rows))))
    dt = time.time() - t0
    with open(f"/kaggle/working/kev-{split}.jsonl", "w", encoding="utf-8") as f:
        for i, r in enumerate(rows):
            fine = r.get("fine-grained-label")
            f.write(json.dumps({"i": i, "label": int(r["label"]), "fine": int(fine) if fine not in (None, "") else None, "answers": res[i].get("answers", res[i])}, ensure_ascii=False) + "\n")
    print(json.dumps({"split": split, "rows": len(rows), "seconds": round(dt, 1), "per_item_ms": round(1000 * dt / len(rows), 1), "errors": sum(1 for v in res.values() if "error" in v)}), flush=True)
proc.kill()
# small files survive flaky downloads better
sh("cd /kaggle/working && gzip -f kev-dev.jsonl kev-test.jsonl")
print("DONE")
