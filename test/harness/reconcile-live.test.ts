// Dev plan R6: the durable-side checks against a real worker's sessions, mid-run — a healthy worker must not trip them.
import { describe, expect, it } from "vitest";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import * as core from "../../packages/core/src/index.ts";
import { freshDb } from "../helpers.ts";
import { makeWorker, queuedReview, runToIdle, scripted, setScript } from "./setup.ts";

describe("R6 durable() on a live worker", () => {
  it("an admitted review whose model call is in flight: no violations; the same review missing from W's report is one", async () => {
    const db = freshDb();
    const r = queuedReview(db, "c1", { thread: "t1", at: Date.now() });
    const fx = await makeWorker({ db, steps: [] });
    let open!: () => void;
    const gate = new Promise<void>((ok) => { open = ok; });
    const release = scripted([{ tool: "release", args: { reason: "evidence_gap" } }, { text: "done" }]) as (...a: unknown[]) => unknown;
    setScript(fx, ((...a: unknown[]) => gate.then(() => release(...a))) as FauxResponseStep);   // the model answers once the gate opens
    await fx.worker.start();
    expect(await fx.worker.admitOnce()).toEqual([r.review_id]);
    await new Promise((ok) => setTimeout(ok, 50));
    const sessions = await fx.worker.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.liveTasks).toBeGreaterThan(0);
    expect(core.reconcile.durable(db, sessions, Date.now())).toEqual([]);
    expect(core.reconcile.durable(db, [], Date.now()).map((v) => v.check)).toEqual(["investigating_without_session"]);
    open();
    await runToIdle(fx);
    expect(core.requireReview(db, r.review_id).state).toBe("human_queue");
    expect(core.reconcile.durable(db, await fx.worker.sessions(), Date.now())).toEqual([]);
    await fx.worker.close();
  });
});
