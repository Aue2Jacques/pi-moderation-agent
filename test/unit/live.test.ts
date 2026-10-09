// Global live stream (packages/gateway/src/live.ts) on a fresh app.db with a fake clock: snapshot on subscribe, frames
// only on change (or heartbeat), at most one per gap, incremental `changed` without repeats, per-list counters, and the
// shared poller stopping with the last subscriber.
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { LiveHub } from "../../packages/gateway/src/live.ts";
import { listReviews } from "../../packages/gateway/src/console-api.ts";
import type { LiveFrame } from "../../packages/gateway/src/console-types.ts";
import { BUNDLE, freshDb } from "../helpers.ts";

const PINS: core.Pins = { rulesVer: BUNDLE.rulesVer, calibVer: "calib@t", evidenceVer: "evidence@t", pricesVer: "prices@t" };

function setup() {
  let clock = 1_800_000_000_000;
  const db = freshDb("gateway");
  core.storeBundle(db, BUNDLE, {}, clock);
  const hub = new LiveHub({ db, now: () => clock, pollMs: 60_000, heartbeatMs: 5_000, minGapMs: 800 });
  const frames: LiveFrame[] = [];
  const add = (id: string): string => {
    core.intakeInsert(db, { contentId: id, scene: "comment", text: "placeholder", eventTime: clock }, clock);
    return core.createSuspiciousReview(db, { contentId: id, pins: PINS, judgeModel: "j", judgeCallIds: [], pendingVisibility: "hidden", deadlineMs: 60_000, budgetTools: 12, budgetMicro: 50_000,
      direct: { reason: "evidence_gap", severity: 1, humanSlaMs: 3_600_000 } }, clock).review.review_id;
  };
  return { db, hub, frames, add, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("LiveHub", () => {
  it("sends a snapshot on subscribe, then frames only when something changed or on the heartbeat", () => {
    const s = setup();
    s.add("c-before");
    const off = s.hub.subscribe((f) => s.frames.push(f));
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]!.snapshot).toBe(true);
    expect(s.frames[0]!.changed.map((x) => x.content_id)).toEqual(["c-before"]);
    expect(s.frames[0]!.stats.contents).toBe(1);
    s.tick(1000);
    expect(s.hub.tick()).toBeDefined();   // first poll records the counters
    s.tick(1000);
    expect(s.hub.tick()).toBeUndefined();   // nothing changed
    s.tick(1000);
    const id = s.add("c-new");
    const f = s.hub.tick()!;
    expect(f.snapshot).toBe(false);
    expect(f.changed.map((x) => x.review_id)).toEqual([id]);
    expect(f.stats.contents).toBe(2);
    expect(f.stats.human.open).toBe(2);
    s.tick(1000);
    expect(s.hub.tick()).toBeUndefined();
    s.tick(5000);
    const hb = s.hub.tick()!;   // heartbeat: same counters, no repeated rows
    expect(hb.changed).toEqual([]);
    expect(hb.versions).toEqual(f.versions);
    off();
    expect(s.hub.subscribers).toBe(0);
  });

  it("at most one frame per gap; the change goes out with the next frame", () => {
    const s = setup();
    s.hub.subscribe((f) => s.frames.push(f));
    s.tick(1000); s.hub.tick();
    s.tick(100);
    s.add("c-1");
    expect(s.hub.tick()).toBeUndefined();   // within the gap
    s.tick(800);
    expect(s.hub.tick()!.changed.map((x) => x.content_id)).toEqual(["c-1"]);
  });

  it("per-list counters move with their lists; changed rows follow updates", () => {
    const s = setup();
    s.hub.subscribe((f) => s.frames.push(f));
    const id = s.add("c-h");
    s.tick(1000);
    const a = s.hub.tick()!;
    s.tick(1000);
    s.db.prepare("UPDATE human_queue SET claimed_by='rev1', claimed_at=? WHERE review_id=?").run(s.now(), id);
    const b = s.hub.tick()!;
    expect(b.versions.human).not.toBe(a.versions.human);
    expect(b.versions.reviews).toBe(a.versions.reviews);
    expect(b.changed).toEqual([]);
    s.tick(1000);
    s.db.prepare("UPDATE review SET updated_at=? WHERE review_id=?").run(s.now(), id);
    const c = s.hub.tick()!;
    expect(c.versions.reviews).not.toBe(b.versions.reviews);
    expect(c.changed.map((x) => x.review_id)).toEqual([id]);
  });

  it("several subscribers share one frame", () => {
    const s = setup();
    const a: LiveFrame[] = [], b: LiveFrame[] = [];
    s.hub.subscribe((f) => a.push(f));
    s.hub.subscribe((f) => b.push(f));
    s.tick(1000);
    s.add("c-x");
    s.hub.tick();
    expect(a.at(-1)).toBe(b.at(-1));
  });
});

describe("review list, incremental", () => {
  it("updatedSince returns reviews changed at or after the time, newest change first", () => {
    const s = setup();
    const r1 = s.add("c-a");
    s.tick(1000);
    const t = s.now();
    const r2 = s.add("c-b");
    s.tick(1000);
    s.db.prepare("UPDATE review SET updated_at=? WHERE review_id=?").run(s.now(), r1);
    expect(listReviews(s.db, { updatedSince: t, limit: 10, offset: 0 }).items.map((x) => x.review_id)).toEqual([r1, r2]);
    expect(listReviews(s.db, { updatedSince: s.now() + 1, limit: 10, offset: 0 }).items).toEqual([]);
  });
});
