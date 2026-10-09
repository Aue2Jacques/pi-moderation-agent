// Dev plan 2026-10-08 R5: cost accounting. Expected values are built from independently counted physical requests and
// the unit prices below — never from spentFromLedger() or other code under test.
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import * as core from "../../packages/core/src/index.ts";
import { freshDb } from "../helpers.ts";
import { PASS_SCRIPT, makeWorker, queuedReview, resolving, runToIdle, setScript } from "./setup.ts";

// 1 micro per input token, 2 per output token for the agent model; judge priced as in the shared fixture
const PRICED: core.PriceTable = { pricesVer: "prices@cost", perMillion: { "faux/faux-1": { input: 1_000_000, output: 2_000_000 }, "jev-recorded": { input: 1_000_000, output: 0 } } };
// the documented rule (docs §7.5), applied here by hand: billable input excludes cache reads, which bill at the input rate
const priced = (u: { input: number; output: number; cacheRead?: number }): number => Math.max(0, u.input - (u.cacheRead ?? 0)) * 1 + (u.cacheRead ?? 0) * 1 + u.output * 2;

describe("R5a every physical model response is billed", () => {
  it("a retried error inside one generation task is billed too: final cost = all physical responses + tools", async () => {
    const db = freshDb();
    const r = queuedReview(db, "c1", { thread: "t1", at: Date.now() });
    const fx = await makeWorker({ db, steps: [], prices: PRICED });
    let physical = 0;
    let failedOnce = false;
    const pass = resolving(db, () => r.review_id, PASS_SCRIPT);
    const step: FauxResponseStep = (context, options, state, model) => {
      physical++;
      if (!failedOnce) {   // the first request fails transiently (Pi retries it in the same task) but still used tokens
        failedOnce = true;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" });   // the faux provider still reports tokens for it
      }
      return (pass as (...a: unknown[]) => unknown)(context, options, state, model) as ReturnType<Extract<FauxResponseStep, (...a: never[]) => unknown>>;
    };
    setScript(fx, step);
    await fx.worker.start();
    await fx.worker.admitOnce();
    await runToIdle(fx);
    const after = core.requireReview(db, r.review_id);
    expect(after.state).toBe("disposed");
    // the faux provider reports its own token counts per response; read them back per physical response
    const rows = db.prepare("SELECT stop_reason, usage FROM model_call WHERE review_id=?").all(r.review_id) as { stop_reason: string; usage: string }[];
    expect(rows.length).toBe(physical);                                          // one ledger row per physical response (counted independently)
    const failed = rows.filter((x) => x.stop_reason === "error");
    expect(failed).toHaveLength(1);
    expect(priced(JSON.parse(failed[0]!.usage))).toBeGreaterThan(0);            // the retried failure used tokens
    const models = rows.reduce((a, x) => a + priced(JSON.parse(x.usage)), 0);
    const tools = (db.prepare("SELECT COALESCE(SUM(cost_micro),0) AS s FROM tool_request WHERE review_id=? AND cost_status='settled'").get(r.review_id) as { s: number }).s;
    expect(after.used_micro).toBe(models + tools);                               // settlement includes the failed response
    await fx.close();
  }, 30_000);
});

describe("agent_stalled (test-v1 end-to-end 2026-10-09: reviews sat until the deadline after relay errors)", () => {
  it("the model keeps erroring, Pi's retries run out and the conversation stops: the review is not left investigating — the heartbeat releases it once idle for agentStallMs", async () => {
    const db = freshDb();
    const r = queuedReview(db, "st1", { thread: "t1", at: Date.now() });
    let clock = Date.now();
    const fx = await makeWorker({ db, steps: [], now: () => clock, cfg: { ...core.DEFAULT_CONFIG, agentStallMs: 1_000 } });
    setScript(fx, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "relay 502" }));
    await fx.worker.start();
    await fx.worker.admitOnce();
    await runToIdle(fx);
    expect(core.requireReview(db, r.review_id).state).toBe("investigating");        // the bug: nothing moves it any more
    await fx.worker.heartbeat();                                                     // first sight of the idle conversation
    expect(core.requireReview(db, r.review_id).state).toBe("investigating");
    clock += 1_500;
    await fx.worker.heartbeat();
    expect(core.requireReview(db, r.review_id)).toMatchObject({ state: "human_queue", release_reason: "agent_stalled" });
    expect(fx.worker.grants.count()).toBe(0);                                        // the admission slot is free again
    await fx.close();
  }, 30_000);
});
