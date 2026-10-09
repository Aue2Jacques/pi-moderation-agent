// Demo traffic generator (packages/gateway/src/demo-traffic.ts): every pool text goes the way its kind says under the
// scripted judge; the kind mix; generated ids and accounts; the real-mode refusal; and, against a real Gateway on a
// fresh app.db with a fake clock (no loops, no worker), the content stream through intake and the fast path, the
// simulated reviewer's pacing / cap / scope, and the occasional appeal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { loadBundle } from "../../packages/policy/src/index.ts";
import { Blacklist, Gateway, DEFAULT_GATEWAY_CONFIG } from "../../packages/gateway/src/index.ts";
import { DemoTraffic, SIM_PREFIX, SIM_REVIEWER, TRAFFIC_MIX, TRAFFIC_POOL, makeContent, pickKind, rng, type TrafficKind } from "../../packages/gateway/src/demo-traffic.ts";
import { intakeContent } from "../../packages/gateway/src/console-actions.ts";
import { DEMO_JUDGE_MODEL, demoCalibrator, demoJudge, demoPrices, demoScore } from "../../packages/worker/src/index.ts";
import { freshDb } from "../helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const { bundle, texts } = loadBundle(join(ROOT, "rules"), join(ROOT, "config", "scenes.yaml"));
const rule = (id: string) => bundle.rules.find((r) => r.ruleId === id)!.question;
const guard = bundle.scenes.comment.injectionGuard!.question;
const ABUSE = rule("ABUSE-001"), MKT = rule("MARKETING-003");
const view = (t: string): string => core.modelView(t);
const ctx = (parent: string) => [{ kind: "thread_context", modelView: { neighbors: [{ relation: "parent", text: parent }] } }];
const history = [{ kind: "account_history", modelView: { counts: { takedown: 2 } } }];

