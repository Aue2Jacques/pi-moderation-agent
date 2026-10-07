// Shared fixtures for core tests. No sample text from datasets: all content strings are synthetic placeholders.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../packages/core/src/index.ts";
import type { PolicyBundle, Pins, Question, Rule, Scene } from "../packages/core/src/index.ts";

export const T0 = 1_700_000_000_000;

export function freshDb(role: core.Role = "test"): core.Db {
  const dir = mkdtempSync(join(tmpdir(), "modtest-"));
  const db = core.openAppDb(join(dir, "app.db"), role);
  core.ensureSchema(db);
  return db;
}

export function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "modtest-")), "app.db");
}

const q = (kind: Question["kind"], ruleId: string | undefined, exceptionId: string | undefined, instructions: string, criteria: Record<string, string>, extra: Partial<Question> = {}): Question => ({
  sha: core.questionSha({ kind, ...(ruleId ? { rule_id: ruleId } : {}), ...(exceptionId ? { exception_id: exceptionId } : {}), instructions, criteria }),
  kind,
  instructions,
  criteria,
  ...(ruleId ? { ruleId } : {}),
  ...(exceptionId ? { exceptionId } : {}),
  violationOption: "violate",
  passChoices: ["none"],
  ...extra,
});

export const ABUSE_Q = q("rule", "ABUSE-001", undefined, "abuse?", { violate: "abusive", none: "not abusive", unknown: "unclear" });
export const ABUSE_EX_Q = q("exception", "ABUSE-001", "EX-QUOTE", "quoting to report?", { applies: "yes", not_applies: "no", unknown: "unclear" }, { violationOption: "applies", passChoices: [], appliesChoice: "applies", notAppliesChoice: "not_applies" });
export const MKT_Q = q("rule", "MARKETING-003", undefined, "marketing?", { violate: "lead", none: "no", unknown: "unclear" });
export const IMG_Q = q("image_check", undefined, undefined, "image violation?", { violate: "bad", none: "fine", unknown: "unclear" });

export const ABUSE_RULE: Rule = {
  ruleId: "ABUSE-001", category: "ABUSE", scenes: ["comment", "post", "nickname"], severity: 2, defaultAction: "takedown",
  thresholds: { block: 0.9, pass: 0.1 }, question: ABUSE_Q, exceptions: [{ id: "EX-QUOTE", question: ABUSE_EX_Q }],
};
export const MKT_RULE: Rule = {
  ruleId: "MARKETING-003", category: "MARKETING", scenes: ["comment", "post"], severity: 1, defaultAction: "limit",
  thresholds: { block: 0.92, pass: 0.1 }, question: MKT_Q, exceptions: [],
};

const sceneCfg = (required: string[]) => ({
  requiredCategories: required, allowedActions: ["pass", "limit", "takedown"] as const, pendingVisibility: "hidden" as const,
  deadlineMs: 60_000, humanSlaMs: 3_600_000, defaultSeverity: 1,
  imageCheck: { thresholds: { block: 0.9, pass: 0.1 }, question: IMG_Q },
});

export const BUNDLE: PolicyBundle = {
  rulesVer: "rules@test1",
  rules: [ABUSE_RULE, MKT_RULE],
  scenes: {
    comment: sceneCfg(["ABUSE", "MARKETING"]),
    post: sceneCfg(["ABUSE", "MARKETING"]),
    nickname: sceneCfg(["ABUSE"]),
    danmaku: sceneCfg(["ABUSE"]),
    image: sceneCfg([]),
  },
};

export const PINS: Pins = { rulesVer: "rules@test1", calibVer: "calib@t1", evidenceVer: "evidence@t1", pricesVer: "prices@t1" };
export const CFG: core.Config = { ...core.DEFAULT_CONFIG };

export function seedContent(db: core.Db, id: string, scene: Scene = "comment", extra: Partial<core.NewContent> = {}): void {
  core.intakeInsert(db, { contentId: id, scene, text: `placeholder text for ${id}`, eventTime: T0, ...extra }, T0);
}

export type JudgeOpts = {
  id: string; contentId: string; reviewId?: string | null; p: number; choice?: string; question?: Question;
  evidenceShas?: string[]; confirms?: string; status?: "ok" | "timeout" | "abstain"; model?: string; calibVer?: string; at?: number;
  extraAnswers?: { question: Question; p: number; choice: string }[]; uncalibrated?: boolean;
};

/** Record a judge call whose fingerprint matches the content + evidence set. */
export function judge(db: core.Db, o: JudgeOpts): string {
  const content = core.readContent(db, o.contentId)!;
  const set = o.evidenceShas ?? [];
  const question = o.question ?? ABUSE_Q;
  const mk = (qq: Question, p: number, choice: string) => ({
    questionSha: qq.sha, ruleId: qq.ruleId ?? null, kind: qq.kind, choice,
    rawProbs: { [qq.violationOption]: p, none: 1 - p },
    calibratedProbs: o.uncalibrated ? null : { [qq.violationOption]: p, none: 1 - p },
  });
  core.recordJudgeCall(db, {
    judgeCallId: o.id, reviewId: o.reviewId ?? null, contentId: o.contentId, attempt: null,
    provider: "test", model: o.model ?? "jev-test", api: "typesafe-system-one",
    inputSha: core.inputFingerprint(content.text_sha, content.scene, set, PINS.evidenceVer), evidenceSet: set,
    pins: { ...PINS, calibVer: o.calibVer ?? PINS.calibVer }, status: o.status ?? "ok",
    ...(o.confirms ? { confirmsCallId: o.confirms, shuffleSeed: 17 } : {}),
    costMicro: 50, costStatus: "settled",
    answers: [mk(question, o.p, o.choice ?? (o.p >= 0.5 ? "violate" : "none")), ...(o.extraAnswers ?? []).map((x) => mk(x.question, x.p, x.choice))],
  }, o.at ?? T0);
  return o.id;
}

/** A confirmed low-risk pair for every required question of the comment scene (ABUSE + MARKETING). */
export function lowRiskConfirmed(db: core.Db, contentId: string, reviewId: string | null, prefix = "jc", at = T0): string[] {
  const extra = [{ question: MKT_Q, p: 0.02, choice: "none" }];
  judge(db, { id: `${prefix}-a`, contentId, reviewId, p: 0.02, choice: "none", extraAnswers: extra, at });
  judge(db, { id: `${prefix}-b`, contentId, reviewId, p: 0.03, choice: "none", extraAnswers: extra, confirms: `${prefix}-a`, at: at + 1 });
  return [`${prefix}-a`, `${prefix}-b`];
}

export function addEvidence(db: core.Db, reviewId: string, attempt: number, kind: core.EvidenceKind, n: number, body = `evidence body ${n}`): string {
  const sha = core.sha256(body);
  const id = core.evidenceId(reviewId, n);
  core.tx(db, () => {
    db.prepare("INSERT INTO evidence(evidence_id, review_id, attempt, kind, source_ref, snapshot_seq, body_sha, body, model_view, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, reviewId, attempt, kind, `src:${n}`, 0, sha, body, JSON.stringify({ untrusted: true }), T0);
  });
  return sha;
}

export const HUMAN = { token: "tok", reviewers: ["rev1"] };
export const humanAuth = { reviewerId: "rev1", token: "tok" };

export function expectCode(fn: () => unknown, code: core.ErrorCode): core.CoreError {
  try {
    fn();
  } catch (e) {
    if (core.isCoreError(e) && e.code === code) return e;
    throw e;
  }
  throw new Error(`expected ${code}, nothing thrown`);
}
