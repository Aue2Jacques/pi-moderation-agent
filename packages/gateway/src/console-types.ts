// Response shapes of the console API (G's HTTP, /api/*). No imports: the web console (packages/console) imports this
// file by relative path for its types, so the two sides cannot drift.

export type Action = "pass" | "limit" | "takedown";
export type ReviewState = "queued" | "investigating" | "disposed" | "human_queue" | "human_disposed";

/** Which way a review went: fast-path pass / block, to the agent, straight to a person (a system cause), or an appeal. */
export type RouteKind = "fast_pass" | "fast_block" | "agent" | "human_direct" | "appeal" | "other";

export type ProbPair = { choice: string; raw: number | null; cal: number | null };

/** One question of one judge request: the primary answer, the shuffled-option copy and the lines it was checked against. */
export type QuestionScore = {
  question_sha: string;
  key: string;                       // ABUSE-001, MARKETING-003, injection_guard, ...
  kind: "rule" | "exception" | "image_check" | "guard";
  rule_id: string | null;
  /** rule lines used at this stage (agent lines for agent calls when the rule has them); guard: block = its threshold */
  lines: { block: number; pass: number } | null;
  primary: ProbPair | null;
  confirm: ProbPair | null;
  /** mean calibrated probability of the answers present (what the engine compares with the block line) */
  mean: number | null;
  temperature: number | null;
  verdict: "pass" | "block" | "middle" | "flagged" | "clear" | "uncalibrated" | "missing";
};

export type JudgeRound = {
  judge_call_id: string;
  copy_call_id: string | null;       // the in-call shuffled copy, or null
  stage: "fast" | "agent";
  explicit_confirm_of: string | null; // an agent `confirm` call: the call it re-asks
  attempt: number | null;
  status: string;
  model: string;
  latency_ms: number | null;
  cost_micro: number | null;
  evidence_ids: string[];
  questions: QuestionScore[];
  at: number;
};

export type AgentStep = {
  call_id: string;
  tool: string;
  attempt: number;
  at: number;
  /** ok: ran; reused: returned an earlier result (no new evidence / judge request); blocked: refused by a hook;
   *  rejected: the submit check refused a dispose; pending: started, no result recorded yet */
  status: "ok" | "reused" | "blocked" | "rejected" | "pending";
  block_reason: string | null;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null;
};

export type SubmitRejection = { at: number; actor: string; code: string; step: number; action: string | null; attempt: number | null };

export type RulingView = {
  action: Action; actor: "fastpath" | "agent" | "human"; attempt: number | null;
  rule_ids: string[]; evidence_ids: string[]; judge_call_ids: string[]; allowed_actions: string[];
  model_id: string | null;
  /** free text written by a model or a person: only in the restricted view; reason_code is the fast path's system code */
  reason: string | null; reason_len: number; reason_code: string | null;
  created_at: number;
};

export type HumanView = {
  reason: string; severity: number; due_at: number; queued_at: number;
  claimed_by: string | null; claimed_at: number | null; closed_at: number | null; closed_by: string | null;
  label: string | null;
};

export type ReviewTimeline = {
  review_id: string; seq: number; trigger: string; state: ReviewState; attempt: number;
  created_at: number; updated_at: number; deadline_at: number | null;
  rules_ver: string; calib_ver: string; judge_model: string; agent_model: string | null;
  budget_tools: number; budget_micro: number; used_micro: number | null; cost_status: string | null; tools_used: number;
  route: { kind: RouteKind; reason: string | null };
  suspect_reason: string | null; release_reason: string | null;
  judge_rounds: JudgeRound[];
  steps: AgentStep[];
  rejections: SubmitRejection[];
  ruling: RulingView | null;
  human: HumanView | null;
  appeal: { reason_code: string | null } | null;
};

export type TimelineEvent = { id: string; at: number; review_id: string | null; kind: string; title: string; detail?: string };

