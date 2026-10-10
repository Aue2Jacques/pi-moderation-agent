// Capacity page simulation (packages/console/src/capacity.ts): over a simulated day the card pool stays within bounds,
// scales ahead of the morning peak, keeps the latency target with every lever on, loses latency when the levers are off,
// reroutes after a failed card, backfills what peaks deferred, and runs the nightly jobs after midnight.
import { describe, expect, it } from "vitest";
import { MAX_CARDS, MIN_CARDS, SLO_S, failCard, newSim, savings, spike, step } from "../../packages/console/src/capacity.ts";

const run = (s: ReturnType<typeof newSim>, minutes: number, at?: (s: ReturnType<typeof newSim>) => void) => { for (let i = 0; i < minutes; i++) { at?.(s); step(s); } };

describe("capacity simulation", () => {
  it("one day with every lever on: bounded pool, latency within target, jobs done overnight, cards returned", () => {
    const s = newSim();
    run(s, 1440, (x) => { if (x.t === 19 * 60 + 30) spike(x); });
    for (const p of s.history) { expect(p.cards).toBeGreaterThanOrEqual(1); expect(p.cards).toBeLessThanOrEqual(MAX_CARDS); }
    const over = s.history.filter((p) => p.doneS > SLO_S).length;
    expect(over).toBeLessThan(10);
    expect(s.history.some((p) => p.level === 3)).toBe(true);   // the spike exceeds the whole pool
    expect(s.deferred).toBe(0);
    expect(s.backfilled).toBeGreaterThan(0);
    expect(s.jobs.every((j) => j.done >= j.need)).toBe(true);
    expect(savings(s)).toBeGreaterThan(0.2);
    expect(s.cards.filter((c) => c.state === "on").length).toBeGreaterThanOrEqual(MIN_CARDS);
  });

  it("predictive scaling adds cards before the morning peak", () => {
    const s = newSim();
    run(s, 60);   // 06:00 -> 07:00
    expect(s.events.some((e) => e.text.startsWith("预测 15 分钟后"))).toBe(true);
  });

  it("without the evidence tier the agent decides p95 (slower) and the evening needs level 2", () => {
    const on = newSim(); run(on, 1440);
    const off = newSim({ predict: true, degrade: true, evidence: false }); run(off, 1440);
    const med = (x: typeof on) => x.history.map((p) => p.doneS).sort((a, b) => a - b)[720]!;
    expect(med(off)).toBeGreaterThan(med(on) + 1.5);
    expect(off.history.some((p) => p.level >= 2)).toBe(true);
  });

  it("a failed card leaves the pool and is replaced", () => {
    const s = newSim();
    run(s, 6 * 60);   // noon
    const before = s.cards.filter((c) => c.state === "on").length;
    failCard(s);
    expect(s.cards.filter((c) => c.state === "on").length).toBe(before - 1);
    expect(s.cards.filter((c) => c.state === "failed")).toHaveLength(1);
    run(s, 10);
    expect(s.cards.filter((c) => c.state === "failed")).toHaveLength(0);
  });
});
