// U-03 states, U-05 ids, U-06 redact, U-12 effective, U-09 allowed (pure, no IO)
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import type { AnswerRecord } from "../../packages/core/src/index.ts";
import { ABUSE_EX_Q, ABUSE_Q, BUNDLE, IMG_Q, MKT_Q, expectCode } from "../helpers.ts";

describe("U-03 states", () => {
  it("accepts every row of §3.2 and rejects everything else", () => {
    const states: core.ReviewState[] = ["queued", "investigating", "disposed", "human_queue", "human_disposed"];
    const ok = new Set(["-|disposed", "-|queued", "-|human_queue", "queued|investigating", "investigating|investigating", "investigating|disposed", "investigating|human_queue", "investigating|queued", "human_queue|human_disposed", "queued|human_queue"]);
    for (const from of [null, ...states]) for (const to of states) {
      const key = `${from ?? "-"}|${to}`;
      expect(core.canTransition(from, to), key).toBe(ok.has(key));
    }
    expectCode(() => core.assertTransition("disposed", "queued"), "E_STATE_INVALID");
    expectCode(() => core.assertTransition("human_queue", "investigating"), "E_STATE_INVALID");
  });
});

describe("U-05 ids", () => {
  it("round-trips review ids and derives trigger_request_id", () => {
    const id = core.reviewId("coldv1:12345", "appeal", 2);
    expect(id).toBe("coldv1:12345#appeal#2");
    expect(core.parseReviewId(id)).toEqual({ contentId: "coldv1:12345", trigger: "appeal", seq: 2 });
    expect(core.parseReviewId("a#b#fast#1").contentId).toBe("a#b");
    expect(() => core.parseReviewId("nope")).toThrow();
    expect(core.defaultTriggerRequestId("fast", "c1")).toBe("c1");
    expect(core.defaultTriggerRequestId("rule_change", "c1", "rules@x")).toBe("rc:rules@x");
    expect(() => core.defaultTriggerRequestId("appeal", "c1")).toThrow();
    expect(core.canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

describe("U-06 redact", () => {
  it("replaces restricted keys recursively and keeps the rest", () => {
    const out = core.redact({ text: "原文正文", nested: { model_view: { summary: "x" }, keep: "ok" }, list: [{ body: "b" }], n: 3 }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("原文");
    expect(out["text"]).toMatch(/^\[TEXT len=4 sha=[0-9a-f]{8}\]$/);
    expect((out["nested"] as Record<string, unknown>)["keep"]).toBe("ok");
    expect(JSON.stringify(out)).not.toContain('"x"');
    expect(out["n"]).toBe(3);
  });
});

const ans = (id: string, p: number | null, set: string[], o: Partial<AnswerRecord> = {}): AnswerRecord => ({
  judgeCallId: id, questionSha: ABUSE_Q.sha, choice: p !== null && p >= 0.5 ? "violate" : "none", p, evidenceSet: set, inputSha: `in:${set.join(",")}`,
  model: "m", calibVer: "c", confirmsCallId: null, createdAt: Number(id.replace(/\D/g, "")) || 0, ...o,
});
const passOk = (a: AnswerRecord): boolean => a.p !== null && a.p < 0.1 && a.choice === "none";

describe("U-12 effective", () => {
  it("unique maximal evidence set supersedes earlier groups", () => {
    const e = core.effectiveAnswer([ans("1", 0.7, []), ans("2", 0.02, ["A"])]);
    expect(e.kind).toBe("group");
    if (e.kind === "group") expect(e.p).toBe(0.02);
  });
  it("same evidence, different choices → inconsistent", () => {
    const e = core.effectiveAnswer([ans("1", 0.7, []), ans("2", 0.02, [])]);
    expect(e.kind === "group" && e.inconsistent).toBe(true);
  });
  it("incomparable evidence paths → none", () => {
    expect(core.effectiveAnswer([ans("1", 0.7, ["A"]), ans("2", 0.02, ["B"])])).toEqual({ kind: "none", reason: "no_unique_maximal" });
    const e = core.effectiveAnswer([ans("1", 0.7, ["A"]), ans("2", 0.02, ["B"]), ans("3", 0.02, ["A", "B"])]);
    expect(e.kind === "group" && e.p).toBe(0.02);
  });
  it("uncalibrated answers are ignored", () => {
    expect(core.effectiveAnswer([ans("1", null, [])]).kind).toBe("none");
  });
  it("confirmed requires a confirming pair where both satisfy the action", () => {
    const a = ans("1", 0.02, ["A"]);
    const b = ans("2", 0.03, ["A"], { confirmsCallId: "1" });
    const g = core.effectiveAnswer([a, b]);
    expect(g.kind === "group" && core.isConfirmed(g, passOk)).toBe(true);
    // 0.20 → 0.02, same choice: first does not satisfy pass → not confirmed (H-25f)
    const g2 = core.effectiveAnswer([ans("1", 0.2, ["A"], { choice: "none" }), ans("2", 0.02, ["A"], { confirmsCallId: "1" })]);
    expect(g2.kind === "group" && core.isConfirmed(g2, passOk)).toBe(false);
    // both unknown with low p → not confirmed (H-25g)
    const g3 = core.effectiveAnswer([ans("1", 0.01, ["A"], { choice: "unknown" }), ans("2", 0.01, ["A"], { choice: "unknown", confirmsCallId: "1" })]);
    expect(g3.kind === "group" && core.isConfirmed(g3, passOk)).toBe(false);
    // different model → not a valid confirmation pair
    const g4 = core.effectiveAnswer([a, ans("2", 0.03, ["A"], { confirmsCallId: "1", model: "other" })]);
    expect(g4.kind === "group" && core.isConfirmed(g4, passOk)).toBe(false);
    // single sample per growing evidence set → never confirmed (H-25d)
    const g5 = core.effectiveAnswer([ans("1", 0.7, []), ans("2", 0.7, ["A"]), ans("3", 0.02, ["A", "B"])]);
    expect(g5.kind === "group" && core.isConfirmed(g5, passOk)).toBe(false);
  });
});

describe("U-09 allowedActions", () => {
  const mkAns = (q: typeof ABUSE_Q, id: string, p: number, choice: string, set: string[] = [], confirms?: string, at = 0): AnswerRecord => ({
    judgeCallId: id, questionSha: q.sha, choice, p, evidenceSet: set, inputSha: `in:${set.join(",")}`, model: "m", calibVer: "c", confirmsCallId: confirms ?? null, createdAt: at,
  });
  const lowPair = (q: typeof ABUSE_Q, prefix: string): AnswerRecord[] => [mkAns(q, `${prefix}a`, 0.02, "none"), mkAns(q, `${prefix}b`, 0.03, "none", [], `${prefix}a`, 1)];
  const run = (answers: AnswerRecord[], hasImages = false, scene: core.Scene = "comment") => core.allowedActions({ bundle: BUNDLE, scene, hasImages, answers });

  it("H-17a: high-risk effective answer → pass not allowed, takedown allowed when exceptions verified not_applies", () => {
    const r = run([mkAns(ABUSE_Q, "1", 0.99, "violate"), mkAns(ABUSE_EX_Q, "1", 0.01, "not_applies"), ...lowPair(MKT_Q, "m")]);
    expect(r.allowed.has("pass")).toBe(false);
    expect(r.allowed.has("takedown")).toBe(true);
  });
  it("H-17b: exception applies → rule gives no block support; set empty (only release)", () => {
    const r = run([mkAns(ABUSE_Q, "1", 0.99, "violate"), mkAns(ABUSE_EX_Q, "1", 0.9, "applies"), ...lowPair(MKT_Q, "m")]);
    expect(r.allowed.size).toBe(0);
  });
  it("exception unknown (not asked) → no block support", () => {
    const r = run([mkAns(ABUSE_Q, "1", 0.99, "violate")]);
    expect(r.allowed.has("takedown")).toBe(false);
  });
  it("H-17c: low risk confirmed on every required category → pass", () => {
    const r = run([...lowPair(ABUSE_Q, "a"), ...lowPair(MKT_Q, "m")]);
    expect([...r.allowed]).toEqual(["pass"]);
    expect(Object.keys(r.effectiveAnswers)).toContain(ABUSE_Q.sha);
  });
  it("one required category missing → no pass (incomplete coverage)", () => {
    const r = run([...lowPair(ABUSE_Q, "a")]);
    expect(r.allowed.has("pass")).toBe(false);
    expect(r.covered["MARKETING"]).toBe(false);
  });
  it("H-13: images present without image_check → no pass; text block does not need image", () => {
    const base = [...lowPair(ABUSE_Q, "a"), ...lowPair(MKT_Q, "m")];
    expect(run(base, true).allowed.has("pass")).toBe(false);
    const withImg = [...base, ...lowPair(IMG_Q, "i")];
    // round-9 item 6: an image_check answer is coverage only when the image was actually delivered to the judge
    expect(run(withImg, true).allowed.has("pass")).toBe(false);
    expect(run(withImg, true).covered["image_check"]).toBe(false);
    expect(core.allowedActions({ bundle: BUNDLE, scene: "comment", hasImages: true, imageDelivered: true, answers: withImg }).allowed.has("pass")).toBe(true);
    const block = run([mkAns(ABUSE_Q, "1", 0.99, "violate"), mkAns(ABUSE_EX_Q, "1", 0.01, "not_applies")], true);
    expect(block.allowed.has("takedown")).toBe(true);
  });
  it("suspicious band → neither", () => {
    const r = run([mkAns(ABUSE_Q, "1", 0.5, "violate"), mkAns(ABUSE_Q, "2", 0.5, "violate", [], "1", 1), ...lowPair(MKT_Q, "m")]);
    expect(r.allowed.size).toBe(0);
    expect(r.rules.find((v) => v.ruleId === "ABUSE-001")?.suspicious).toBe(true);
  });
  it("H-25: supersede then confirm; inconsistent prior group erased only by a confirmed superset", () => {
    const a = [mkAns(ABUSE_Q, "1", 0.7, "violate"), mkAns(ABUSE_Q, "2", 0.02, "none", ["A"]), mkAns(ABUSE_Q, "3", 0.03, "none", ["A"], "2", 1), ...lowPair(MKT_Q, "m")];
    expect(run(a).allowed.has("pass")).toBe(true);
    const b = [mkAns(ABUSE_Q, "1", 0.7, "violate"), mkAns(ABUSE_Q, "2", 0.02, "none"), ...lowPair(MKT_Q, "m")];
    expect(run(b).allowed.has("pass")).toBe(false);
    const c = [mkAns(ABUSE_Q, "1", 0.7, "violate"), mkAns(ABUSE_Q, "2", 0.02, "none"), mkAns(ABUSE_Q, "3", 0.02, "none", ["A"]), ...lowPair(MKT_Q, "m")];
    expect(run(c).allowed.has("pass")).toBe(false);
  });
});

describe("case-pool writers (dev plan §3)", () => {
  it("contextInsert stores content without an intake row; synthEventInsert is idempotent and takes an ingest seq", async () => {
    const { freshDb } = await import("../helpers.ts");
    const core = await import("../../packages/core/src/index.ts");
    const db = freshDb();
    expect(core.contextInsert(db, { contentId: "p1", scene: "comment", text: "parent", threadId: "t", accountId: "a", eventTime: 1 }, 2)).toEqual({ inserted: true });
    expect(core.contextInsert(db, { contentId: "p1", scene: "comment", text: "parent", eventTime: 1 }, 2)).toEqual({ inserted: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM intake WHERE content_id='p1'").get()).toEqual({ n: 0 });
    expect((db.prepare("SELECT text FROM content WHERE content_id='p1'").get() as { text: string }).text).toBe("parent");
    const e = { eventId: "e1", accountId: "a", kind: "prior_ruling" as const, payload: { action: "takedown", rule_ids: ["ABUSE-001"] }, eventTime: 5 };
    expect(core.synthEventInsert(db, e)).toEqual({ inserted: true });
    expect(core.synthEventInsert(db, e)).toEqual({ inserted: false });
    const row = db.prepare("SELECT kind, payload, ingest_seq FROM synth_event WHERE event_id='e1'").get() as { kind: string; payload: string; ingest_seq: number };
    expect(row.kind).toBe("prior_ruling");
    expect(JSON.parse(row.payload)).toEqual({ action: "takedown", rule_ids: ["ABUSE-001"] });
    expect(row.ingest_seq).toBeGreaterThan(0);
  });
});
