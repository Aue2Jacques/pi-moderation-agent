// Reconcile CLI (docs §11.5): instant + final checks on app.db, plus a summary of states and costs.
// usage: node --experimental-strip-types scripts/reconcile.ts [app.db]
import * as core from "../packages/core/src/index.ts";
const db = core.openAppDb(process.argv[2] ?? process.env["APP_DB"] ?? "data/app.db", "tool");
const now = Date.now();
const q = (sql: string): unknown => db.prepare(sql).all();
const instant = core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 600_000 }, now);
const final = core.reconcile.final(db);
const count = (xs: core.reconcile.Violation[]) => Object.fromEntries([...new Set(xs.map((v) => v.check))].map((c) => [c, xs.filter((v) => v.check === c).length]));
console.log(JSON.stringify({
  intake: q("SELECT status, COUNT(*) n FROM intake GROUP BY status"),
  reviews: q("SELECT trigger, state, release_reason, COUNT(*) n FROM review GROUP BY trigger, state, release_reason"),
  rulings: q("SELECT actor, action, COUNT(*) n FROM ruling GROUP BY actor, action"),
  duplicate_rulings: (db.prepare("SELECT COUNT(*) n FROM (SELECT review_id FROM ruling GROUP BY review_id HAVING COUNT(*)>1)").get() as { n: number }).n,
  outbox: q("SELECT status, COUNT(*) n FROM outbox GROUP BY status"),
  judge_calls: q("SELECT status, COUNT(*) n, ROUND(AVG(latency_ms)) avg_ms FROM judge_call GROUP BY status"),
  cost: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(used_micro),0) micro FROM review WHERE used_micro IS NOT NULL").get(),
  rejections: (db.prepare("SELECT COUNT(*) n FROM audit WHERE kind='submit_rejected'").get() as { n: number }).n,
  instant: count(instant), final: count(final), instant_sample: instant.slice(0, 5), final_sample: final.slice(0, 5),
}, null, 1));
