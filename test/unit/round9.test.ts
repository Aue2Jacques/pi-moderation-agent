// Round-9 review items, unit level: R9-05 calibration contract, R9-14 completion ≠ zero violations, R9-15 pass revoked by later doubt,
// R9-07 ledger cost, R9-12 stored bundle versions. Each test names the review item it closes.
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import type { AnswerRecord } from "../../packages/core/src/index.ts";
import * as judges from "../../packages/judges/src/index.ts";
import { ABUSE_Q, BUNDLE, CFG, MKT_Q, PINS, T0, freshDb, seedContent } from "../helpers.ts";

const rec = (q: typeof ABUSE_Q, id: string, p: number, choice: string, confirms: string | null, at: number): AnswerRecord => ({
  judgeCallId: id, questionSha: q.sha, choice, p, evidenceSet: [], inputSha: "in", model: "m", calibVer: "c", confirmsCallId: confirms, createdAt: at,
});
const lowPair = (q: typeof ABUSE_Q, prefix: string, at: number): AnswerRecord[] => [rec(q, `${prefix}a`, 0.02, "none", null, at), rec(q, `${prefix}b`, 0.03, "none", `${prefix}a`, at + 1)];

describe("R9-15 a confirmed low-risk pair is revoked by a later doubtful answer on the same evidence", () => {
  const run = (answers: AnswerRecord[]) => core.allowedActions({ bundle: BUNDLE, scene: "comment", hasImages: false, answers });
  it("pair (0.02, 0.03) then same choice at p=0.40 → pass no longer allowed", () => {
    const base = [...lowPair(ABUSE_Q, "a", 1), ...lowPair(MKT_Q, "m", 1)];
    expect(run(base).allowed.has("pass")).toBe(true);
    const doubted = [...base, rec(ABUSE_Q, "late", 0.4, "none", null, 10)];
    const r = run(doubted);
    expect(r.allowed.has("pass")).toBe(false);
    expect(r.rules.find((v) => v.ruleId === "ABUSE-001")?.suspicious).toBe(true);
  });
  it("a fresh confirmed pair after the doubt restores pass; a pair before it does not", () => {
    const base = [...lowPair(ABUSE_Q, "a", 1), ...lowPair(MKT_Q, "m", 1), rec(ABUSE_Q, "late", 0.4, "none", null, 10)];
    expect(core.allowedActions({ bundle: BUNDLE, scene: "comment", hasImages: false, answers: [...base, ...lowPair(ABUSE_Q, "z", 20)] }).allowed.has("pass")).toBe(true);
    // a confirmation that pairs with a pre-doubt answer does not count
    const straddle = [...base, rec(ABUSE_Q, "zb", 0.02, "none", "aa", 21)];
    expect(core.allowedActions({ bundle: BUNDLE, scene: "comment", hasImages: false, answers: straddle }).allowed.has("pass")).toBe(false);
  });
  it("latest answer itself must satisfy pass (a later low single answer after the pair is fine)", () => {
    const ok = [...lowPair(ABUSE_Q, "a", 1), rec(ABUSE_Q, "c", 0.05, "none", null, 5), ...lowPair(MKT_Q, "m", 1)];
    expect(core.allowedActions({ bundle: BUNDLE, scene: "comment", hasImages: false, answers: ok }).allowed.has("pass")).toBe(true);
  });
});

describe("R9-05 runtime calibration contract", () => {
  const raw = { violate: 0.08, none: 0.92 };
  const bucket = { judge: "jev-x", rulesVer: "rules@a", scene: "comment" as const, nOptions: 3 };
  it("no calib dir → calib@none, strict, every answer uncalibrated (null)", () => {
    const c = judges.loadCalibrator(join(tmpdir(), "does-not-exist"), "jev-x");
    expect(c).toMatchObject({ calibVer: "calib@none", mode: "strict" });
    expect(c.apply(bucket, raw)).toBeNull();
  });
  it("fitted file → temperature applied for its bucket only; calibVer is the content hash; changing the file changes the pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-"));
    mkdirSync(join(dir, "jev-x"));
    const file = (T: number): string => JSON.stringify({ T, n: 200, ece_before: 0.1, ece_after: 0.03, fitted_at: T0, bucket: { judge: "jev-x", rules_ver: "rules@a", scene: "comment", n_options: 3 } });
    writeFileSync(join(dir, "jev-x", "comment.json"), file(2));
    const c = judges.loadCalibrator(dir, "jev-x");
    expect(c.mode).toBe("strict");
    expect(c.calibVer).toMatch(/^calib@[0-9a-f]{12}$/);
    const out = c.apply(bucket, raw)!;
    expect(out.temperature).toBe(2);
    expect(out.probs).toEqual(judges.applyTemperature(raw, 2));
    expect(c.apply({ ...bucket, rulesVer: "rules@b" }, raw)).toBeNull();      // other rules version: not covered
    expect(c.apply({ ...bucket, nOptions: 4 }, raw)).toBeNull();               // other option count: not covered
    writeFileSync(join(dir, "jev-x", "comment.json"), file(3));
    expect(judges.loadCalibrator(dir, "jev-x").calibVer).not.toBe(c.calibVer);
    rmSync(join(dir, "jev-x", "comment.json"));
    expect(judges.loadCalibrator(dir, "jev-x").calibVer).toBe("calib@none");
  });
  it("malformed file fails loudly instead of silently passing raw probabilities", () => {
    const dir = mkdtempSync(join(tmpdir(), "calib-"));
    mkdirSync(join(dir, "jev-x"));
    writeFileSync(join(dir, "jev-x", "bad.json"), JSON.stringify({ T: -1 }));
    expect(() => judges.loadCalibrator(dir, "jev-x")).toThrow(/bad calib file/);
  });
  it("identity is explicit and labeled", () => {
    expect(judges.identityCalibrator()).toMatchObject({ calibVer: "calib@identity", mode: "identity" });
  });
});

