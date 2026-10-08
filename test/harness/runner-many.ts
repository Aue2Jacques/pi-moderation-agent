// Child-process worker for the R3 recovery-admission test: several reviews, one script that releases each to a human
// (no placeholders, so any number of reviews can run it). Env: APP_DB, SESSION_DB, WORKER_ID, ADMIT_MAX, LEASE_TTL_MS,
// KILL_AFTER_ADMIT (optional: the model never answers; after admitting everything the process SIGKILLs itself, leaving
// every session with a pending task). Prints one JSON line per milestone.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import * as core from "../../packages/core/src/index.ts";
import { CFG } from "../helpers.ts";
import { makeWorker, setScript } from "./setup.ts";

const env = (k: string, d?: string): string => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing ${k}`);
  return v;
};
const log = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o)}\n`); };
const open = (db: core.Db): number => (db.prepare("SELECT COUNT(*) AS n FROM review WHERE state IN ('queued','investigating')").get() as { n: number }).n;

const db = core.openAppDb(env("APP_DB"), "worker");
const cfg: core.Config = { ...CFG, leaseTtlMs: Number(env("LEASE_TTL_MS", "1500")) };
const storage = await openNodeSqliteStorage(env("SESSION_DB"));
const fx = await makeWorker({ db, storage, steps: [{ tool: "release", args: { reason: "evidence_gap" } }, { text: "done" }],
  workerId: env("WORKER_ID"), cfg, admitMax: Number(env("ADMIT_MAX")) });
if (process.env["KILL_AFTER_ADMIT"]) {
  setScript(fx, () => new Promise(() => {}));   // every model request hangs
  await fx.worker.start();
  log({ milestone: "admitted", admitted: await fx.worker.admitOnce() });
  process.kill(process.pid, "SIGKILL");
}
const started = await fx.worker.start();
const liveAfterStart = (await fx.worker.harness.inspect(BACKGROUND_CONTEXT)).tasks.length;
log({ milestone: "started", ...started, activeGrants: fx.worker.grants.count("active"), liveAfterStart });
let maxActive = fx.worker.grants.count("active");
for (let round = 0; round < 40 && open(db) > 0; round++) {
  await fx.worker.waitIdle();
  await fx.worker.pumpHost();
  await fx.worker.admitOnce();
  maxActive = Math.max(maxActive, fx.worker.grants.count("active"));
}
await fx.worker.waitIdle();
await fx.worker.pumpHost();
const states = db.prepare("SELECT state, COUNT(*) AS n FROM review GROUP BY state").all();
log({ milestone: "done", maxActive, open: open(db), states, grants: fx.worker.grants.count() });
await fx.close();
process.exit(0);