describe("traffic pool", () => {
  const all = Object.entries(TRAFFIC_POOL).flatMap(([k, xs]) => xs.map((x) => ({ kind: k as TrafficKind, ...x })));

  it("each text goes the way its kind says under the scripted judge", () => {
    for (const x of all) {
      const t = view(x.text);
      const where = `${x.kind}: ${x.text}`;
      const scene = bundle.scenes[x.scene ?? "comment"];
      const marketingAsked = scene.requiredCategories.includes("MARKETING");
      if (x.kind === "normal") {
        expect(demoScore(ABUSE, t, []), where).toBeLessThan(0.1);
        expect(demoScore(MKT, t, []), where).toBeLessThan(0.1);
        expect(demoScore(guard, t, []), where).toBeLessThan(0.5);
      }
      if (x.kind === "marketing") { expect(marketingAsked, where).toBe(true); expect(demoScore(MKT, t, []), where).toBeGreaterThan(0.95); expect(demoScore(guard, t, []), where).toBeLessThan(0.5); }
      if (x.kind === "abuse") { expect(demoScore(ABUSE, t, []), where).toBeGreaterThan(0.95); expect(demoScore(guard, t, []), where).toBeLessThan(0.5); }
      if (x.kind === "mild" || x.kind === "banter" || x.kind === "repeat") {
        expect(demoScore(ABUSE, t, []), where).toBe(0.55);
        expect(demoScore(MKT, t, []), where).toBeLessThan(0.1);
        expect(demoScore(guard, t, []), where).toBeLessThan(0.5);
      }
      if (x.kind === "mild") expect(x.parent, where).toBeUndefined();
      if (x.kind === "banter") expect(demoScore(ABUSE, t, ctx(x.parent!)), where).toBeLessThan(0.05);
      if (x.kind === "repeat") {
        expect(demoScore(ABUSE, t, ctx(x.parent!)), where).toBe(0.55);   // the parent alone does not settle it
        expect(demoScore(ABUSE, t, [...ctx(x.parent!), ...history]), where).toBeGreaterThan(0.95);
      }
      if (x.kind === "injection") { expect(demoScore(guard, t, []), where).toBeGreaterThan(0.9); expect(demoScore(MKT, t, []), where).toBeGreaterThan(0.95); }
    }
  });

  it("no text hits G's blacklist or the redact scan, and every scene exists", () => {
    const words = (parse(readFileSync(join(ROOT, "rules", "wordlist.yaml"), "utf8")) as { words: string[] }).words;
    const bl = new Blacklist(words);
    for (const x of all) {
      expect(bl.hits(x.text), x.text).toEqual([]);
      expect(/[一-鿿]{20,}/.test(x.text) || /[一-鿿]{20,}/.test(x.parent ?? ""), x.text).toBe(false);
      expect(Object.keys(bundle.scenes)).toContain(x.scene ?? "comment");
    }
  });

  it("kinds are drawn in the configured mix", () => {
    const next = rng(42);
    const n = 20_000;
    const seen: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const k = pickKind(next()); seen[k] = (seen[k] ?? 0) + 1; }
    const total = Object.values(TRAFFIC_MIX).reduce((a, b) => a + b, 0);
    for (const [k, w] of Object.entries(TRAFFIC_MIX)) expect(Math.abs(100 * (seen[k] ?? 0) / n - 100 * w / total), k).toBeLessThan(1.5);
    expect(TRAFFIC_MIX.normal / total).toBeGreaterThan(0.5);   // mostly ordinary content
  });

  it("generated contents: prefixed unique ids, accounts that fit the kind, parents for the context kinds", () => {
    const next = rng(7);
    const xs = Array.from({ length: 500 }, (_, i) => makeContent(next, 1_700_000_000_000 + i, i));
    expect(new Set(xs.map((x) => x.contentId)).size).toBe(500);
    for (const x of xs) {
      expect(x.contentId.startsWith(SIM_PREFIX)).toBe(true);
      expect(/^[A-Za-z0-9._:-]{1,64}$/.test(x.contentId) && /^[A-Za-z0-9._:-]{1,64}$/.test(x.accountId)).toBe(true);
      if (x.kind === "banter" || x.kind === "repeat") expect(x.parent?.text).toBeTruthy(); else expect(x.parent).toBeUndefined();
      if (x.kind === "repeat") expect(x.accountId).toMatch(/^u_sim_repeat_[1-4]$/);
    }
    const mild = xs.filter((x) => x.kind === "mild").map((x) => x.accountId);
    expect(new Set(mild).size).toBe(mild.length);   // a fresh account each time: no history to lean on
  });
});

// ---------- against a real gateway (no loops) ----------

function setup(o: { mode?: "demo" | "real"; reviewers?: string[] } = {}) {
  let clock = 1_800_000_000_000;
  const db = freshDb("gateway");
  const prices = demoPrices({ pricesVer: "prices@t", perMillion: {} });
  const calibrator = demoCalibrator(join(ROOT, "calib"), "jev-latest", bundle.rulesVer);
  const gateway = new Gateway({ db, bundle, ruleTexts: texts, judge: demoJudge({ delayMs: 0 }), prices, calibrator, evidenceVer: "evidence@t", judgeModel: DEMO_JUDGE_MODEL,
    cfg: { ...DEFAULT_GATEWAY_CONFIG, rateMaxPerMinute: 10_000 }, now: () => clock, gatewayId: "g-test" });
  const humanAuth = { token: "t", reviewers: o.reviewers ?? ["rev1", SIM_REVIEWER] };
  const deps = { db, gateway, bundle, humanAuth, now: () => clock };
  return { db, gateway, deps, humanAuth, tick: (ms: number) => { clock += ms; }, now: () => clock, mode: o.mode ?? "demo" };
}

