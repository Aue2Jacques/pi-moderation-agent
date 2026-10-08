// Stage ③ feedback loop (dev plan 2026-10-08 §5): human rulings become threshold proposals; a proposal is a candidate
// config that must be checked and approved, and an approved one still goes through the release path. Nothing here
// changes a live threshold.
import { tx, type Db } from "./db.ts";
import { uuid } from "./ids.ts";

export type FeedbackPair = { ruleId: string; p: number; violate: boolean };
export type ThresholdProposal = { ruleId: string; from: { block: number; pass: number }; to: { block: number; pass: number };
  evidence: { n: number; atOrAboveBlock: { n: number; violateRate: number } | null; belowPass: { n: number; allowRate: number } | null } };

/**
 * Per rule: the lowest block line whose region (p >= line) holds at least minN human rulings with a violation rate >=
 * target, and the highest pass line whose region (p < line) holds at least minN with an allow rate >= target. Lines are
 * kept inside [0.5, 0.99] (block) and up to 0.5 (pass); a rule without enough rulings keeps its current lines.
 * Only rules whose lines move by at least 0.01 are returned.
 */
export function proposeThresholds(pairs: readonly FeedbackPair[], current: Record<string, { block: number; pass: number }>, o: { minN: number; target: number }): ThresholdProposal[] {
  const out: ThresholdProposal[] = [];
  for (const [ruleId, cur] of Object.entries(current)) {
    const ps = pairs.filter((x) => x.ruleId === ruleId);
    const values = [...new Set(ps.map((x) => x.p))].sort((a, b) => a - b);
    let block = cur.block, blockEv: ThresholdProposal["evidence"]["atOrAboveBlock"] = null;
    for (const t of values.filter((v) => v >= 0.5 && v <= 0.99)) {   // ascending: the first that qualifies is the lowest
      const reg = ps.filter((x) => x.p >= t);
      const rate = reg.filter((x) => x.violate).length / Math.max(1, reg.length);
      if (reg.length >= o.minN && rate >= o.target) { block = Math.round(t * 100) / 100; blockEv = { n: reg.length, violateRate: rate }; break; }
    }
    let pass = cur.pass, passEv: ThresholdProposal["evidence"]["belowPass"] = null;
    for (const v of values.filter((x) => x < 0.5).reverse()) {   // descending: the first that qualifies is the highest
      // the pass rule is p < line: a region "p <= v" becomes the line v + 0.01
      const reg = ps.filter((x) => x.p <= v);
      const rate = reg.filter((x) => !x.violate).length / Math.max(1, reg.length);
      if (reg.length >= o.minN && rate >= o.target) { pass = Math.min(0.5, Math.round((v + 0.01) * 100) / 100); passEv = { n: reg.length, allowRate: rate }; break; }
    }
    if (Math.abs(block - cur.block) >= 0.01 || Math.abs(pass - cur.pass) >= 0.01) out.push({ ruleId, from: cur, to: { block, pass }, evidence: { n: ps.length, atOrAboveBlock: blockEv, belowPass: passEv } });
  }
  return out;
}

export function recordProposal(db: Db, baseRulesVer: string, proposals: readonly ThresholdProposal[], candidateDir: string | null, at: number): string {
  const id = `fp-${uuid().slice(0, 8)}`;
  tx(db, () => db.prepare("INSERT INTO feedback_proposal(proposal_id, base_rules_ver, changes, evidence, candidate_dir, status, created_at) VALUES (?,?,?,?,?,'proposed',?)")
    .run(id, baseRulesVer, JSON.stringify(proposals.map((p) => ({ rule_id: p.ruleId, from: p.from, to: p.to }))), JSON.stringify(Object.fromEntries(proposals.map((p) => [p.ruleId, p.evidence]))), candidateDir, at));
  return id;
}

/** Approve or reject a proposal once; a decided proposal cannot be decided again. */
export function decideProposal(db: Db, id: string, decision: "approved" | "rejected", by: string, reason: string, at: number): void {
  tx(db, () => {
    const r = db.prepare("SELECT status FROM feedback_proposal WHERE proposal_id=?").get(id) as { status: string } | undefined;
    if (!r) throw new Error(`proposal ${id} not found`);
    if (r.status !== "proposed") throw new Error(`proposal ${id} already ${r.status}`);
    db.prepare("UPDATE feedback_proposal SET status=?, decided_by=?, decided_at=?, decision_reason=? WHERE proposal_id=?").run(decision, by, at, reason, id);
  });
}
