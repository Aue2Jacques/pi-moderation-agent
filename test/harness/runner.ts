// Child-process worker for crash tests. Env: APP_DB, SESSION_DB, WORKER_ID, LEASE_TTL_MS, CRASH_AT / CRASH_ATTEMPT (optional),
// SCENARIO (optional: abort-then-readmit).
// Prints one JSON line per milestone on stdout.
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../../packages/core/src/index.ts";
import { CFG } from "../helpers.ts";
import { PASS_SCRIPT, makeWorker, resolving, setScript } from "./setup.ts";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
};
const log = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o)}\n`); };

const db = core.openAppDb(env("APP_DB"), "worker");
const cfg: core.Config = { ...CFG, leaseTtlMs: Number(env("LEASE_TTL_MS", "2000")) };
const storage = await openNodeSqliteStorage(env("SESSION_DB"));
const reviewId = env("REVIEW_ID");
const fx = await makeWorker({ db, storage, steps: [], workerId: env("WORKER_ID"), cfg, admitMax: 1 });
setScript(fx, resolving(db, () => reviewId, PASS_SCRIPT));
const t0 = Date.now();
// heartbeat like a real W (scripts/start.sh -> worker.startLoops): without it a generation that outlasts the short test
// lease under CPU load lost its lease mid-run and the run ended differently (flaky baseline / H-02 under load)
const hb = setInterval(() => { fx.worker.heartbeat().catch(() => {}); }, Math.max(200, Math.floor(cfg.leaseTtlMs / 3)));
hb.unref();
const started = await fx.worker.start();
log({ milestone: "started", ...started, startAt: t0, resumedAt: fx.worker.resumedAt, callsBeforeResume: fx.calls.filter((c) => c.at < (fx.worker.resumedAt ?? 0)).length, elapsedMs: Date.now() - t0 });
const admitted = await fx.worker.admitOnce();
log({ milestone: "admitted", admitted });
if (env("SCENARIO", "") === "abort-then-readmit") {
  // R2: generation 1 loses its lease and is aborted (its task ends, nothing left to replay); generation 2 is admitted
  // on the same conversation — with CRASH_AT=S1 CRASH_ATTEMPT=2 the process dies after that lease, before submitting.
  core.tx(db, () => db.prepare("UPDATE review SET lease_until=? WHERE review_id=?").run(Date.now() - 1, reviewId));
  await fx.worker.heartbeat();
  log({ milestone: "aborted", state: core.readReview(db, reviewId)?.state, ruling: core.readRuling(db, reviewId)?.action ?? null });
  log({ milestone: "readmitted", admitted: await fx.worker.admitOnce() });
}
await fx.worker.waitIdle();
await fx.worker.pumpHost();
await fx.worker.waitIdle();
const r = core.readReview(db, reviewId);
log({ milestone: "done", state: r?.state, ruling: core.readRuling(db, reviewId)?.action ?? null, calls: fx.calls.map((c) => c.kind), sessions: await fx.worker.sessions(), grants: fx.worker.grants.count() });
clearInterval(hb);
await fx.close();
process.exit(0);
