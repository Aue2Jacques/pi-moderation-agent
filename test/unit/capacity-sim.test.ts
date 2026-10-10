// Capacity page simulation (packages/console/src/capacity.ts), own GPU pool: over a simulated day every card is always
// either judging or on offline work; the scheduler borrows offline cards ahead of the morning peak (cheapest to stop
// first, training last) and hands them back at night; the latency target holds with every lever on; a failed judge is
// replaced from the offline cards; the nightly jobs run after midnight; the switch costs add up the measured steps.
import { describe, expect, it } from "vitest";
import { CARDS, SLO_S, SWITCH, failCard, newSim, spike, step, switchSeconds } from "../../packages/console/src/capacity.ts";

const run = (s: ReturnType<typeof newSim>, minutes: number, at?: (s: ReturnType<typeof newSim>) => void) => { for (let i = 0; i < minutes; i++) { at?.(s); step(s); } };

describe("capacity simulation (own pool)", () => {
  it("switch costs are the sums of their steps (measured values)", () => {
    expect(switchSeconds("infer_to_judge")).toBeCloseTo(SWITCH.pauseInfer.s + SWITCH.free.s + SWITCH.judgeLoad.s + SWITCH.judgeWarm.s);
    expect(switchSeconds("train_to_judge")).toBeGreaterThan(switchSeconds("infer_to_judge"));
    expect(switchSeconds("train_to_judge")).toBeLessThan(60);   // a switch fits in one simulated minute
  });

  it("one day with every lever on: no idle card, peaks served, latency within target, jobs done overnight", () => {
    const s = newSim();
    let degraded = 0;
    run(s, 1440, (x) => { if (x.t === 19 * 60 + 30) spike(x); });
    for (const p of s.history) { expect(p.judges + p.offline).toBeLessThanOrEqual(CARDS); if (p.level) degraded++; }
    // every card that is not switching or failed is working
    for (const p of s.history) expect(p.judges + p.offline).toBeGreaterThanOrEqual(CARDS - 3);
    expect(s.history.filter((p) => p.doneS > SLO_S).length).toBeLessThan(5);
    expect(degraded).toBeLessThan(120);   // only around the unplanned spike on top of the evening high
    const at = (h: number) => s.history.find((p) => p.t % 1440 === h * 60)!;
    expect(at(21).judges).toBeGreaterThan(at(3).judges);   // evening: judges; night: offline work
    expect(at(3).offline).toBeGreaterThan(at(21).offline);
    expect(s.jobs.every((j) => j.done >= j.need)).toBe(true);
    expect(s.deferred).toBe(0);
  });

  it("borrows ahead of the morning peak, cheapest work first", () => {
    const s = newSim();
    run(s, 120);   // 06:00 -> 08:00
    expect(s.events.some((e) => e.text.startsWith("预测 10 分钟后"))).toBe(true);
    expect(s.events.some((e) => e.text.includes("暂停「批处理」"))).toBe(true);
    expect(s.events.some((e) => e.text.includes("暂停「训练」"))).toBe(false);
  });

  it("without the evidence tier the agent decides p95 and the day needs level 2", () => {
    const on = newSim(); run(on, 1440);
    const off = newSim({ predict: true, degrade: true, evidence: false }); run(off, 1440);
    const med = (x: typeof on) => x.history.map((p) => p.doneS).sort((a, b) => a - b)[720]!;
    expect(med(off)).toBeGreaterThan(med(on) + 1.5);
    expect(off.history.filter((p) => p.level >= 2).length).toBeGreaterThan(on.history.filter((p) => p.level >= 2).length);
  });

  it("a failed judge leaves the route and is replaced from an offline card", () => {
    const s = newSim();
    run(s, 4 * 60);   // 10:00
    const judges = s.cards.filter((c) => c.role === "judge").length;
    failCard(s);
    expect(s.cards.filter((c) => c.role === "judge").length).toBe(judges - 1);
    run(s, 2);
    expect(s.cards.filter((c) => c.role === "judge").length).toBeGreaterThanOrEqual(judges - 1);
    expect(s.events.some((e) => e.text.includes("借"))).toBe(true);
    run(s, 40);
    expect(s.cards.filter((c) => c.role === "failed")).toHaveLength(0);
  });
});
