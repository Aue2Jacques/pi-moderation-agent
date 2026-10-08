// Stage-① known gap: reconcile while W is DEAD. W is SIGKILLed after the model answered and before the ruling (CRASH_AT=B);
// the reconcile CLI reads its session store read-only (--w-offline) and must report the investigating review with its
// live task and no violation; after a second W recovers and finishes, the same check shows nothing live.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { queuedReview } from "./setup.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const node = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 60_000, cwd: ROOT });

describe("reconcile with W dead (--w-offline)", () => {
  it("lists the interrupted review with its live durable task; no violation; after recovery nothing is live", () => {
    const dir = mkdtempSync(join(tmpdir(), "offline-"));
    const appDb = join(dir, "app.db"), sessionDb = join(dir, "session.sqlite");
    const db = core.openAppDb(appDb, "test");
    core.ensureSchema(db);
    const r = queuedReview(db, "c1", { thread: "t1", at: Date.now() - 1000 });
    const env = { APP_DB: appDb, SESSION_DB: sessionDb, REVIEW_ID: r.review_id, LEASE_TTL_MS: "1500" };
    const crashed = node([join(ROOT, "test/harness/runner.ts")], { ...env, WORKER_ID: "w1", CRASH_AT: "B" });
    expect(crashed.signal).toBe("SIGKILL");
    const rec1 = node(["scripts/reconcile.ts", appDb, "--w-offline", sessionDb, "--no-final"], {});
    const out1 = JSON.parse(rec1.stdout) as { durable: Record<string, number>; durable_status: string; durable_offline_investigating: { reviewId: string; liveTasks: number }[] };
    expect(out1.durable_status).toMatch(/^offline: read \d+ tasks/);
    expect(out1.durable).toEqual({});
    expect(out1.durable_offline_investigating).toHaveLength(1);
    expect(out1.durable_offline_investigating[0]).toMatchObject({ reviewId: r.review_id });
    expect(out1.durable_offline_investigating[0]!.liveTasks).toBeGreaterThan(0);
    // a second W recovers and finishes the review; the store then holds nothing live and nothing is investigating
    const rec = node([join(ROOT, "test/harness/runner.ts")], { ...env, WORKER_ID: "w2" });
    expect(rec.status).toBe(0);
    const out2 = JSON.parse(node(["scripts/reconcile.ts", appDb, "--w-offline", sessionDb, "--no-final"], {}).stdout) as { durable: Record<string, number>; durable_offline_investigating: unknown[] };
    expect(out2.durable).toEqual({});
    expect(out2.durable_offline_investigating).toEqual([]);
  }, 120_000);
});
