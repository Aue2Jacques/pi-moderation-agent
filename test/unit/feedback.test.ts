// Stage ③ feedback loop: threshold proposals from human rulings (pure), recorded and decided once; nothing live changes.
import { describe, expect, it } from "vitest";
import * as core from "../../packages/core/src/index.ts";
import { freshDb } from "../helpers.ts";

const pairs = (ruleId: string, xs: [number, boolean][]): core.FeedbackPair[] => xs.map(([p, violate]) => ({ ruleId, p, violate }));

describe("proposeThresholds", () => {
  it("lowers the block line to the lowest p whose region is violating often enough, and raises the pass line likewise", () => {
    const ps = pairs("R", [
      ...Array.from({ length: 10 }, (_, k): [number, boolean] => [0.8 + k * 0.01, true]),   // 0.80..0.89: all violating
      [0.6, false], [0.7, true],
      ...Array.from({ length: 10 }, (_, k): [number, boolean] => [0.05 + k * 0.02, false]), // 0.05..0.23: all allowed
    ]);
    const out = core.proposeThresholds(ps, { R: { block: 0.9, pass: 0.1 } }, { minN: 10, target: 0.95 });
    expect(out).toHaveLength(1);
    // p >= 0.70: 11 rulings, all violating -> qualifies; p >= 0.60 adds the allowed 0.6 -> 11/12 < 0.95 -> does not
    expect(out[0]!.to.block).toBe(0.7);
    expect(out[0]!.to.pass).toBeGreaterThan(0.1);
    expect(out[0]!.evidence.atOrAboveBlock!.violateRate).toBeGreaterThanOrEqual(0.95);
  });
  it("keeps the current lines when there are too few rulings", () => {
    expect(core.proposeThresholds(pairs("R", [[0.8, true], [0.85, true]]), { R: { block: 0.9, pass: 0.1 } }, { minN: 10, target: 0.95 })).toEqual([]);
  });
  it("never proposes a block line below 0.5 or a pass line above 0.5", () => {
    const ps = pairs("R", Array.from({ length: 30 }, (_, k): [number, boolean] => [k / 30, true]));
    const out = core.proposeThresholds(ps, { R: { block: 0.9, pass: 0.1 } }, { minN: 5, target: 0.95 });
    for (const p of out) { expect(p.to.block).toBeGreaterThanOrEqual(0.5); expect(p.to.pass).toBeLessThanOrEqual(0.5); }
  });
});

describe("proposal record and decision", () => {
  it("records as proposed, decides once, refuses a second decision", () => {
    const db = freshDb();
    const id = core.recordProposal(db, "rules@x", [{ ruleId: "R", from: { block: 0.9, pass: 0.1 }, to: { block: 0.8, pass: 0.1 }, evidence: { n: 12, atOrAboveBlock: { n: 11, violateRate: 1 }, belowPass: null } }], "data/feedback/x", 1);
    expect((db.prepare("SELECT status FROM feedback_proposal WHERE proposal_id=?").get(id) as { status: string }).status).toBe("proposed");
    core.decideProposal(db, id, "rejected", "owner", "too few cases", 2);
    expect(db.prepare("SELECT status, decided_by FROM feedback_proposal WHERE proposal_id=?").get(id)).toEqual({ status: "rejected", decided_by: "owner" });
    expect(() => core.decideProposal(db, id, "approved", "owner", "changed my mind", 3)).toThrow(/already rejected/);
  });
});
