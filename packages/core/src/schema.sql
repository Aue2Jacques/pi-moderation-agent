-- app.db schema. Source of truth: docs/dev-doc-v1.md §2.2 (v1.4).
-- Pragmas (journal_mode, synchronous, busy_timeout, foreign_keys) are set per connection in db.ts.

CREATE TABLE IF NOT EXISTS ledger_seq (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT OR IGNORE INTO ledger_seq VALUES (1, 0);

CREATE TABLE IF NOT EXISTS content (
  content_id   TEXT PRIMARY KEY,
  scene        TEXT NOT NULL CHECK(scene IN ('comment','danmaku','nickname','post','image')),
  text_sha     TEXT,
  text         TEXT,
  image_refs   TEXT,
  account_id   TEXT, thread_id TEXT,
  reply_to     TEXT,           -- the content this one replies to (dev plan 2026-10-08 R8b); index created in db.ts migrate()
  mentions     TEXT,           -- JSON array of account ids it @-mentions (R8b)
  event_time   INTEGER NOT NULL,
  ingest_seq   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_thread ON content(thread_id, event_time);
CREATE INDEX IF NOT EXISTS content_account ON content(account_id, event_time);

CREATE TABLE IF NOT EXISTS synth_event (
  event_id   TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('prior_ruling','appeal','post','warning')),
  payload    TEXT NOT NULL,
  event_time INTEGER NOT NULL, ingest_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS synth_event_acct ON synth_event(account_id, event_time);

CREATE TABLE IF NOT EXISTS intake (
  content_id   TEXT PRIMARY KEY REFERENCES content(content_id),
  prio         INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL CHECK(status IN ('received','preprocessed','judged')),
  judged_review_id TEXT,
  lease_owner  TEXT, lease_until INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS intake_status ON intake(status, prio, created_at);

CREATE TABLE IF NOT EXISTS review (
  review_id        TEXT PRIMARY KEY,
  content_id       TEXT NOT NULL REFERENCES content(content_id),
  seq              INTEGER NOT NULL,
  trigger          TEXT NOT NULL CHECK(trigger IN ('fast','suspicious','appeal','recheck','rule_change')),
  trigger_request_id TEXT NOT NULL,
  trigger_payload_sha TEXT NOT NULL,
  state            TEXT NOT NULL CHECK(state IN ('queued','investigating','disposed','human_queue','human_disposed')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT, lease_until INTEGER,
  revoked_attempt  INTEGER,
  deadline_at      INTEGER,
  snapshot_seq     INTEGER NOT NULL,
  budget_tools     INTEGER NOT NULL DEFAULT 12,
  budget_micro     INTEGER NOT NULL DEFAULT 50000,
  used_micro       INTEGER,
  cost_status      TEXT CHECK(cost_status IN ('settled','estimated')),
  over_budget_micro INTEGER,
  yield_continues  INTEGER NOT NULL DEFAULT 0,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL, prices_ver TEXT NOT NULL,
  judge_model      TEXT NOT NULL,
  agent_model      TEXT,
  conversation_id  TEXT,
  submission_id    TEXT,
  submission_attempt INTEGER,   -- the generation (attempt) that submission_id belongs to (dev plan 2026-10-08 R2)
  release_reason   TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(content_id, seq),
  UNIQUE(content_id, trigger_request_id),
  UNIQUE(review_id, content_id, seq),
  CHECK((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS review_state_deadline ON review(state, deadline_at);
CREATE INDEX IF NOT EXISTS review_state_lease ON review(state, lease_until);
CREATE INDEX IF NOT EXISTS review_content ON review(content_id, seq DESC);
CREATE INDEX IF NOT EXISTS review_conv ON review(conversation_id);

CREATE TABLE IF NOT EXISTS ruling (
  review_id    TEXT PRIMARY KEY REFERENCES review(review_id),
  content_id   TEXT NOT NULL, seq INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK(action IN ('pass','limit','takedown')),
  actor        TEXT NOT NULL CHECK(actor IN ('fastpath','agent','human')),
  attempt      INTEGER,
  allowed_actions TEXT NOT NULL,
  effective_answers TEXT NOT NULL,
  evidence_ids TEXT NOT NULL, rule_ids TEXT NOT NULL, judge_call_ids TEXT NOT NULL,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  model_id     TEXT,
  reason       TEXT,
  ingest_seq   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(content_id, seq),
  FOREIGN KEY(review_id, content_id, seq) REFERENCES review(review_id, content_id, seq),
  CHECK(actor <> 'agent' OR attempt IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ruling_content_ingest ON ruling(content_id, ingest_seq);

CREATE TABLE IF NOT EXISTS content_state (
  content_id       TEXT PRIMARY KEY REFERENCES content(content_id),
  effective_action TEXT CHECK(effective_action IN ('pass','limit','takedown')),
  effective_seq    INTEGER NOT NULL DEFAULT 0,
  visibility       TEXT NOT NULL CHECK(visibility IN ('visible','self_only','hidden')),
  updated_at       INTEGER NOT NULL,
  CHECK((effective_action IS NULL) = (effective_seq = 0))
);

CREATE TABLE IF NOT EXISTS outbox (
  event_id     TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES review(review_id), content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('ruling','release')),
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','acked','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_at);

CREATE TABLE IF NOT EXISTS delivery_receipt (
  receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_receipt_event ON delivery_receipt(event_id);

CREATE TABLE IF NOT EXISTS consumer_log (
  event_id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL, review_id TEXT NOT NULL, content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  result     TEXT NOT NULL CHECK(result IN ('applied','stale','notified','stale_notification')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS consumer_log_review ON consumer_log(review_id, kind);
CREATE TABLE IF NOT EXISTS downstream_state (
  content_id TEXT PRIMARY KEY,
  applied_action TEXT, applied_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS downstream_human (
  review_id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
  pending INTEGER NOT NULL CHECK(pending IN (0,1)),
  opened_by TEXT, closed_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS downstream_human_content ON downstream_human(content_id, pending);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id  TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES review(review_id),
  attempt      INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('account_history','thread_context','image_check','similar','rule','judge')),
  source_ref   TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  body_sha     TEXT NOT NULL,
  body         TEXT NOT NULL,
  model_view   TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_review ON evidence(review_id);

CREATE TABLE IF NOT EXISTS judge_call (
  judge_call_id TEXT PRIMARY KEY,
  review_id TEXT REFERENCES review(review_id), content_id TEXT NOT NULL, attempt INTEGER,
  provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
  input_sha TEXT NOT NULL,
  request_sha TEXT,            -- digest of the request actually sent (dev plan R9a); input_sha is the logical grouping key
  evidence_set TEXT NOT NULL,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','timeout','error','abstain')),
  shuffle_seed INTEGER,
  confirms_call_id TEXT,
  mass_covered REAL,
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cost_micro INTEGER, cost_status TEXT NOT NULL CHECK(cost_status IN ('settled','estimated','unknown')),
  prices_ver TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS judge_call_review ON judge_call(review_id);

CREATE TABLE IF NOT EXISTS judge_answer (
  judge_call_id TEXT NOT NULL REFERENCES judge_call(judge_call_id),
  question_sha  TEXT NOT NULL,
  rule_id       TEXT,
  question_kind TEXT NOT NULL CHECK(question_kind IN ('rule','exception','image_check','guard')),
  choice        TEXT NOT NULL,
  raw_probs     TEXT NOT NULL, calibrated_probs TEXT, temperature REAL,
  PRIMARY KEY(judge_call_id, question_sha)
);
CREATE INDEX IF NOT EXISTS judge_answer_q ON judge_answer(question_sha);

-- One row per physical provider response (dev plan 2026-10-08 R5a): a generation task that retries a failed request
-- has several. response_key = the provider responseId, else "t<timestamp>"; a hook replayed for the same response is
-- idempotent, a real retry is a new row.
CREATE TABLE IF NOT EXISTS model_call (
  generation_task_id TEXT NOT NULL,
  response_key TEXT NOT NULL,
  review_id TEXT NOT NULL REFERENCES review(review_id), attempt INTEGER NOT NULL, conversation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  usage TEXT,
  stop_reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (generation_task_id, response_key)
);
CREATE INDEX IF NOT EXISTS model_call_review ON model_call(review_id);

CREATE TABLE IF NOT EXISTS tool_slot (
  review_id TEXT NOT NULL REFERENCES review(review_id), call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL, tool TEXT NOT NULL,
  counts_toward_limit INTEGER NOT NULL CHECK(counts_toward_limit IN (0,1)),
  reserved_micro INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','blocked')),
  block_reason TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(review_id, call_id)
);

CREATE TABLE IF NOT EXISTS tool_request (
  review_id TEXT NOT NULL, call_id TEXT NOT NULL, request_no INTEGER NOT NULL,
  judge_call_id TEXT,
  cost_micro INTEGER,
  cost_status TEXT NOT NULL CHECK(cost_status IN ('inflight','settled','unknown')),
  created_at INTEGER NOT NULL, settled_at INTEGER,
  PRIMARY KEY(review_id, call_id, request_no),
  FOREIGN KEY(review_id, call_id) REFERENCES tool_slot(review_id, call_id)
);

CREATE TABLE IF NOT EXISTS worker_command (
  command_id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('abort')), attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','ignored')),
  created_at INTEGER NOT NULL, done_at INTEGER
);
CREATE INDEX IF NOT EXISTS worker_command_status ON worker_command(status);

CREATE TABLE IF NOT EXISTS human_queue (
  review_id TEXT PRIMARY KEY REFERENCES review(review_id),
  severity INTEGER NOT NULL, due_at INTEGER NOT NULL, reason TEXT NOT NULL,
  claimed_by TEXT, claimed_at INTEGER,
  closed_at INTEGER, closed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS human_queue_open ON human_queue(closed_at, severity DESC, due_at);

CREATE TABLE IF NOT EXISTS feedback (
  feedback_id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review(review_id),
  rule_id TEXT NOT NULL, human_label TEXT NOT NULL, machine_prob REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, ref_id TEXT NOT NULL, actor TEXT NOT NULL,
  payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

CREATE TABLE IF NOT EXISTS version_pin (
  kind TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL,
  loaded_at INTEGER NOT NULL, rollout_pct INTEGER NOT NULL DEFAULT 0 CHECK(rollout_pct BETWEEN 0 AND 100),
  PRIMARY KEY(kind, version)
);

CREATE TABLE IF NOT EXISTS gate_run (
  gate_run_id TEXT PRIMARY KEY,
  config_sha TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)), report TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_bundle (
  rules_ver  TEXT PRIMARY KEY,
  bundle     TEXT NOT NULL,   -- PolicyBundle JSON (rules + scenes), the version a review is pinned to
  texts      TEXT NOT NULL,   -- rule_id → rule text (load_rule output)
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics_minute (minute INTEGER PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_health (id INTEGER PRIMARY KEY CHECK(id=1), last_tick INTEGER NOT NULL);
