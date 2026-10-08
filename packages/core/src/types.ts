// Row and policy types shared by G, W and tests. Policy bundle = rules/ + config/scenes.yaml (docs §10).
import type { Trigger } from "./ids.ts";

export type Action = "pass" | "limit" | "takedown";
export type Actor = "fastpath" | "agent" | "human";
export type ReviewState = "queued" | "investigating" | "disposed" | "human_queue" | "human_disposed";
export type Scene = "comment" | "danmaku" | "nickname" | "post" | "image";
export type Visibility = "visible" | "self_only" | "hidden";
export type ReleaseReason =
  | "timeout" | "budget_tools" | "budget_cost" | "evidence_gap" | "judge_down"
  | "model_release" | "backpressure" | "revoked" | "preprocess_error"
  | "image_unsupported"   // content carries images and no image channel to the judge exists (text MVP): never auto-disposed
  | "bundle_missing";     // the policy bundle version pinned on the review is not available to this worker

export type Pins = { rulesVer: string; calibVer: string; evidenceVer: string; pricesVer: string };

export type ReviewRow = {
  review_id: string; content_id: string; seq: number; trigger: Trigger;
  trigger_request_id: string; trigger_payload_sha: string;
  state: ReviewState; attempt: number;
  lease_owner: string | null; lease_until: number | null; revoked_attempt: number | null;
  deadline_at: number | null; snapshot_seq: number;
  budget_tools: number; budget_micro: number;
  used_micro: number | null; cost_status: "settled" | "estimated" | null; over_budget_micro: number | null;
  yield_continues: number;
  rules_ver: string; calib_ver: string; evidence_ver: string; prices_ver: string;
  judge_model: string; agent_model: string | null;
  conversation_id: string | null; submission_id: string | null;
  release_reason: string | null;
  created_at: number; updated_at: number;
};

export type RulingRow = {
  review_id: string; content_id: string; seq: number; action: Action; actor: Actor; attempt: number | null;
  allowed_actions: string; effective_answers: string;
  evidence_ids: string; rule_ids: string; judge_call_ids: string;
  rules_ver: string; calib_ver: string; evidence_ver: string;
  model_id: string | null; reason: string | null; ingest_seq: number; created_at: number;
};

export type ContentRow = {
  content_id: string; scene: Scene; text_sha: string | null; text: string | null; image_refs: string | null;
  account_id: string | null; thread_id: string | null; event_time: number; ingest_seq: number; created_at: number;
};

export type JudgeCallRow = {
  judge_call_id: string; review_id: string | null; content_id: string; attempt: number | null;
  provider: string; model: string; api: string;
  input_sha: string; evidence_set: string;
  rules_ver: string; calib_ver: string; evidence_ver: string;
  status: "ok" | "timeout" | "error" | "abstain";
  shuffle_seed: number | null; confirms_call_id: string | null; mass_covered: number | null;
  latency_ms: number | null; input_tokens: number | null; output_tokens: number | null;
  cost_micro: number | null; cost_status: "settled" | "estimated" | "unknown"; prices_ver: string; created_at: number;
};

export type JudgeAnswerRow = {
  judge_call_id: string; question_sha: string; rule_id: string | null;
  question_kind: "rule" | "exception" | "image_check";
  choice: string; raw_probs: string; calibrated_probs: string | null; temperature: number | null;
};

export type EvidenceKind = "account_history" | "thread_context" | "image_check" | "similar" | "rule" | "judge";
export const CONTENT_BEARING_EVIDENCE: readonly EvidenceKind[] = ["account_history", "thread_context", "image_check", "similar"];

export type EvidenceRow = {
  evidence_id: string; review_id: string; attempt: number; kind: EvidenceKind; source_ref: string;
  snapshot_seq: number; body_sha: string; body: string; model_view: string; created_at: number;
};

// ---- policy bundle (rules + scenes), resolved per rules_ver by the policy package ----

export type Question = {
  sha: string;                       // question_sha
  kind: "rule" | "exception" | "image_check";
  /** question text sent to judges (the sha covers these) */
  instructions: string;
  criteria: Record<string, string>;
  ruleId?: string;
  exceptionId?: string;
  violationOption: string;           // option whose calibrated probability is "p" for thresholds
  passChoices: readonly string[];    // choices that may support pass (never "unknown")
  appliesChoice?: string;            // exception questions: the choice meaning "exception applies"
  notAppliesChoice?: string;
};

export type Rule = {
  ruleId: string;
  category: string;                  // ABUSE | MARKETING | VIOLENCE | image_check
  scenes: readonly Scene[];
  severity: number;
  defaultAction: "limit" | "takedown";
  thresholds: { block: number; pass: number };
  question: Question;
  exceptions: readonly { id: string; question: Question }[];
};

export type SceneConfig = {
  requiredCategories: readonly string[];      // categories that must be covered for auto-pass (image_check added when has_images)
  allowedActions: readonly Action[];
  pendingVisibility: Visibility;
  deadlineMs: number;
  humanSlaMs: number;
  defaultSeverity: number;
  imageCheck: { thresholds: { block: number; pass: number }; question: Question };
};

export type PolicyBundle = {
  rulesVer: string;
  rules: readonly Rule[];
  scenes: Readonly<Record<Scene, SceneConfig>>;
};

export function rulesFor(bundle: PolicyBundle, scene: Scene): Rule[] {
  return bundle.rules.filter((r) => r.scenes.includes(scene));
}

export function ruleAllowed(rule: Rule): readonly Action[] {
  return ["pass", rule.defaultAction];
}

export function questionsOf(bundle: PolicyBundle): Set<string> {
  const s = new Set<string>();
  for (const r of bundle.rules) {
    s.add(r.question.sha);
    for (const x of r.exceptions) s.add(x.question.sha);
  }
  for (const sc of Object.values(bundle.scenes)) s.add(sc.imageCheck.question.sha);
  return s;
}

/** Calibration bucket: the judge model × rules version × scene × option count (docs §9.2). */
export type CalibBucket = { judge: string; rulesVer: string; scene: Scene; nOptions: number };

/**
 * Runtime calibration contract (docs §9.2 / round-9 item 5). `apply` returns null when no fitted file covers the bucket:
 * the answer is then recorded with calibrated_probs = NULL and never becomes an effective answer (only "suspicious").
 * mode "identity" is the explicit smoke/联调 mode: raw probabilities are copied through and the pin is `calib@identity`.
 */
export type Calibrator = {
  calibVer: string;
  mode: "strict" | "identity";
  apply(bucket: CalibBucket, rawProbs: Readonly<Record<string, number>>): { probs: Record<string, number>; temperature: number } | null;
};
