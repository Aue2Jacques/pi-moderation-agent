// H-02 (B), H-03/H-23 (C), H-04 (A), H-20 (live lease wait), H-27 (barrier), H-31 (submit gaps S1/S2), H-22 (J: tool replay count),
// H-05 (D: gateway killed between delivery and ack): SIGKILL a child process, recover with a second one.
// H-24: after every crash case, instant constraints hold, and after draining the outbox the final checks and completion hold.
// The first case is a no-crash baseline (5 worker SIGKILL cases + 1 gateway SIGKILL case + 1 baseline).
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { PRICES, queuedReview } from "./setup.ts";

const RUNNER = join(import.meta.dirname, "runner.ts");
const RUNNER_G = join(import.meta.dirname, "runner-g.ts");
const RUNNER_MANY = join(import.meta.dirname, "runner-many.ts");
const LEASE_TTL = 1500;

type Milestone = Record<string, unknown> & { milestone: string };

function run(env: Record<string, string>, runner = RUNNER): { signal: string | null; status: number | null; milestones: Milestone[]; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", runner], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000 });
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

/** H-24: instant constraints now; then drain the outbox (the dispatcher's job) and require final consistency and completion. */
function h24(db: core.Db): void {
  const at = Date.now();
  core.tx(db, () => db.prepare("INSERT INTO control_health(id, last_tick) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET last_tick=excluded.last_tick").run(at));
  expect(core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 600_000 }, at)).toEqual([]);
  core.outbox.drain(db, (ev) => void core.consumer.apply(db, ev, at), at + 3_600_000);
  expect(core.reconcile.final(db)).toEqual([]);
  expect(core.reconcile.completion(db)).toMatchObject({ reviews_open: 0, outbox_not_acked: 0 });
}

