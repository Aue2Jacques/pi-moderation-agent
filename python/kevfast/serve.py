"""kevfast HTTP server: the TypeSafe /v1/systemone protocol kev.serve speaks (so scripts/eval-test.ts and fit-calib.ts run
unchanged with JEV_BASE_URL pointing here), answered by the kevfast engine with the switches in Options (KF_* env vars).

One model thread takes everything queued (up to KF_MAX_BATCH requests sharing a prefix) and answers it as one engine call;
requests with a different prefix wait for the next call. GET /v1/models reports the switches in force, so every eval run
can record exactly which optimisations were on.
usage (kev venv): KF_LAYOUT=rules_first KF_QUESTIONS=short KF_CONFIRM=off KF_FP8=auto \\
  python -m kevfast.serve --run <checkpoint dir> --port 8010"""
from __future__ import annotations

import argparse, asyncio, queue, threading, time, uuid
from concurrent.futures import Future

from kevfast.common import load, to_engine_request
from kevfast.engine import Engine, Options


class Server:
    def __init__(self, run: str, opts: Options):
        self.run, self.opts = run, opts
        self.tok, model = load(run)
        self.engine = Engine(self.tok, model, opts)
        self.warmed: set = set()
        self.queue: queue.Queue = queue.Queue()
        self.batches = self.requests = 0
        threading.Thread(target=self._work, name="kevfast-model", daemon=True).start()

    def submit(self, req) -> Future:
        er, meta, keep = to_engine_request(req.state, {k: q.model_dump() for k, q in req.questions.items()}, self.opts.layout, self.opts.confirm)
        f: Future = Future()
        self.queue.put((er, meta, f))
        return f

    def _warm(self, er):
        """First request with a new (prefix, question set): capture its single-request graphs (KF_WARM_GRAPHS=off to skip)."""
        key = (er["prefix"], tuple(q["key"] + "|" + "|".join(q["names"]) for q in er["questions"]))
        if key in self.warmed or not self.opts.cuda_graphs or __import__("os").environ.get("KF_WARM_GRAPHS", "on") == "off": return
        self.warmed.add(key)
        self.engine.warm_graphs(er["prefix"], er["questions"])

    def _work(self):
        held = None
        while True:
            first = held or self.queue.get()
            held = None
            batch = [first]
            while len(batch) < self.opts.max_batch:
                try: nxt = self.queue.get_nowait()
                except queue.Empty: break
                if nxt[0]["prefix"] != first[0]["prefix"]: held = nxt; break
                batch.append(nxt)
            self._warm(first[0])
            t0 = time.perf_counter()
            try:
                ps = self.engine.answer([b[0] for b in batch])
                ms = (time.perf_counter() - t0) * 1000
                for (er, meta, f), p in zip(batch, ps): f.set_result((p, meta, ms))
            except Exception as e:   # every request of the batch gets the error; the thread lives on
                for _, _, f in batch: f.set_exception(e)
            self.batches += 1; self.requests += len(batch)


def make_app(server: Server):
    from fastapi import FastAPI, Request
    from kev.api import SystemOneRequest, output_tokens, to_answers
    app = FastAPI(title="kevfast")

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        resp = await call_next(request)
        resp.headers["x-typesafe-request-id"] = request.headers.get("x-typesafe-request-id") or uuid.uuid4().hex
        return resp

    @app.post("/v1/systemone")
    async def systemone(req: SystemOneRequest):
        p, meta, ms = await asyncio.wrap_future(server.submit(req))
        answers = to_answers([x.tolist() for x in p], meta)
        return {"model": req.model, "answers": answers, "usage": {"input_tokens": 0, "output_tokens": output_tokens(server.tok, answers)}, "latency_ms": round(ms, 1)}

    @app.get("/v1/models")
    def models():
        card = {"description": f"kevfast serving {server.run}", "run": server.run, "kevfast": server.opts.describe(),
                "batches": {"count": server.batches, "requests": server.requests, "queued": server.queue.qsize()}}
        return {"models": [{"name": "kev-latest", **card}]}

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8010)
    a = ap.parse_args()
    opts = Options.from_env()
    server = Server(a.run, opts)
    print(f"kevfast serving {a.run} on {a.host}:{a.port} with {opts.describe()}", flush=True)
    import uvicorn
    uvicorn.run(make_app(server), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
