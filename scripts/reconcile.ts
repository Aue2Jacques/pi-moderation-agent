// Reconcile CLI (docs §11.5, round-9 item 14). A gate, not just a report:
//   instant + final checks on app.db, completion counts (what is still pending), and — when W is reachable — the
//   durable-side checks from W's /sessions (with --w / W_URL; an unreachable W then fails the gate). Exit 0 only when there
//   are no violations AND everything accepted has finished
//   (open human-queue items are allowed: they wait for a person by design; pass --require-human-closed to forbid them).
//   W dead: --w-offline <session.sqlite> reads W's session store read-only (tasks, submissions) instead of /sessions.
// usage: node --experimental-strip-types scripts/reconcile.ts [app.db] [--w http://127.0.0.1:8081 | --w-offline data/session.sqlite] [--require-human-closed] [--no-final]
import { DatabaseSync } from "node:sqlite";
import * as core from "../packages/core/src/index.ts";

const args = process.argv.slice(2);
const flag = (k: string): boolean => args.includes(k);
const opt = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]!.startsWith("--"))) ?? process.env["APP_DB"] ?? "data/app.db";
const wUrl = opt("--w") ?? process.env["W_URL"];
const wOffline = opt("--w-offline");

const db = core.openAppDb(dbPath, "tool");
const now = Date.now();
const q = (sql: string): unknown => db.prepare(sql).all();
const instant = core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 600_000 }, now);
const final = flag("--no-final") ? [] : core.reconcile.final(db);
const completion = core.reconcile.completion(db);

let durable: core.reconcile.Violation[] = [];
let durableStatus = "skipped (no --w / W_URL): app.db checks only";
let durableFailed = false;   // dev plan R6: when the durable side was asked for, not getting it fails the gate
if (wUrl) {
  try {
    const res = await fetch(`${wUrl}/sessions`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const sessions = (await res.json()) as core.reconcile.SessionLike[];
    durable = core.reconcile.durable(db, sessions, Date.now());
    durableStatus = `checked ${sessions.length} sessions`;
  } catch (e) {
    durableStatus = `W unreachable: ${(e as Error).message}`;
    durableFailed = true;
  }
}

let offline: core.reconcile.OfflineDurable | undefined;
if (wOffline) {
  // read-only: opening a harness on this store could resume its tasks; only its tables are read
  try {
    const sdb = new DatabaseSync(wOffline, { readOnly: true });
    const tasks = (sdb.prepare("SELECT conversation_id, status FROM tasks").all() as { conversation_id: number; status: string }[]).map((t) => ({ conversationId: String(t.conversation_id), status: t.status }));
    const subs = (sdb.prepare("SELECT conversation_id, status FROM submissions").all() as { conversation_id: number; status: string }[]).map((t) => ({ conversationId: String(t.conversation_id), status: t.status }));
    sdb.close();
    offline = core.reconcile.durableOffline(db, tasks, subs, Date.now());
    durable = offline.violations;
    durableStatus = `offline: read ${tasks.length} tasks, ${subs.length} submissions from ${wOffline}`;
  } catch (e) {
    durableStatus = `W session store unreadable: ${(e as Error).message}`;
    durableFailed = true;
  }
}

const count = (xs: core.reconcile.Violation[]) => Object.fromEntries([...new Set(xs.map((v) => v.check))].map((c) => [c, xs.filter((v) => v.check === c).length]));
const incomplete: string[] = [];
if (completion.intake_not_judged) incomplete.push(`intake_not_judged=${completion.intake_not_judged}`);
if (completion.reviews_open) incomplete.push(`reviews_open=${completion.reviews_open}`);
if (completion.outbox_not_acked) incomplete.push(`outbox_not_acked=${completion.outbox_not_acked}`);
if (flag("--require-human-closed") && completion.human_open) incomplete.push(`human_open=${completion.human_open}`);
const ok = instant.length === 0 && final.length === 0 && durable.length === 0 && !durableFailed && incomplete.length === 0;

console.log(JSON.stringify({
  ok,
  incomplete,
  completion,
  intake: q("SELECT status, COUNT(*) n FROM intake GROUP BY status"),
  reviews: q("SELECT trigger, state, release_reason, COUNT(*) n FROM review GROUP BY trigger, state, release_reason"),
  rulings: q("SELECT actor, action, COUNT(*) n FROM ruling GROUP BY actor, action"),
  duplicate_rulings: (db.prepare("SELECT COUNT(*) n FROM (SELECT review_id FROM ruling GROUP BY review_id HAVING COUNT(*)>1)").get() as { n: number }).n,
  outbox: q("SELECT status, COUNT(*) n FROM outbox GROUP BY status"),
  judge_calls: q("SELECT status, COUNT(*) n, ROUND(AVG(latency_ms)) avg_ms FROM judge_call GROUP BY status"),
  calib: q("SELECT calib_ver, COUNT(*) n FROM review GROUP BY calib_ver"),
  cost: {
    // fast-path judge calls have attempt NULL (they get a review_id when the ruling is written; dev plan R5b)
    fast_judge_micro: (db.prepare("SELECT COALESCE(SUM(cost_micro),0) n FROM judge_call WHERE attempt IS NULL").get() as { n: number }).n,
    reviews: db.prepare("SELECT cost_status, COUNT(*) n, COALESCE(SUM(used_micro),0) micro FROM review WHERE used_micro IS NOT NULL GROUP BY cost_status").all(),
    reviews_without_cost: (db.prepare("SELECT COUNT(*) n FROM review WHERE trigger<>'fast' AND state IN ('disposed','human_queue','human_disposed') AND used_micro IS NULL AND conversation_id IS NOT NULL").get() as { n: number }).n,
  },
  rejections: (db.prepare("SELECT COUNT(*) n FROM audit WHERE kind='submit_rejected'").get() as { n: number }).n,
  instant: count(instant), final: count(final), durable: count(durable), durable_status: durableStatus, ...(offline ? { durable_offline_investigating: offline.investigating } : {}),
  instant_sample: instant.slice(0, 5), final_sample: final.slice(0, 5), durable_sample: durable.slice(0, 5),
}, null, 1));
process.exit(ok ? 0 : 1);
