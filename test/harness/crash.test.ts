// H-02 (B), H-03/H-23 (C), H-04 (A), H-20 (live lease wait), H-27 (barrier), H-31 (submit gaps S1/S2): SIGKILL a child worker, recover with a second one.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { queuedReview } from "./setup.ts";

const RUNNER = join(import.meta.dirname, "runner.ts");
const LEASE_TTL = 1500;

type Milestone = Record<string, unknown> & { milestone: string };

function run(env: Record<string, string>): { signal: string | null; status: number | null; milestones: Milestone[]; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", RUNNER], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
  const milestones = r.stdout.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Milestone);
  return { signal: r.signal, status: r.status, milestones, stderr: r.stderr };
}

function fresh(): { env: Record<string, string>; db: core.Db; reviewId: string } {
  const dir = mkdtempSync(join(tmpdir(), "crash-"));
  const appDb = join(dir, "app.db");
  const db = core.openAppDb(appDb, "test");
  core.ensureSchema(db);
  const r = queuedReview(db, "c1", { thread: "t1", at: Date.now() - 1000 });
  return { env: { APP_DB: appDb, SESSION_DB: join(dir, "session.sqlite"), REVIEW_ID: r.review_id, LEASE_TTL_MS: String(LEASE_TTL) }, db, reviewId: r.review_id };
}

const last = (m: Milestone[]): Milestone | undefined => m[m.length - 1];

describe("crash matrix (child process, SIGKILL)", () => {
  it("baseline: no crash → disposed pass in one process", () => {
    const { env, db, reviewId } = fresh();
    const out = run({ ...env, WORKER_ID: "w1" });
    expect(out.signal).toBeNull();
    expect(out.status).toBe(0);
    expect(last(out.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass", grants: 0 });
    expect(core.readRuling(db, reviewId)?.attempt).toBe(1);
  }, 60_000);

  it("H-02 CRASH_AT=B (after model, before T4): no ruling; recovery re-leases (attempt 2), replays dispose, exactly one ruling", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "B" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(core.readRuling(db, reviewId)).toBeUndefined();
    expect(core.readReview(db, reviewId).state).toBe("investigating");
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    const started = rec.milestones.find((m) => m.milestone === "started")!;
    expect(started["active"]).toEqual([reviewId]);
    expect(started["waitedMs"] as number).toBeGreaterThan(0);          // H-20: waited for the dead instance's lease
    expect(started["callsBeforeResume"]).toBe(0);                        // H-27: nothing external before resume
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    const rul = core.readRuling(db, reviewId)!;
    expect(rul.attempt).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    expect(core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 600_000 }, Date.now()).filter((v) => v.check !== "control_loop_stalled")).toEqual([]);
  }, 120_000);

  it("H-03 / H-23 CRASH_AT=C (after T4, before memo): ruling exists; recovery takes the finalize path, no second ruling, session settles", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "C" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(core.readRuling(db, reviewId)?.action).toBe("pass");
    expect(core.readReview(db, reviewId).state).toBe("disposed");
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    const started = rec.milestones.find((m) => m.milestone === "started")!;
    expect(started["finalize"]).toEqual([reviewId]);
    expect(started["active"]).toEqual([]);
    const done = last(rec.milestones)!;
    expect(done).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass", grants: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    expect(core.readRuling(db, reviewId)?.attempt).toBe(1);
  }, 120_000);

  it("H-04 CRASH_AT=A (before the model request): recovery continues and completes", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "A" });
    expect(crashed.signal).toBe("SIGKILL");
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
  }, 120_000);

  it("H-31a CRASH_AT=S1 (conversation bound, never submitted): recovery submits idempotently and completes once", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "S1" });
    expect(crashed.signal).toBe("SIGKILL");
    const r = core.readReview(db, reviewId);
    expect(r.conversation_id).not.toBeNull();
    expect(r.submission_id).toBeNull();
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    expect(core.readReview(db, reviewId).submission_id).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
  }, 120_000);

  it("H-31b CRASH_AT=S2 (submitted, submission_id not bound): recovery reuses the same submission via requestId", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "S2" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(core.readReview(db, reviewId).submission_id).toBeNull();
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    // one logical review: exactly one pi.user entry in the conversation is checked by the runner's session count being 0 and a single ruling
  }, 120_000);
});