describe("crash matrix (child process, SIGKILL)", () => {
  it("baseline: no crash → disposed pass in one process", () => {
    const { env, db, reviewId } = fresh();
    const out = run({ ...env, WORKER_ID: "w1" });
    expect(out.signal).toBeNull();
    expect(out.status).toBe(0);
    expect(last(out.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass", grants: 0 });
    expect(core.readRuling(db, reviewId)?.attempt).toBe(1);
    h24(db);
  }, 60_000);

  it("H-02 CRASH_AT=B (after model, before T4): no ruling; recovery re-leases (attempt 2), replays dispose, exactly one ruling", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "B" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(core.readRuling(db, reviewId)).toBeUndefined();
    expect(core.requireReview(db, reviewId).state).toBe("investigating");
    const deadLeaseUntil = core.requireReview(db, reviewId).lease_until!;
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    const started = rec.milestones.find((m) => m.milestone === "started")!;
    expect(started["active"]).toEqual([reviewId]);
    // H-20: the recovery did not take over before the dead instance's lease ran out. (It used to assert waitedMs > 0,
    // which fails when the recovery process itself starts after the lease expired — seen under CPU load.)
    expect((started["startAt"] as number) + (started["waitedMs"] as number)).toBeGreaterThanOrEqual(deadLeaseUntil - 50);
    expect(started["callsBeforeResume"]).toBe(0);                        // H-27: nothing external before resume
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    const rul = core.readRuling(db, reviewId)!;
    expect(rul.attempt).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    h24(db);
  }, 120_000);

  it("H-03 / H-23 CRASH_AT=C (after T4, before memo): ruling exists; recovery takes the finalize path, no second ruling, session settles", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "C" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(core.readRuling(db, reviewId)?.action).toBe("pass");
    expect(core.requireReview(db, reviewId).state).toBe("disposed");
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    const started = rec.milestones.find((m) => m.milestone === "started")!;
    expect(started["finalize"]).toEqual([reviewId]);
    expect(started["active"]).toEqual([]);
    const done = last(rec.milestones)!;
    expect(done).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass", grants: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    expect(core.readRuling(db, reviewId)?.attempt).toBe(1);
    h24(db);
  }, 120_000);

  it("H-04 CRASH_AT=A (before the model request): recovery continues and completes", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "A" });
    expect(crashed.signal).toBe("SIGKILL");
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    h24(db);
  }, 120_000);

  it("H-31a CRASH_AT=S1 (conversation bound, never submitted): recovery submits idempotently and completes once", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "S1" });
    expect(crashed.signal).toBe("SIGKILL");
    const r = core.requireReview(db, reviewId);
    expect(r.conversation_id).not.toBeNull();
    expect(r.submission_id).toBeNull();
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    expect(core.requireReview(db, reviewId).submission_id).not.toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    h24(db);
  }, 120_000);

  it("H-31b CRASH_AT=S2 (submitted, submission_id not bound): recovery reuses the same submission via requestId", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "S2" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(core.requireReview(db, reviewId).submission_id).toBeNull();
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    h24(db);
  }, 120_000);

  it("R2 generation 1 aborted, generation 2 dies at S1 (leased, not submitted): recovery submits for the current generation and completes once", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", SCENARIO: "abort-then-readmit", CRASH_AT: "S1", CRASH_ATTEMPT: "2" });
    expect(crashed.signal).toBe("SIGKILL");
    expect(crashed.milestones.find((m) => m.milestone === "aborted")).toMatchObject({ state: "investigating", ruling: null });
    const before = core.requireReview(db, reviewId);
    expect(before.attempt).toBe(2);
    expect(before.submission_id).not.toBeNull();             // generation 1's submission: must not count for generation 2+
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(rec.milestones.find((m) => m.milestone === "started")!["active"]).toEqual([reviewId]);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass", grants: 0 });
    expect(core.readRuling(db, reviewId)?.attempt).toBe(3);
    expect((db.prepare("SELECT COUNT(*) AS n FROM ruling").get() as { n: number }).n).toBe(1);
    h24(db);
  }, 120_000);

  it("R3 recovery obeys the admission limit: 6 live sessions, limit 2 → at most 2 run at once (grants and actual model requests), the rest wait and all 6 finish", () => {
    const dir = mkdtempSync(join(tmpdir(), "crash-many-"));
    const appDb = join(dir, "app.db");
    const db = core.openAppDb(appDb, "test");
    core.ensureSchema(db);
    const ids = Array.from({ length: 6 }, (_, k) => queuedReview(db, `m${k}`, { thread: `t${k}`, at: Date.now() - 1000 }).review_id);
    const env = { APP_DB: appDb, SESSION_DB: join(dir, "session.sqlite"), LEASE_TTL_MS: String(LEASE_TTL) };
    const crashed = run({ ...env, WORKER_ID: "w1", ADMIT_MAX: "6", KILL_AFTER_ADMIT: "1" }, RUNNER_MANY);   // all 6 admitted, model hangs, then SIGKILL
    expect(crashed.signal).toBe("SIGKILL");
    expect((db.prepare("SELECT COUNT(*) AS n FROM review WHERE state='investigating' AND submission_id IS NOT NULL").get() as { n: number }).n).toBe(6);
    const rec = run({ ...env, WORKER_ID: "w2", ADMIT_MAX: "2" }, RUNNER_MANY);
    expect(rec.status).toBe(0);
    const started = rec.milestones.find((m) => m.milestone === "started")!;
    expect((started["active"] as string[]).length).toBeLessThanOrEqual(2);
    expect((started["deferred"] as string[]).length).toBe(6 - (started["active"] as string[]).length);
    expect(started["liveAfterStart"] as number).toBeLessThanOrEqual(2);                        // deferred sessions' resumed tasks were stopped
    // stage-1 closeout fix 3: during recovery no deferred review sent a model request, and at most the admitted ones did
    const calls = started["modelCallsByReview"] as Record<string, number>;
    for (const rid of started["deferred"] as string[]) expect(calls[rid] ?? 0, `deferred ${rid}`).toBe(0);
    expect(Object.keys(calls).length).toBeLessThanOrEqual(2);
    const done = last(rec.milestones)!;
    expect(done["maxActive"] as number).toBeLessThanOrEqual(2);
    expect(done).toMatchObject({ milestone: "done", open: 0, grants: 0 });
    expect(ids.every((id) => core.requireReview(db, id).state === "human_queue")).toBe(true);
    h24(db);
  }, 120_000);

  it("H-22 CRASH_AT=J (inside the judge tool, request opened, before the external call): recovery replays the tool — tool_slot unchanged, tool_request +1, cost stays honest", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "J" });
    expect(crashed.signal).toBe("SIGKILL");
    const judgeSlot = db.prepare("SELECT call_id FROM tool_slot WHERE review_id=? AND tool='judge'").all(reviewId) as { call_id: string }[];
    expect(judgeSlot).toHaveLength(1);
    const before = db.prepare("SELECT request_no, cost_status FROM tool_request WHERE review_id=? AND call_id=?").all(reviewId, judgeSlot[0]!.call_id);
    expect(before).toEqual([{ request_no: 1, cost_status: "inflight" }]);
    const modelCallsBefore = (db.prepare("SELECT COUNT(*) AS n FROM model_call WHERE review_id=?").get(reviewId) as { n: number }).n;
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "done", state: "disposed", ruling: "pass" });
    // the replayed tool reused the same slot (count limit unaffected) and opened a second physical request
    expect(db.prepare("SELECT call_id FROM tool_slot WHERE review_id=? AND tool='judge'").all(reviewId)).toEqual(judgeSlot);
    expect(db.prepare("SELECT request_no, cost_status FROM tool_request WHERE review_id=? AND call_id=? ORDER BY request_no").all(reviewId, judgeSlot[0]!.call_id))
      .toEqual([{ request_no: 1, cost_status: "inflight" }, { request_no: 2, cost_status: "settled" }]);
    // one model_call row per physical response (R5a); replaying the tool phase re-requests nothing, so the generation
    // that issued the judge call still has exactly one row
    const mc = db.prepare("SELECT generation_task_id, COUNT(*) AS n FROM model_call WHERE review_id=? GROUP BY generation_task_id HAVING n > 1").all(reviewId);
    expect(mc).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_call WHERE review_id=?").get(reviewId) as { n: number }).n).toBeGreaterThanOrEqual(modelCallsBefore);
    // the unknown first request is billed at its reservation and keeps the review cost 'estimated' (we cannot know if it reached the judge)
    const r = core.requireReview(db, reviewId);
    expect(r.cost_status).toBe("estimated");
    expect(r.used_micro).toBe(core.spentFromLedger(db, PRICES, reviewId).spent);
    h24(db);
  }, 120_000);

  it("R5c budget exhausted, then a crash inside the judge tool: the replayed tool sends no new request; the review goes to a human (budget_cost)", () => {
    const { env, db, reviewId } = fresh();
    const crashed = run({ ...env, WORKER_ID: "w1", CRASH_AT: "J" });
    expect(crashed.signal).toBe("SIGKILL");
    const slot = (db.prepare("SELECT call_id FROM tool_slot WHERE review_id=? AND tool='judge'").get(reviewId) as { call_id: string }).call_id;
    core.tx(db, () => db.prepare("UPDATE review SET budget_micro=1 WHERE review_id=?").run(reviewId));   // the spend so far now exceeds the budget
    const rec = run({ ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    const done = last(rec.milestones)!;
    expect((done["calls"] as string[]).filter((k) => k === "judge" || k === "confirm")).toEqual([]);   // no new external judge request
    expect(db.prepare("SELECT request_no FROM tool_request WHERE review_id=? AND call_id=?").all(reviewId, slot)).toEqual([{ request_no: 1 }]);
    expect(core.requireReview(db, reviewId)).toMatchObject({ state: "human_queue", release_reason: "budget_cost" });
    h24(db);
  }, 120_000);

  it("H-05 CRASH_AT=D (gateway killed after delivery, before ack): redelivery → receipts ≥ 2, applied once; constraints hold", () => {
    const dir = mkdtempSync(join(tmpdir(), "crash-g-"));
    const appDb = join(dir, "app.db");
    const db = core.openAppDb(appDb, "test");
    core.ensureSchema(db);
    core.intakeInsert(db, { contentId: "g1", scene: "comment", text: "plain text", eventTime: Date.now() }, Date.now());
    const crashed = run({ APP_DB: appDb, CRASH_AT: "D" }, RUNNER_G);
    expect(crashed.signal).toBe("SIGKILL");
    expect(crashed.milestones[0]).toMatchObject({ milestone: "intake", decisions: ["pass"] });
    const ev = db.prepare("SELECT event_id, status FROM outbox").all() as { event_id: string; status: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]!.status).toBe("sent");                                       // delivered, never acked
    expect((db.prepare("SELECT COUNT(*) AS n FROM delivery_receipt").get() as { n: number }).n).toBe(1);
    const rec = run({ APP_DB: appDb, NOW_OFFSET_MS: "3600000" }, RUNNER_G);  // past the retry backoff
    expect(rec.status).toBe(0);
    expect(last(rec.milestones)).toMatchObject({ milestone: "dispatched", n: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM delivery_receipt WHERE event_id=?").get(ev[0]!.event_id) as { n: number }).n).toBe(2);
    expect(db.prepare("SELECT result FROM consumer_log WHERE event_id=?").all(ev[0]!.event_id)).toEqual([{ result: "applied" }]);
    expect(db.prepare("SELECT status FROM outbox").get()).toEqual({ status: "acked" });
    expect(db.prepare("SELECT applied_action FROM downstream_state WHERE content_id='g1'").get()).toEqual({ applied_action: "pass" });
    h24(db);
  }, 120_000);
});
