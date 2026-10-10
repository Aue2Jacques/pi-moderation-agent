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
  /** text: the judge on the (model-view) text; image: the image channel (vision encoder + image_check question) */
  channel: "text" | "image";
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
    /** attached images (metadata only; the bytes: preset samples at their public url, others through the restricted
     *  GET /api/contents/:id/images/:n) */
    images: ImageInfo[];
  };
  intake: { status: string; attempts: number } | null;
  effective: { action: Action | null; visibility: string } | null;
  /** intake: waiting for the fast path; agent: a review is queued / investigating; human: waiting for a person; done */
  phase: "intake" | "agent" | "human" | "done";
  reviews: ReviewTimeline[];
  events: TimelineEvent[];
  restricted: boolean;
  /** demo mode with images: how the images were judged (shown on the timeline); null otherwise */
  image_note: string | null;
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

export type ImageInfo = { n: number; ref: string; preset: { id: string; title: string; url: string } | null };
export type ImageSampleInfo = { id: string; title: string; route: string; scene: string; account_id: string; url: string };

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
  /** demo mode with the traffic generator: how simulated contents and the simulated reviewer are named */
  demo_traffic: { sim_prefix: string; sim_reviewer: string } | null;
  /** demo mode with a corpus: the traffic uses real test texts (contacts masked) and the fast path replays the answers
   *  this judge run gave them; null: made-up texts and the scripted judge */
  demo_corpus: { judge: string; items: number } | null;
  /** image intake: off when no image store is configured (real mode without IMAGE_DIR); demo: the preset screenshots */
  images: { enabled: boolean; max_bytes: number; samples: ImageSampleInfo[]; note: string | null };
};

export type TrafficKind = "normal" | "marketing" | "abuse" | "mild" | "banter" | "repeat" | "injection";

/** GET /api/demo/traffic (demo mode only) */
export type TrafficStatus = {
  /** contents a second (the control's unit); per_min is the same rate a minute */
  per_sec: number; per_min: number; max_per_sec: number; tiers: number[];
  paused: boolean; started_at: number;
  generated: number; by_kind: Record<TrafficKind, number>; appeals: number;
  /** the simulated reviewer (a team under one id): capacity a minute (follows the inflow), tasks claimed and not yet decided */
  sim_reviewer: { id: string; per_min: number; claimed: number; decided: number; open_sim_tasks: number; thinking: number; current: string | null };
  intake_skipped: number;
  /** demo retention (old simulated contents removed, their counts kept in a rollup); null when off */
  retention?: RetentionStatus | null;
};

export type RetentionStatus = {
  /** simulated contents kept in app.db (the newest ones); older finished ones are removed */
  keep: number; every_ms: number;
  /** simulated contents removed so far, and the last run */
  pruned: number; runs: number; last_at: number | null; last_ms: number | null;
  /** size of app.db (+ WAL) in bytes at the last run */
  db_bytes: number | null;
};

/** Fast-path throughput from G's memory (not affected by demo retention). */
export type Flow = {
  /** contents through the fast path in each of the last 300 seconds, oldest first; the last entry is the second that ended at `at` */
  series: number[];
  at: number;
  /** mean over the last 5 seconds (contents a second) */
  per_sec: number;
  /** fast-path time per content over the last minute (judge call, policy, write; without the wait in the intake queue) */
  p50_ms: number | null; p95_ms: number | null;
};

/** One frame of GET /api/events (SSE event "live"). */
export type LiveFrame = {
  seq: number; at: number;
  /** the first frame a subscriber gets: `changed` holds the latest reviews instead of the changes */
  snapshot: boolean;
  stats: Stats;
  /** reviews created or updated since the previous frame, newest change first (at most 100) */
  changed: ReviewListItem[];
  /** change counters: a list re-reads when its counter differs from the one it was read at */
  versions: { reviews: string; human: string; appeals: string; contents: string; traffic: string };
  traffic: TrafficStatus | null;
  /** fast-path contents a second (G's in-memory window); null when the gateway does not report it */
  flow: Flow | null;
};