describe("R9-14 zero violations is not completion", () => {
  it("an unexpired queued review: instant() and final() report nothing, completion() says incomplete", () => {
    const db = freshDb();
    seedContent(db, "c1");
    core.createSuspiciousReview(db, { contentId: "c1", pins: PINS, judgeModel: "jev", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: 12, budgetMicro: 50_000 }, T0);
    core.tx(db, () => db.prepare("INSERT INTO control_health(id, last_tick) VALUES (1,?)").run(T0));
    expect(core.reconcile.instant(db, { scanMs: 2000, intakeQueueMaxMs: 600_000 }, T0 + 10)).toEqual([]);
    const c = core.reconcile.completion(db);
    expect(c.complete).toBe(false);
    expect(c.reviews_open).toBe(1);
  });
  it("durable(): live tasks on a terminal review and an active grant on a non-investigating review are violations", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = core.createSuspiciousReview(db, { contentId: "c1", pins: PINS, judgeModel: "jev", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: 12, budgetMicro: 50_000 }, T0).review;
    core.tx(db, () => db.prepare("UPDATE review SET conversation_id='7', state='human_queue' WHERE review_id=?").run(r.review_id));
    const v = core.reconcile.durable(db, [{ conversationId: "7", reviewId: r.review_id, mode: "active", liveTasks: 2, submission: null }]);
    expect(v.map((x) => x.check).sort()).toEqual(["active_grant_not_investigating", "durable_live_after_terminal"]);
  });
});

describe("R9-07 cost from the ledger", () => {
  it("spentFromLedger = priced model_call + settled tool_request + reserved for unsettled", () => {
    const db = freshDb();
    seedContent(db, "c1");
    const r = core.createSuspiciousReview(db, { contentId: "c1", pins: PINS, judgeModel: "jev", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: CFG.deadlineMs, budgetTools: 12, budgetMicro: 50_000 }, T0).review;
    const prices: core.PriceTable = { pricesVer: "p", perMillion: { "relay/m1": { input: 1_000_000, output: 2_000_000 } } };
    core.recordModelCall(db, "g1", r.review_id, 1, "7", "m1", { input: 100, output: 10 }, T0);
    core.recordModelCall(db, "g1", r.review_id, 1, "7", "m1", { input: 999, output: 999 }, T0);   // replay of the same generation: ignored
    core.reserveToolSlot(db, r.review_id, 1, "call-1", "judge", 200, 12, T0);
    const n1 = core.openToolRequest(db, r.review_id, "call-1", T0);
    core.settleToolRequest(db, r.review_id, "call-1", n1, 480, null, T0);
    core.reserveToolSlot(db, r.review_id, 1, "call-2", "judge", 200, 12, T0);
    core.openToolRequest(db, r.review_id, "call-2", T0);                                           // in flight / unknown
    const sp = core.spentFromLedger(db, prices, r.review_id);
    expect(sp).toEqual({ spent: 120 + 480 + 200, settled: false, models: 120, tools: 680 });
  });
});

describe("R9-12 policy bundle versions are stored and retrievable", () => {
  it("storeBundle is idempotent per rules_ver; loadStoredBundle round-trips", () => {
    const db = freshDb();
    expect(core.storeBundle(db, BUNDLE, { "ABUSE-001": "v1 text" }, T0)).toBe(true);
    expect(core.storeBundle(db, BUNDLE, { "ABUSE-001": "other" }, T0)).toBe(false);
    const got = core.loadStoredBundle(db, BUNDLE.rulesVer)!;
    expect(got.bundle).toEqual(BUNDLE);
    expect(got.texts["ABUSE-001"]).toBe("v1 text");
    expect(core.loadStoredBundle(db, "rules@unknown")).toBeUndefined();
  });
});
