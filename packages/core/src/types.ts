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
  | "fastpath_error"   // the fast path kept failing for one item (dev plan R4): after GatewayConfig.intakeMaxAttempts tries it goes to a human
  | "image_review"     // stage ③: the image reached the image checker, but the content was not auto-passed or blocked; the agent has no image channel, so a person looks
  | "calib_missing"    // §2.2 system cause: a required question has answers but none calibrated (strict mode without a fitted bucket)
  | "judge_incomplete" // §2.2 system cause: the judge returned no answer for a required question
  | "image_unsupported"   // content carries images and no image channel to the judge exists (text MVP): never auto-disposed
  | "bundle_missing"      // the policy bundle version pinned on the review is not available to this worker
  | "agent_stalled";      // the agent's conversation stopped with no work left and no ruling (e.g. the model kept erroring)

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
  conversation_id: string | null; submission_id: string | null; submission_attempt: number | null;
  /** why the fast path sent this review to the agent (§2.2), e.g. suspicious_band, injection_suspected, blacklist_hit */
  suspect_reason: string | null;
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
  account_id: string | null; thread_id: string | null; reply_to: string | null; mentions: string | null; event_time: number; ingest_seq: number; created_at: number;
};

export type JudgeCallRow = {
  judge_call_id: string; review_id: string | null; content_id: string; attempt: number | null;
  provider: string; model: string; api: string;
  input_sha: string; request_sha: string | null; evidence_set: string;
  rules_ver: string; calib_ver: string; evidence_ver: string;
  status: "ok" | "timeout" | "error" | "abstain";
  shuffle_seed: number | null; confirms_call_id: string | null; mass_covered: number | null;
  latency_ms: number | null; input_tokens: number | null; output_tokens: number | null;
  cost_micro: number | null; cost_status: "settled" | "estimated" | "unknown"; prices_ver: string; created_at: number;
};

export type JudgeAnswerRow = {
  judge_call_id: string; question_sha: string; rule_id: string | null;
  question_kind: "rule" | "exception" | "image_check" | "guard";
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
  /** readable name sent to judges instead of the sha (e.g. ABUSE-001, ABUSE-001.EX-QUOTE, image_check); answers are mapped back to sha */
  key?: string;
  kind: "rule" | "exception" | "image_check" | "guard";   // guard: the fast-path injection check (dev plan §2.2)
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
  /** Optional lines for the agent stage only (dev plan 2026-10-08 §3.1 problem 1, temporary): the agent's dispose is
   *  checked against these instead of `thresholds`; the fast path always uses `thresholds`. Absent = same as fast path. */
  agentThresholds?: { block: number; pass: number };
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
  /** Fast-path injection guard (dev plan 2026-10-08 §2.2, owner choice): asked with the rule questions; at or above
   *  `threshold` the fast path neither passes nor blocks — the item goes to the agent as injection_suspected. Optional. */
  injectionGuard?: { threshold: number; question: Question };
  /** An automatic pass needs a second, confirming answer (shuffled options). Default true. Dev plan §2.2: a policy
   *  switch so both settings can be measured (owner 2026-10-07). */
  confirmPass?: boolean;
  /** stage ② finding (fast path cannot see context): content that replies to someone or @-mentions someone is not
   *  decided automatically by the fast path — "pass": not auto-passed; "all": neither auto-passed nor auto-blocked —
   *  it goes to the agent as needs_context. Default off (unset): behaviour unchanged. */
  contextRoute?: "pass" | "all";
};

export type PolicyBundle = {
  rulesVer: string;
  rules: readonly Rule[];
  scenes: Readonly<Record<Scene, SceneConfig>>;
};

export function rulesFor(bundle: PolicyBundle, scene: Scene): Rule[] {
  return bundle.rules.filter((r) => r.scenes.includes(scene));
}

/** Readable, stable name of a question: its `key`, else derived as the rule loader derives it (ABUSE-001,
 *  ABUSE-001.EX-QUOTE, image_check). Used for calibration buckets. */
export function questionKey(q: Pick<Question, "key" | "kind" | "ruleId" | "exceptionId">): string {
  return q.key ?? (q.kind === "image_check" ? "image_check" : q.kind === "guard" ? "injection_guard" : q.exceptionId ? `${q.ruleId}.${q.exceptionId}` : (q.ruleId ?? q.kind));
}

export function ruleAllowed(rule: Rule): readonly Action[] {
  return ["pass", rule.defaultAction];
}

/** Every question the bundle can ask (rules, exceptions, scene image checks and injection guards) by sha. One place,
 *  so a new question kind cannot be missing from one lookup and present in another (§2.2 guard). */
export function allQuestions(bundle: PolicyBundle): Map<string, Question> {
  const m = new Map<string, Question>();
  for (const r of bundle.rules) {
    m.set(r.question.sha, r.question);
    for (const x of r.exceptions) m.set(x.question.sha, x.question);
  }
  for (const sc of Object.values(bundle.scenes)) {
    m.set(sc.imageCheck.question.sha, sc.imageCheck.question);
    if (sc.injectionGuard) m.set(sc.injectionGuard.question.sha, sc.injectionGuard.question);
  }
  return m;
}

export function questionsOf(bundle: PolicyBundle): Set<string> {
  const s = new Set<string>();
  for (const r of bundle.rules) {
    s.add(r.question.sha);
    for (const x of r.exceptions) s.add(x.question.sha);
  }
  for (const sc of Object.values(bundle.scenes)) {
    s.add(sc.imageCheck.question.sha);
    if (sc.injectionGuard) s.add(sc.injectionGuard.question.sha);
  }
  return s;
}

/** Calibration bucket: the judge model × rules version × scene × option count (docs §9.2). */
/** `question` = questionKey() of the question being calibrated (dev plan R9b: without it, two questions with the same
 *  scene and option count shared one bucket and their files silently replaced each other). */
export type CalibBucket = { judge: string; rulesVer: string; scene: Scene; nOptions: number; question: string };

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