export type ContentTimeline = {
  content: {
    content_id: string; scene: string; account_id: string | null; thread_id: string | null; reply_to: string | null;
    text_len: number; text_sha: string | null; created_at: number;
    /** only in the restricted view */
    text: string | null;
  };
  intake: { status: string; attempts: number } | null;
  effective: { action: Action | null; visibility: string } | null;
  /** intake: waiting for the fast path; agent: a review is queued / investigating; human: waiting for a person; done */
  phase: "intake" | "agent" | "human" | "done";
  reviews: ReviewTimeline[];
  events: TimelineEvent[];
  restricted: boolean;
  /** digest of everything above; the stream sends a new snapshot only when it changes */
  version: string;
};

export type ReviewListItem = {
  review_id: string; content_id: string; seq: number; trigger: string; state: ReviewState; attempt: number;
  scene: string; route: RouteKind; suspect_reason: string | null; release_reason: string | null;
  action: Action | null; actor: string | null; used_micro: number | null; rules_ver: string; calib_ver: string;
  judge_model: string; agent_model: string | null;
  created_at: number; updated_at: number;
};

export type HumanQueueItem = {
  review_id: string; content_id: string; scene: string; trigger: string; reason: string; severity: number;
  due_at: number; created_at: number; claimed_by: string | null; claimed_at: number | null;
  closed_at: number | null; closed_by: string | null; suspect_reason: string | null; rules_ver: string;
  state: ReviewState; action: Action | null;
};

export type AppealItem = {
  review_id: string; content_id: string; scene: string; state: ReviewState; created_at: number;
  reason_code: string | null; prior: { action: Action; actor: string } | null; result: { action: Action; actor: string } | null;
};

export type Stats = {
  at: number;
  contents: number; judged: number; reviews: number;
  routes: Record<RouteKind, number>;
  effective: Record<string, number>;
  agent: { disposed: number; released: number; open: number };
  release_reasons: Record<string, number>;
  human: { open: number; claimed: number; closed: number; overdue: number };
  appeals: { total: number; open: number; changed: number };
  cost: { fast_micro: number; review_micro: number; per_content_micro: number; estimated_reviews: number };
  latency_ms: { fast_p50: number; fast_p95: number; agent_p50: number; agent_p95: number; human_p50: number };
  /** decisions per minute over the last 30 minutes, by route */
  series: { minute: number; fast_pass: number; fast_block: number; agent: number; human_direct: number; appeal: number }[];
};

export type RuleInfo = {
  rule_id: string; category: string; scenes: string[]; severity: number; default_action: string;
  thresholds: { block: number; pass: number }; agent_thresholds: { block: number; pass: number } | null;
  text: string; question: { instructions: string; options: Record<string, string> }; exceptions: string[];
};

export type SceneInfo = {
  scene: string; required_categories: string[]; allowed_actions: string[]; pending_visibility: string;
  deadline_ms: number; human_sla_ms: number; confirm_pass: boolean; injection_guard: number | null; context_route: string | null;
};

export type RulesInfo = {
  current: { rules_ver: string; rules: RuleInfo[]; scenes: SceneInfo[] };
  candidate: { rules_ver: string; rollout_pct: number } | null;
  versions: { rules_ver: string; created_at: number; rule_ids: string[]; current: boolean; reviews: number }[];
  rollouts: { kind: string; version: string; rollout_pct: number; loaded_at: number }[];
  gate_runs: { gate_run_id: string; passed: boolean; created_at: number }[];
  calibration: { calib_ver: string; mode: string; files: { question: string; scene: string; rules_ver: string; T: number; n: number | null; ece_before: number | null; ece_after: number | null }[] };
  proposals: { proposal_id: string; base_rules_ver: string; status: string; changes: unknown; created_at: number }[];
};

export type DemoSampleInfo = { id: string; title: string; route: string; scene: string; text: string; account_id: string; parent: { text: string; account_id: string } | null };

export type ConsoleConfig = {
  mode: "demo" | "real";
  rules_ver: string; calib_ver: string; calib_mode: string; prices_ver: string;
  judge_model: string; agent_model: string | null;
  scenes: { scene: string; allowed_actions: string[] }[];
  reviewers: string[];
  /** demo mode only: the reviewer credentials the console uses, so nobody has to type a token on stage */
  demo_auth: { reviewer: string; token: string } | null;
  samples: DemoSampleInfo[];
};