/** A content straight into the human queue (as G's direct release would), without the fast path. */
function humanTask(s: ReturnType<typeof setup>, contentId: string): string {
  intakeContent(s.deps, { text: "就这？也太菜了吧", scene: "comment", contentId });
  const sc = bundle.scenes.comment;
  return core.createSuspiciousReview(s.db, { contentId, pins: s.gateway.pins, judgeModel: DEMO_JUDGE_MODEL, judgeCallIds: [], pendingVisibility: sc.pendingVisibility, deadlineMs: sc.deadlineMs,
    budgetTools: 12, budgetMicro: 50_000, direct: { reason: "evidence_gap", severity: 1, humanSlaMs: sc.humanSlaMs } }, s.now()).review.review_id;
}

describe("DemoTraffic", () => {
  it("refuses real mode, and needs the simulated reviewer on the reviewer list", () => {
    const s = setup();
    expect(() => new DemoTraffic({ ...s.deps, mode: "real" })).toThrow(/demo mode only/);
    const t = setup({ reviewers: ["rev1"] });
    expect(() => new DemoTraffic({ ...t.deps, mode: "demo" })).toThrow(/sim-reviewer/);
  });

  it("contents go through intake and the fast path; each kind ends on its route", async () => {
    const s = setup();
    const tr = new DemoTraffic({ ...s.deps, mode: "demo" }, { perMin: 0, seed: 3, appealPct: 0 });
    const kinds = new Map<string, TrafficKind>();
    for (let i = 0; i < 160; i++) { s.tick(250); const c = tr.contentTick(); if (c) kinds.set(c.contentId, c.kind); }
    expect(kinds.size).toBe(160);
    for (let i = 0; i < 40 && (s.db.prepare("SELECT COUNT(*) AS n FROM intake WHERE status<>'judged'").get() as { n: number }).n > 0; i++) await s.gateway.processIntakeOnce();
    const rows = s.db.prepare("SELECT r.content_id, r.trigger, r.state, r.suspect_reason, ru.action FROM review r LEFT JOIN ruling ru ON ru.review_id=r.review_id").all() as { content_id: string; trigger: string; state: string; suspect_reason: string | null; action: string | null }[];
    expect(rows).toHaveLength(160);
    const seen = new Set<TrafficKind>();
    for (const r of rows) {
      const k = kinds.get(r.content_id)!;
      seen.add(k);
      const got = r.trigger === "fast" ? `fast:${r.action}` : `${r.trigger}:${r.state}${r.suspect_reason === "injection_suspected" ? ":guard" : ""}`;
      const want: Record<TrafficKind, string> = { normal: "fast:pass", marketing: "fast:limit", abuse: "fast:takedown", mild: "suspicious:queued", banter: "suspicious:queued", repeat: "suspicious:queued", injection: "suspicious:queued:guard" };
      expect(got, `${k} ${r.content_id}`).toBe(want[k]);
    }
    expect(seen.size).toBe(7);   // 160 draws cover every kind with this seed
    expect(tr.status().generated).toBe(160);
  });

  it("paused or under backpressure: nothing is generated", () => {
    const s = setup();
    const tr = new DemoTraffic({ ...s.deps, mode: "demo" }, { perMin: 0, seed: 1 });
    tr.set({ paused: true });
    expect(tr.contentTick()).toBeUndefined();
    tr.set({ paused: false });
    s.gateway.replayPaused = true;
    expect(tr.contentTick()).toBeUndefined();
    expect(tr.status().intake_skipped).toBe(1);
    expect((s.db.prepare("SELECT COUNT(*) AS n FROM intake").get() as { n: number }).n).toBe(0);
  });

  it("the simulated reviewer waits, respects its rate and the cap, and leaves people's tasks alone", () => {
    const s = setup();
    const tr = new DemoTraffic({ ...s.deps, mode: "demo" }, { perMin: 0, seed: 1, simReviewsPerMin: 6, simMinAgeMs: 30_000, simThinkMs: 4_000, humanCap: 3 });
    const sim = [humanTask(s, `${SIM_PREFIX}a`), humanTask(s, `${SIM_PREFIX}b`)];
    const mine = humanTask(s, "c-person-1");
    const held = humanTask(s, `${SIM_PREFIX}held`);
    s.db.prepare("UPDATE human_queue SET claimed_by='rev1', claimed_at=? WHERE review_id=?").run(s.now(), held);
    const open = (): { review_id: string; claimed_by: string | null }[] => s.db.prepare("SELECT review_id, claimed_by FROM human_queue WHERE closed_at IS NULL").all() as { review_id: string; claimed_by: string | null }[];
    // young tasks and no more than the cap: nothing happens for the first 29 s
    for (let i = 0; i < 29; i++) { s.tick(1000); tr.reviewerTick(); }
    expect(open().filter((x) => x.claimed_by === SIM_REVIEWER)).toHaveLength(0);
    // old enough: the oldest is claimed, visible as claimed for the think time, then decided
    s.tick(1000); tr.reviewerTick();
    expect(open().find((x) => x.review_id === sim[0])?.claimed_by).toBe(SIM_REVIEWER);
    for (let i = 0; i < 3; i++) { s.tick(1000); tr.reviewerTick(); }
    expect(open().some((x) => x.review_id === sim[0])).toBe(true);
    s.tick(1000); tr.reviewerTick();
    expect(open().some((x) => x.review_id === sim[0])).toBe(false);
    const ruling = core.readRuling(s.db, sim[0]!)!;
    expect(ruling.actor).toBe("human");
    expect((s.db.prepare("SELECT closed_by FROM human_queue WHERE review_id=?").get(sim[0]!) as { closed_by: string }).closed_by).toBe(SIM_REVIEWER);
    // rate: the next claim is at least 10 s after the previous one
    s.tick(1000); tr.reviewerTick();
    expect(open().find((x) => x.review_id === sim[1])?.claimed_by).toBeNull();
    for (let i = 0; i < 20; i++) { s.tick(1000); tr.reviewerTick(); }
    expect(open().map((x) => x.review_id).sort()).toEqual([mine, held].sort());   // only the person's task and the one rev1 holds stay
    expect(tr.status().sim_reviewer.decided).toBe(2);
  });

  it("over the cap the simulated reviewer does not wait for the minimum age; the queue drains to the cap and stays bounded", () => {
    const s = setup();
    const tr = new DemoTraffic({ ...s.deps, mode: "demo" }, { perMin: 0, seed: 1, simReviewsPerMin: 30, simMinAgeMs: 600_000, simThinkMs: 1_000, humanCap: 3 });
    for (let i = 0; i < 10; i++) humanTask(s, `${SIM_PREFIX}q${i}`);
    const openSim = (): number => (s.db.prepare(`SELECT COUNT(*) AS n FROM human_queue h JOIN review r ON r.review_id=h.review_id WHERE h.closed_at IS NULL AND r.content_id LIKE '${SIM_PREFIX}%'`).get() as { n: number }).n;
    for (let i = 0; i < 120; i++) { s.tick(1000); tr.reviewerTick(); }
    expect(openSim()).toBe(3);   // at the cap; the rest wait for simMinAgeMs
  });

  it("appeals a recent simulated limit / takedown once", async () => {
    const s = setup();
    const tr = new DemoTraffic({ ...s.deps, mode: "demo" }, { perMin: 0, seed: 11, appealPct: 0 });
    expect(tr.appealOne()).toBeUndefined();   // nothing to appeal yet
    intakeContent(s.deps, { text: "加V领优惠券，私聊发链接", scene: "comment", contentId: `${SIM_PREFIX}m1`, accountId: "u_sim_promo_1" });
    await s.gateway.processIntakeOnce();
    const id = tr.appealOne();
    expect(id).toMatch(/appeal/);
    expect(core.readReview(s.db, id!)!.trigger).toBe("appeal");
    expect(tr.appealOne()).toBeUndefined();   // the latest review is the appeal now
    expect(tr.status().appeals).toBe(1);
  });
});
