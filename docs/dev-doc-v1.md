# 开发文档 v1.2：pi-moderation-agent

日期：2026-10-08。基于冻结的项目文档 `docs/project-doc-v2.md` v2.3。v1.2 并入第六轮外部审查（`docs/reviews/round-6-dev-doc-v1.1-review.md`，基于 5d78c94）的全部意见；逐项处理见附录 X。第五轮的处理记录在附录 Y。历史版本完整保存在 `docs/history/dev-doc-v1.0.md`、`dev-doc-v1.1.md`，**本文自包含，不再引用"同 v1.0"**。

本文把 v2.3 的约定落成：仓库结构、数据模型与 DDL、状态转换表、事务边界、提交校验（含 allowedActions 与有效判官结果）、接口与错误码、W 启动屏障与执行资格、预算与记账、Pi 绑定写法、评测执行协议、用例目录与 CI、部署与配置、分阶段开工顺序与停止条件。

写法约定：
- 与 v2.3 冲突时以 v2.3 为准，并在附录 Z 记录。
- Pi 的 API 名称、签名均来自开发机安装的 `@earendil-works/pi-durable@1.0.4` 与 `@earendil-works/pi-ai@1.0.4` 的 `dist/*.d.ts` 与 README（2026-10-08 核对）。【待核】= 未在代码里验证。
- 数字标注：【实测】有数据；【估计】拍的；【假设计算】由公式推的。
- 正文（content text）在本文、代码、日志、普通 API、测试断言里都用 `content_ref`（sha256）或 fixture ID 引用。模型与判官可以读到受控原文片段（§8.5），这是两条不同的边界。

---

## 0. 本文回答的问题

| 问题 | 章节 |
|---|---|
| 仓库长什么样，谁负责什么 | §1 |
| app.db 有哪些表，谁写谁读 | §2 |
| 审次状态如何转换，谁有权触发 | §3 |
| 哪些写入必须在同一事务 | §4 |
| 提交裁决检查什么、哪个判官结果是当前依据、allowedActions 怎么算 | §5 |
| G、W、人审页、运营 CLI 之间的接口 | §6 |
| W 启动屏障、执行资格、租约、撤权、abort、重放与重启的区别 | §7 |
| 预算与费用记账（硬限制与软限制） | §7.5 |
| Pi 的哪些 API 用在哪，怎么写 | §8 |
| 判官适配器（含 logprob 契约）与策略引擎 | §9 |
| 规则、校准、版本固定、影子回放的两类变更 | §10 |
| 评测执行协议与指标定义 | §11 |
| 测试用例目录、夹具、CI | §12 |
| 部署、配置、密钥、日志 | §13 |
| 分阶段开工顺序与停止条件 | §14 |
| 开工前验证清单 | §15 |

---

## 1. 仓库结构与职责

```
pi-moderation-agent/
├── package.json              # pnpm workspace 根；脚本：check / test / contract / redact-scan / g / w
├── pnpm-workspace.yaml       # allowBuilds（pnpm 12）
├── tsconfig.base.json, tsconfig.json
├── packages/
│   ├── core/                 # 无 Pi 依赖：DDL、状态机、有效判官结果、allowedActions、校验、预算、错误码、脱敏、价格；G 与 W 共用
│   │   └── src/{db.ts, schema.sql, review.ts, states.ts, effective.ts, allowed.ts, submit-check.ts, budget.ts,
│   │            control.ts, outbox.ts, consumer.ts, errors.ts, ids.ts, redact.ts, prices.ts}
│   ├── judges/               # 判官适配器：Jev（pi-ai 内置 typesafe-system-one）、openai-logprob、laya-batch、clef-mm；校准；录制
│   ├── policy/               # 规则 YAML、策略引擎三态、版本固定、contract tests 运行器、影子回放分类
│   ├── gateway/              # 进程 G：队列、预处理、快判、控制循环（调 core/control）、outbox dispatcher、HTTP
│   ├── worker/               # 进程 W：pi-durable Harness、启动屏障、执行资格表、moderation 扩展、宿主控制循环、A 组脚本驱动
│   │   └── src/{main.ts, startup.ts, grants.ts, harness.ts, host-loop.ts, extension/{tools.ts, hooks.ts, sections.ts, guard.ts}, scripted.ts}
│   ├── ops/                  # pi coding-agent 扩展：/shadow /rollout /status /calib（调 G 的 HTTP）
│   └── inspect/              # 调试 CLI：脱敏打印审次、轨迹、账本
├── rules/                    # 规则 YAML（git 版本化）+ mapping.yaml
├── calib/                    # calib/<judge>/<rule>@<ver>.json
├── config/                   # scenes.yaml、models.json、prices.yaml、reviewers.json
├── fixtures/                 # refs.yaml（公开数据集引用）+ benign/（自写无害文本）
├── python/{synth,eval,replay}/   # uv 项目：合成数据、评测运行器与统计、回放器
├── test/{unit,harness,e2e,fault}/
├── scripts/                  # start/kill/reconcile/backup/fetch-fixtures/release-gate/crash-matrix
├── docs/{project-doc-v2.md, dev-doc-v1.md, history/, reviews/}
└── .github/workflows/ci.yml
```

职责边界：
- `core` 是唯一允许写 app.db 业务表的地方；G、W、人审页、运营 CLI、测试驱动全部通过 `core` 的函数写。控制循环的一次扫描（`control.tick()`）、outbox 投递一步（`outbox.dispatchOnce()`）、模拟消费端（`consumer.apply()`）都是 core 的纯函数 + 事务，G 只是定时调用它们，测试可以直接调用。
- `worker` 独占 `session.sqlite`（durable 文档：一个进程拥有一个存储，无跨进程锁）。G 永远不打开 session.sqlite。
- `python/*` 只读 app.db（评测、对账）或只写 intake 表（回放器）。

技术栈固定：Node 22.23.3【实测】、pnpm 12.9.1【实测】、TypeScript 5.9、SQLite 用 Node 内置 `node:sqlite`（同步接口 `DatabaseSync`；事务内禁止 await、禁止等待模型或网络）【待核：WAL 与 busy_timeout 行为，§15.2】、Vitest 3、TypeBox（pi-ai 已带）。Python 3.11.17 + uv【实测】。骨架已搭好并通过 `pnpm run check`【实测 2026-10-08】。

---

## 2. 数据模型（app.db）

app.db 是唯一业务事实源（v2.3 §5.3）。SQLite WAL，`synchronous=NORMAL`，`busy_timeout=5000`。时间为毫秒整数。**费用内部单位统一为微元（1 微元 = 10⁻⁶ 元，整数）**，单价来自 `config/prices.yaml`（版本号 `prices@<sha>`，写入每条调用记录）；展示时换算成元/分，报告另附美元换算与汇率日期。

### 2.1 表清单与读写方

| 表 | 作用 | 写 | 读 |
|---|---|---|---|
| ledger_seq | 全局入库序号（单行计数器） | 所有写 ruling / synth_event / content 的事务 | 审次创建（取边界） |
| content | 原始内容（受限存储），带 ingest_seq | 回放器 | G 预处理、W 工具（受控片段）、受限视图 |
| synth_event | 合成账号事件（历史处置、申诉、发帖），带业务时间与 ingest_seq | synth 导入 | W 工具（as-of） |
| intake | 接入队列（含完成标记） | 回放器、G | G、守恒检查 |
| review | 审次记录（状态、租约、截止、版本固定、预算、触发请求标识、snapshot_seq） | G、W、人审页（经 core） | 全部 |
| ruling | 已提交裁决（PK review_id），带 ingest_seq | G 快判、W dispose、人审页 | 全部 |
| content_state | 内容的当前有效裁决（可为"尚无"） | 与 ruling / 审次创建同事务 | 仪表盘 |
| outbox | 待投递事件 | 与 ruling / release 同事务 | dispatcher |
| consumer_log | 模拟端点的消费记录（event_id 去重） | consumer.apply | 对账 |
| downstream_state | 模拟端点的内容处置状态 | consumer.apply | 对账 |
| downstream_human | 模拟端点的人审待办，**按审次** | consumer.apply | 对账 |
| evidence | 证据（白名单元数据 + 受限全文与模型片段） | W 工具 | W、受限视图；普通 API 只读白名单列 |
| judge_call | 每次判官调用（输入指纹、问题指纹、证据集合、原始与校准概率、费用） | G、W | allowedActions、评测 |
| model_call | 主模型每个 generation task 的逻辑记录 | W hooks | 评测对账 |
| tool_slot | 每次逻辑工具调用的额度占用、物理请求数、费用结算 | W（经 core） | 预算 |
| worker_command | G → W 控制命令 | G | W 轮询 |
| human_queue | 人审队列（含关闭标记） | 与 release / 人工裁决同事务 | 人审页 |
| feedback | 人审标注回流 | 人审页 | 校准器 |
| audit | 追加写审计（哈希链） | core 的独立提交 | 审计 |
| version_pin | 规则/校准/价格版本注册表 | G 热加载时 | W 按审次读取 |
| gate_run | 发布门槛运行记录（绑定配置指纹） | scripts/release-gate | /api/rules/rollout |
| metrics_minute | 每分钟聚合指标 | G | 仪表盘 |

### 2.2 DDL

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;

CREATE TABLE ledger_seq (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO ledger_seq VALUES (1, 0);
-- 取号：UPDATE ledger_seq SET value=value+1 WHERE id=1 RETURNING value;  （在同一事务里，BEGIN IMMEDIATE 下串行）

CREATE TABLE content (
  content_id   TEXT PRIMARY KEY,          -- "coldv1:12345"
  scene        TEXT NOT NULL,             -- comment | danmaku | nickname | post | image
  text_sha     TEXT,
  text         TEXT,                      -- 受限：只有 content 表存正文
  image_refs   TEXT,                      -- JSON ["blob:sha256:..."]
  account_id   TEXT, thread_id TEXT,
  event_time   INTEGER NOT NULL,          -- 业务时间（发布时间）
  ingest_seq   INTEGER NOT NULL,          -- 入库序号（知道它的时刻）
  created_at   INTEGER NOT NULL
);

CREATE TABLE synth_event (
  event_id   TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- prior_ruling | appeal | post | warning
  payload    TEXT NOT NULL,               -- 结构化 JSON，无正文
  event_time INTEGER NOT NULL, ingest_seq INTEGER NOT NULL
);
CREATE INDEX synth_event_acct ON synth_event(account_id, event_time);

CREATE TABLE intake (
  content_id   TEXT PRIMARY KEY REFERENCES content(content_id),
  prio         INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL,             -- received | preprocessed | judged | failed
  judged_review_id TEXT,                  -- 完成标记：快判产生的审次，与审次创建同事务写
  lease_owner  TEXT, lease_until INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX intake_status ON intake(status, prio, created_at);

CREATE TABLE review (
  review_id        TEXT PRIMARY KEY,      -- "<content_id>#<trigger>#<seq>"
  content_id       TEXT NOT NULL REFERENCES content(content_id),
  seq              INTEGER NOT NULL,
  trigger          TEXT NOT NULL,         -- fast | suspicious | appeal | recheck | rule_change
  trigger_request_id TEXT NOT NULL,       -- 稳定触发请求标识；fast/suspicious = content_id；appeal/recheck = 客户端 UUIDv7
  trigger_payload_sha TEXT NOT NULL,      -- 触发请求内容指纹
  state            TEXT NOT NULL,         -- §3
  attempt          INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT, lease_until INTEGER,
  revoked_attempt  INTEGER,
  deadline_at      INTEGER,
  snapshot_seq     INTEGER NOT NULL,      -- 证据可见边界：创建时的 ledger_seq.value（§8.5）
  budget_tools     INTEGER NOT NULL DEFAULT 12,
  budget_micro     INTEGER NOT NULL DEFAULT 50000,   -- 微元；v2.3 "每条 ≤¥0.05"
  used_micro       INTEGER,               -- 终结时从 pi.usage 结算回写（§7.5）
  over_budget_micro INTEGER,              -- 软限制实际超出量
  yield_continues  INTEGER NOT NULL DEFAULT 0,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL, prices_ver TEXT NOT NULL,
  judge_model      TEXT NOT NULL,
  agent_model      TEXT,
  conversation_id  TEXT,
  release_reason   TEXT,                  -- timeout | budget_tools | budget_cost | evidence_gap | judge_down | model_release | backpressure | revoked
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(content_id, seq),
  UNIQUE(content_id, trigger, trigger_request_id)
);
CREATE INDEX review_state ON review(state, deadline_at);
CREATE INDEX review_content ON review(content_id, seq DESC);

CREATE TABLE ruling (
  review_id    TEXT PRIMARY KEY REFERENCES review(review_id),
  content_id   TEXT NOT NULL, seq INTEGER NOT NULL,
  action       TEXT NOT NULL,             -- pass | limit | takedown
  actor        TEXT NOT NULL,             -- fastpath | agent | human
  attempt      INTEGER,
  allowed_actions TEXT NOT NULL,          -- JSON：提交时 core 算出的集合
  effective_judge_calls TEXT NOT NULL,    -- JSON：提交时每条规则的有效判官结果 id（§5.4）
  evidence_ids TEXT NOT NULL, rule_ids TEXT NOT NULL, judge_call_ids TEXT NOT NULL,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  model_id     TEXT,
  reason       TEXT,                      -- 受限
  ingest_seq   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(content_id, seq)
);
CREATE INDEX ruling_content_ingest ON ruling(content_id, ingest_seq);

CREATE TABLE content_state (
  content_id       TEXT PRIMARY KEY,
  effective_action TEXT,                  -- NULL = 尚无裁决
  effective_seq    INTEGER NOT NULL DEFAULT 0,
  visibility       TEXT NOT NULL,         -- visible | self_only | hidden
  updated_at       INTEGER NOT NULL
);

CREATE TABLE outbox (
  event_id     TEXT PRIMARY KEY,          -- "<review_id>#<kind>"
  review_id TEXT NOT NULL, content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind         TEXT NOT NULL,             -- ruling | release
  payload      TEXT NOT NULL,             -- 脱敏 JSON
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | acked | dead
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(status, next_at);

CREATE TABLE consumer_log (
  event_id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL, review_id TEXT NOT NULL, content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  result     TEXT NOT NULL,               -- applied | stale | notified | stale_notification
  created_at INTEGER NOT NULL
);
CREATE TABLE downstream_state (
  content_id TEXT PRIMARY KEY,
  applied_action TEXT, applied_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE downstream_human (                -- 按审次的人审待办（§4 T10）
  review_id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
  pending INTEGER NOT NULL,               -- 1 待人审；0 已关闭
  opened_by TEXT, closed_by TEXT,         -- event_id
  updated_at INTEGER NOT NULL
);

CREATE TABLE evidence (
  evidence_id  TEXT PRIMARY KEY,          -- "<review_id>#e<n>"
  review_id    TEXT NOT NULL REFERENCES review(review_id),
  attempt      INTEGER NOT NULL,
  kind         TEXT NOT NULL,             -- account_history | thread_context | image_check | similar | rule | judge
  source_ref   TEXT NOT NULL,             -- 白名单
  snapshot_seq INTEGER NOT NULL,          -- 白名单：查询边界 = review.snapshot_seq
  body_sha     TEXT NOT NULL,             -- 白名单
  body         TEXT NOT NULL,             -- 受限：全文
  model_view   TEXT NOT NULL,             -- 受限：模型看到的受控片段 JSON（§8.5）
  created_at   INTEGER NOT NULL
);

CREATE TABLE judge_call (
  judge_call_id TEXT PRIMARY KEY,
  review_id TEXT, content_id TEXT NOT NULL, attempt INTEGER,
  provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
  input_sha TEXT NOT NULL,                -- sha256(canonical state)：内容 + 所引证据
  question_sha TEXT NOT NULL,             -- sha256(canonical questions)
  evidence_set TEXT NOT NULL,             -- JSON：所引 evidence 的 body_sha 排序列表（有效结果判定用，§5.4）
  rule_ids TEXT NOT NULL, rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  status TEXT NOT NULL,                   -- ok | timeout | error | abstain
  raw_probs TEXT, calibrated_probs TEXT, temperature REAL,
  mass_covered REAL,                      -- logprob 判官：配置选项覆盖的概率质量
  shuffle_seed INTEGER, consistency_ok INTEGER,
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cost_micro INTEGER, cost_status TEXT NOT NULL,   -- settled | estimated | unknown
  prices_ver TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE model_call (                       -- 逻辑记录：一个 generation task 一行（§7.5）
  generation_task_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL, attempt INTEGER NOT NULL, conversation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  first_usage TEXT,                       -- 首个终态响应的 usage JSON（first-writer-wins）
  created_at INTEGER NOT NULL
);

CREATE TABLE tool_slot (                        -- 逻辑工具调用（§7.5）
  review_id TEXT NOT NULL, call_id TEXT NOT NULL,   -- call_id = Pi ToolCall.id，恢复重放时相同
  attempt INTEGER NOT NULL, tool TEXT NOT NULL,
  counts_toward_limit INTEGER NOT NULL,   -- dispose / release = 0；其余 = 1
  reserved_micro INTEGER NOT NULL,        -- 调用前保守估计
  physical_requests INTEGER NOT NULL DEFAULT 0,   -- 实际向外部发出的请求次数（重放会增加）
  settled_micro INTEGER,                  -- 结算费用（累加所有物理请求的已知费用）
  status TEXT NOT NULL,                   -- reserved | settled | unknown | blocked
  created_at INTEGER NOT NULL, settled_at INTEGER,
  PRIMARY KEY(review_id, call_id)
);

CREATE TABLE worker_command (
  command_id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
  kind TEXT NOT NULL, attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, done_at INTEGER
);

CREATE TABLE human_queue (
  review_id TEXT PRIMARY KEY REFERENCES review(review_id),
  severity INTEGER NOT NULL, due_at INTEGER NOT NULL, reason TEXT NOT NULL,
  claimed_by TEXT, claimed_at INTEGER,
  closed_at INTEGER, closed_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE feedback (
  feedback_id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
  rule_id TEXT NOT NULL, human_label TEXT NOT NULL, machine_prob REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, ref_id TEXT NOT NULL, actor TEXT NOT NULL,
  payload TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

CREATE TABLE version_pin (
  kind TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL,
  loaded_at INTEGER NOT NULL, rollout_pct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, version)
);

CREATE TABLE gate_run (
  gate_run_id TEXT PRIMARY KEY,
  config_sha TEXT NOT NULL,               -- sha256(rules_ver + calib_ver + judge_model + agent_model + prices_ver)
  passed INTEGER NOT NULL, report TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE metrics_minute (minute INTEGER PRIMARY KEY, payload TEXT NOT NULL);
```

要点：
- `ruling.review_id` 主键 = 一审次最多一条裁决；`UNIQUE(content_id, seq)` = 同一内容裁决序号不重复。
- `review` 的 `UNIQUE(content_id, trigger, trigger_request_id)` 是请求幂等的依据（§4 T9）。
- `ledger_seq` 是单行计数器；`ingest_seq` 表示"系统何时知道这条记录"，与业务时间 `event_time` 分开（§8.5）。
- `content_state.effective_action` 可为 NULL：待审初态在 S2 时创建行（NULL, 0, hidden）。
- `audit` 哈希链：`hash = sha256(prev_hash + kind + ref_id + actor + payload + created_at)`；拒绝审计在业务事务回滚之后单独提交（§5.3）。

### 2.3 ID 规则

| ID | 格式 |
|---|---|
| content_id | `<dataset>:<row>`，如 `coldv1:12345` |
| review_id | `<content_id>#<trigger>#<seq>` |
| trigger_request_id | fast/suspicious：`= content_id`；appeal/recheck：客户端 UUIDv7，重试时重用 |
| evidence_id | `<review_id>#e<n>` |
| outbox event_id | `<review_id>#<kind>` |
| durable requestId | 首次代次 `= review_id`；主动重启的新代次 `= review_id#a<attempt>`（§7.4） |
| tool_slot call_id | `= Pi ToolCall.id` |
| model_call 主键 | `= Pi generation task id`（hook 的 `api.taskId`） |
| judge_call_id | UUIDv7 |
| W 实例 id | `w-<hostname>-<pid>-<start_ms>` |

---

## 3. 审次状态机

### 3.1 状态

```
queued          已创建，等待 W 准入
investigating   W 持有租约，正在调查（attempt ≥ 1）
disposed        已提交裁决（ruling 存在），终态
human_queue     已释放给人审；机器代次永久失效
human_disposed  人工提交裁决，终态
failed          release 写入本身反复失败（控制循环会重试到成功，正常不出现）
```
快判直接通过/拦截的审次（trigger=fast）一步到 `disposed`。

### 3.2 转换表

| # | 从 | 到 | 触发者 | 前置条件 | 同事务写入 |
|---|---|---|---|---|---|
| S1 | – | disposed | G 快判 | 策略引擎 pass/block | review + ruling(fastpath) + content_state + outbox(ruling) + intake.judged_review_id |
| S2 | – | queued | G 快判 | suspicious 且 agent 队列未满 | review(snapshot_seq, deadline_at, 版本固定) + content_state(NULL,0,hidden) + intake.judged_review_id |
| S2' | – | human_queue | G 快判 | suspicious 但队列满 / 判官不可用 | review(release_reason) + content_state(初态) + human_queue + outbox(release) + intake.judged_review_id |
| S3 | queued | investigating | W 准入 | 未过 deadline；无活租约或租约已过期 | review(attempt+1, lease_owner, lease_until) |
| S4 | investigating | investigating | W 心跳 | 持有当前代次 | review(lease_until) |
| S5 | investigating | disposed | W dispose | §5 全部通过 | ruling(agent, attempt, allowed_actions, effective_judge_calls) + content_state(条件) + outbox(ruling) + review(state, used_micro) |
| S6 | investigating | human_queue | W release | 持有当前代次 | review(state, reason, lease_owner=NULL, used_micro) + human_queue + outbox(release) |
| S7 | investigating | human_queue | G 控制循环 | 过 deadline / 租约过期且 attempts ≥ N | review(lease_owner=NULL, revoked_attempt, state) + human_queue + outbox(release) + worker_command(abort) |
| S8 | investigating | queued | G 控制循环 | 租约过期（W 死或停摆）且 attempts < N 且未过 deadline | review(lease_owner=NULL, state=queued) |
| S9 | human_queue | human_disposed | 人审页 | 无 ruling；人工授权通过 | ruling(human) + content_state(条件) + outbox(ruling) + review(state) + human_queue.closed_at/closed_by |
| S10 | 终态 | （新审次 queued） | 申诉/重审/规则变更 | §4 T9 | 新 review 行 |
| S11 | queued | human_queue | G 控制循环 | queued 里等到过 deadline | 同 S7 无 abort 命令 |

不允许的转换由提交层拒绝并写审计：终态 → 任何；`human_queue → investigating`；任何携带 `attempt ≠ review.attempt` 或 `lease_owner ≠ 当前` 的机器写入。

### 3.3 内容的有效处置

```
effective(content) = ruling with max(seq) among committed rulings of content；无则"尚无"
```
写 ruling 的事务执行 `UPDATE content_state SET … WHERE content_id=? AND ?new_seq > effective_seq`。release 不碰 content_state。

---

## 4. 事务边界

每个编号是 `packages/core/src/*.ts` 的一个函数，内部 `BEGIN IMMEDIATE … COMMIT`，事务内无 await、无网络。

| # | 函数 | 写入 | 幂等性 / 规则 |
|---|---|---|---|
| T1 | `intakeInsert(content)` | content(ingest_seq 取号) + intake | content_id 冲突忽略 |
| T2 | `fastDispose(contentId, decision)` | S1 全部 | review_id `<content_id>#fast#1` 冲突 → 读回已有 ruling；若 intake.judged_review_id 已非空直接返回该审次，不二次路由 |
| T2' | `createSuspiciousReview(contentId, pins)` | S2 / S2'；`snapshot_seq = ledger_seq.value`（不取号，只读当前值） | 同上 |
| T3 | `acquireLease(reviewId, workerId, ttl)` | S3 | `WHERE state='queued' OR (state='investigating' AND lease_until < now)`；0 行 → `E_LEASE_HELD{lease_until}` |
| T3' | `renewLease(reviewId, workerId, attempt, ttl)` | S4 | `WHERE lease_owner=? AND attempt=?`；0 行 → `E_LEASE_LOST` |
| T4 | `submitRuling(input)` | S5 / S9（ruling.ingest_seq 取号） | §5 |
| T5 | `releaseToHuman(reviewId, actor, attempt?, reason, usedMicro?)` | S6 / S7 / S11 | 已 human_queue → duplicate；终态 → `E_STATE_INVALID` |
| T6 | `revokeAndRelease(reviewId, reason)` | S7 | command_id `<review_id>#abort#<attempt>` 去重 |
| T7 | `requeue(reviewId)` | S8 | 条件更新 |
| T8 | `outboxMark(eventId, status, nextAt)` | outbox | 条件更新 |
| T9 | `createFollowupReview(contentId, trigger, triggerRequestId, payloadSha)` | S10 | 先查 `(content_id, trigger, trigger_request_id)`：存在且 payload_sha 相同 → 返回原审次；存在且不同 → `E_REQUEST_CONFLICT`；不存在 → seq = max+1 插入 |
| T10 | `consumer.apply(event)` | consumer_log + downstream_state + downstream_human | 见下 |
| T11 | `reserveToolSlot(reviewId, attempt, callId, tool, estMicro)` | tool_slot | `INSERT OR IGNORE`（counts_toward_limit 按工具名）；新插入且 `SUM(counts_toward_limit) WHERE status≠'blocked' > budget_tools` → status=blocked，返回 `E_BUDGET_EXCEEDED`；已存在 → 返回原状态（逻辑重放不重复占用） |
| T11' | `bumpPhysicalRequest(reviewId, callId)` | tool_slot.physical_requests+1 | 工具每次真正向外部发请求前调用（重放会再加，这是要记录的事实） |
| T12 | `settleToolSlot(reviewId, callId, micro \| null)` | tool_slot | micro 累加到 settled_micro；null → status=unknown |
| T13 | `recordModelCall(taskId, review, usage)` | model_call | `INSERT OR IGNORE`（first-writer-wins）；重放不重复 |
| T14 | `bumpYield(reviewId, max)` | review.yield_continues | `WHERE yield_continues < max` |
| T15 | `appendRejectAudit(...)` | audit | 在业务事务回滚之后独立提交 |
| T16 | `settleReviewUsage(reviewId, usedMicro, overMicro)` | review.used_micro / over_budget_micro | 终结时写 |

**T10 消费规则（按审次管理人审生命周期）**：
```
event_id 已在 consumer_log → 返回原结果，不改状态
kind = ruling（review r, seq s）：
    if s > downstream_state.applied_seq → applied_action=action, applied_seq=s, result=applied
    else result=stale
    无论 applied 还是 stale：downstream_human[r].pending=0, closed_by=event_id（该审次的人审待办关闭）
kind = release（review r）：
    if consumer_log 已有 r 的 ruling 事件 → result=stale_notification，不改状态
    else downstream_human[r] = {pending:1, opened_by:event_id}, result=notified
```
不同审次的人审待办互不覆盖；内容级"是否有人审待办" = `EXISTS(downstream_human WHERE content_id=? AND pending=1)`。

durable 侧顺序固定：**先 app.db 事务，后 durable memo**。崩溃在两者之间：重跑 `dispose` → memo 无 → T4 幂等读回 → memo。代码审查检查点：`grep -n "memo(" packages/worker/src` 每处之前必有 core 事务调用。

---

## 5. 提交校验

### 5.1 输入

```ts
type SubmitRulingInput = {
  reviewId: string;
  actor: "fastpath" | "agent" | "human";
  attempt?: number; workerId?: string;        // agent 必填
  action: "pass" | "limit" | "takedown";
  evidenceIds: string[]; ruleIds: string[]; judgeCallIds: string[];
  pins: { rulesVer: string; calibVer: string; evidenceVer: string };
  modelId?: string; reason: string;
  usedMicro?: number;                          // agent：提交时从 pi.usage 读到的已用费用
  humanAuth?: { reviewerId: string; token: string };
};
```

### 5.2 检查顺序（T4 事务内，首个失败即回滚）

| 步 | 检查 | 错误码 |
|---|---|---|
| 1 | review 存在 | E_REVIEW_NOT_FOUND |
| 2 | 已有 ruling：`actor` 相同且（agent 时）`attempt` 相同 → 恢复读取，返回原裁决 `duplicate:true`；否则 E_STATE_INVALID | – / E_STATE_INVALID |
| 3 | 状态允许：agent 需 `investigating`；human 需 `human_queue`；fastpath 需新建 | E_STATE_INVALID |
| 4 | 身份：agent 需 `lease_owner=workerId AND attempt=review.attempt AND lease_until ≥ now AND revoked_attempt IS NOT attempt`；human 需 `verifyHumanAuth()` | E_LEASE_LOST / E_ATTEMPT_STALE / E_HUMAN_AUTH |
| 5 | 截止：agent 需 `now < deadline_at` | E_DEADLINE_PASSED |
| 6 | 工具次数硬限制：`SUM(counts_toward_limit) ≤ budget_tools`（dispose 本身不计） | E_BUDGET_EXCEEDED |
| 7 | 版本：pins 与 review 行相等 | E_VERSION_MISMATCH |
| 8 | 规则存在于 rulesVer 且适用 scene；action ∈ 规则 `allowed_actions` | E_RULE_UNKNOWN / E_ACTION_NOT_ALLOWED |
| 9 | 证据归属：每个 evidence 的 review_id = reviewId 且 attempt ≤ review.attempt | E_EVIDENCE_FOREIGN |
| 10 | 判官归属与指纹：每个 judge_call 的 review_id = reviewId；三个版本 = pins；`input_sha` 等于 core 重算值 | E_JUDGE_FOREIGN |
| 11 | **有效判官结果 + allowedActions**（§5.4）：`action ∈ allowedActions` | E_ACTION_NOT_SUPPORTED |
| 12 | 写入 S5/S9；ruling 记录 allowed_actions 与 effective_judge_calls | – |

human：跳过 5、6、11（人工可零证据，但 7–10 仍检查）。fastpath：证据只来自 judge_call，11 同样执行。费用是软限制，不在此处拒绝（§7.5）。

### 5.3 拒绝审计

T4 失败 → 回滚 → 同一 core 函数内立即 T15 单独提交 `audit(kind='submit_rejected', payload={code, step, reviewId, actor, attempt, action})`。D-07 验证回滚后审计行仍存在。

### 5.4 有效判官结果与 allowedActions（`core/effective.ts`、`core/allowed.ts`，纯函数）

**第一步：对每条规则的问题，选出"当前裁决依据"（`effective.ts`）。**

```
trusted = judge_calls where status='ok' AND calibrated_probs IS NOT NULL
          AND input_sha ∈ fingerprintsOf(review)           // 内容 + 本审次证据的合法指纹集合
          AND question_sha ∈ questionsOf(rulesVer)
          AND (shuffle 复问存在时 consistency_ok = 1)
对规则 r 的问题 q：
  groups = trusted with question_sha = q.sha，按 evidence_set 分组
  组内：若 choice 不一致 → group.inconsistent = true；否则 group.p = 该组最新一条的校准概率
  有效组 = evidence_set 为唯一极大元的组（它的证据集合 ⊇ 其他所有组的证据集合）
     - 存在唯一极大 → effective(r) = 该组
     - 不存在（两组证据集合不可比）→ effective(r) = none
```
含义：补了新证据后的复判（证据集合变大）**替代**此前的判断；相同证据反复调用若结果不一致，该组标 inconsistent，不能靠碰到一次低分放行；两条互不包含的证据路径不能互相替代，只能继续补证或 release。

**第二步：allowedActions（`allowed.ts`）。**

```
for rule r in applicable(scene, rulesVer):
    e = effective(r)
    exc_r = 对 r 的每个例外 x：effective(x.question) 的 choice ∈ {applies, not_applies, unknown}；无 → unknown
    block_support(r) = e ≠ none AND !e.inconsistent AND e.p ≥ r.thresholds.block AND all(exc == not_applies)
    pass_support(r)  = e ≠ none AND !e.inconsistent AND e.p < r.thresholds.pass
    suspicious(r)    = e ≠ none AND (e.inconsistent OR (pass ≤ e.p < block))
required = requiredCategories(scene) ∪ (has_images ? {image_check} : ∅)
image_ok = !has_images OR effective(image_check) 存在且 ok
allowed = {}
if any block_support(r):  allowed += r.default_action for those r      // takedown / limit
if no block_support AND all r∈required: pass_support(r) AND image_ok AND no r∈required: suspicious(r):
                          allowed += pass
return allowed            // release 永远允许，不在集合内
```
规则：高风险有效结果 → pass 不在集合；豁免成立（exc=applies）→ 该规则不支持下架；补证据后有效结果变为低风险 → pass 进入集合；文本已有 block_support 时其他类别不要求覆盖（v2.3 §6.4 提前结束）。证据 ID 只是引用，授权来自有效判官结果与规则。

验收：H-17（高风险不放行 / 豁免不下架 / 低风险放行）、H-25（补证据后放行允许 / 同证据反复抽样一次低分不放行 / 不可比证据路径只能 release）。

### 5.5 错误码全表

| 码 | HTTP | 含义 |
|---|---|---|
| E_REVIEW_NOT_FOUND | 404 | |
| E_STATE_INVALID | 409 | 状态不允许（含终态重复提交） |
| E_REQUEST_CONFLICT | 409 | 同触发请求标识不同内容 |
| E_LEASE_HELD | 409 | 租约被他人持有（附 lease_until） |
| E_LEASE_LOST | 409 | 租约不属于调用方或已过期/撤销 |
| E_ATTEMPT_STALE | 409 | 执行代次已失效 |
| E_DEADLINE_PASSED | 409 | |
| E_BUDGET_EXCEEDED | 409 | 工具次数硬限制 |
| E_VERSION_MISMATCH | 409 | |
| E_RULE_UNKNOWN | 422 | |
| E_ACTION_NOT_ALLOWED | 422 | 动作不在规则/场景白名单 |
| E_EVIDENCE_FOREIGN | 422 | |
| E_JUDGE_FOREIGN | 422 | 判官结果不属于本审次或指纹不符 |
| E_ACTION_NOT_SUPPORTED | 422 | 动作不在 allowedActions（附集合、每条规则的有效结果状态与缺失项） |
| E_HUMAN_AUTH | 401 | |
| E_JUDGE_UNAVAILABLE | 503 | fail-closed |
| E_BACKPRESSURE | 429 | |

工具层把错误码作为 `isError:true` 的结果返回给模型，附固定提示。

---

## 6. 接口

### 6.1 G 的 HTTP（127.0.0.1:8080）

| 方法 路径 | 用途 | 说明 |
|---|---|---|
| GET /api/health | 存活 | {ok, version, queues} |
| GET /api/metrics | 仪表盘（SSE 每秒） | metrics_minute 最新 + 实时队列长度 |
| GET /api/reviews?state=&limit= | 审次列表 | 脱敏：review 行去 reason 类字段 |
| GET /api/reviews/:id | 审次详情 | review + ruling（去 reason）+ evidence **白名单列**（evidence_id, kind, source_ref, snapshot_seq, body_sha, created_at）+ judge_call（去原始输入） |
| GET /api/reviews/:id/restricted | 受限视图 | 鉴权：`Authorization: Bearer <HUMAN_REVIEW_TOKEN>` + `X-Reviewer`（须在 reviewers.json）+ `X-Confirm: yes`；返回 evidence.body、model_view、ruling.reason；写 audit(kind='restricted_view') |
| POST /api/human/claim | 领取人审任务 | 同上鉴权；{reviewer_id} → human_queue 顶部一条 |
| POST /api/human/submit | 人工裁决 | 同上鉴权；SubmitRulingInput(actor=human) |
| POST /api/appeals | 申诉 | {content_id, trigger_request_id(UUIDv7), reason_code}；重试重用同一 id |
| POST /api/rules/shadow | 影子回放 | {rule_id, version} → {kind: threshold_only \| semantic, flips, insufficient, total, rejudged, cost_micro} |
| POST /api/rules/rollout | 灰度 | {rule_id, version, pct}；要求 gate_run(config_sha 匹配, passed=1) |
| GET /api/calib、POST /api/calib/approve | 校准面板 | current / candidate / support / status |
| POST /api/replay/pause、/resume | 背压控制回放器 | |

### 6.2 W 的 HTTP（127.0.0.1:8081，只给 G 与 inspect 用）

| 方法 路径 | 用途 |
|---|---|
| GET /health | {worker_id, grants 统计, harness.inspect() 摘要} |
| POST /abort | {review_id, attempt} → 立即执行一次命令轮询；返回 aborted \| not_running \| stale |
| GET /trace/:review_id | 轨迹（脱敏）：durable `entries()` 投影 |

G 调 W 的 /abort 失败不影响 S7 事务（已提交）；命令同时写 `worker_command`，W 启动与每 500ms 轮询兜底。

### 6.3 G ↔ W 通过 app.db

- 准入：W 自己从 review 表取 `state='queued'` 的审次（T3）；并发上限 `ADMIT_MAX`（MVP 10【估计，2 核 4G】；8 周目标 20）。
- 心跳：W 每 5s T3'，TTL 30s。
- 控制循环：`core/control.tick(now)` 一次扫描 = 对 `deadline_at < now AND state IN ('queued','investigating')` 执行 T6/S11；对 `lease_until < now AND state='investigating'` 执行 `attempts < N ? T7 : T6`。G 每 2s 调用；测试直接调用。
- W 每 500ms 轮询 `worker_command` pending：本地有该 review_id 且 attempt 相等的活会话 → 宿主控制循环执行 `conversation.abort()`，命令标 done；否则 ignored。
- 租约被他人持有（`E_LEASE_HELD`）只在启动阶段出现（§7.3），处理方式是等待，不 abort。

### 6.4 人工授权

`HUMAN_REVIEW_TOKEN` 环境变量 + `config/reviewers.json`；校验函数 `core.verifyHumanAuth(reviewerId, token)`，与租约无关；`/restricted` 与人审接口共用它。

### 6.5 判官适配器接口

请求/响应 JSON（兼容 /v1/systemone，state/questions 原样透传，bool↔noul 互转）：

```json
请求 {"request_id","review_id","content_id","rule_version":"rules@<sha>",
      "state":{"content":{"text_ref":"sha256:…","text":"…","scene":"comment"},
               "evidence":[{"evidence_id","kind","model_view":{…},"untrusted":true}],
               "images":[{"ref":"blob:sha256:…"}]},
      "questions":{"cat":{"type":"choice","instructions":"…","criteria":{…},"rule_ids":["ABUSE-003"]}},
      "options":{"shuffle_seed":17,"timeout_ms":400,"calib":"calib/<judge>/<rule>@<ver>.json"}}
响应 {"judge":{"provider","model","api"},"status":"ok|timeout|error|abstain",
      "input_sha","question_sha","evidence_set":[…],"mass_covered",
      "answers":{"cat":{"type":"choice","choice","probabilities":{…},"confidence","calibrated":{"probabilities":{…},"T"}}},
      "latency_ms","usage":{"input","output","cost_micro","cost_status"}}
```
内部映射到 pi-ai 的 `ClassifierContext { state, questions }` 与 `ClassifierResult { answers, stopReason, usage }`；`classify()` 对 provider 错误返回 `stopReason:"error"` 而不抛【原文，pi-ai README】，适配器转为 `status:"error"`。

---

## 7. 执行资格、租约、恢复、预算

### 7.1 时间线

```
G 创建审次：deadline_at = now + 60s（短文本；验收口径 p95 ≤30s 的 2 倍余量）
W 准入：   attempt=1, lease_until = now + 30s；每 5s 续约
W 调查：   每次外部调用前经 guard() 检查执行资格（§7.3）
到期：     G 控制循环 → T6（原子：撤租约 + human_queue + outbox + worker_command）→ 尽力 POST W /abort
迟到：     旧代次 dispose 到达 T4 → 步 2 或步 4 拒绝（E_STATE_INVALID / E_LEASE_LOST / E_ATTEMPT_STALE）；不新增、不覆盖
人工：     人审页 submit(actor=human) → 跳过机器条件 → human_disposed
```

### 7.2 abort 为何只是尽力

durable 的 `Conversation.abort()` 撤回排队输入、标记每个活任务、等到空闲【原文，types.d.ts】；但 W 可能已死、或模型请求已在飞。S7 的正确性只依赖 T4 的门，abort 只省钱和清理。

### 7.3 W 启动屏障与执行资格表（grants）

durable 事实【原文，types.d.ts】：`Harness.open()` 后 `scheduling="paused"`；`resume()`、`submit()`、`compact()`、`abort()`、`Submission.wait()`、`waitForTask()`、`waitForIdle()` 都会启动调度；`inspect()` 只读不跑任务代码；**工具在 intent 后恢复时直接进入 `execute` 阶段，不再执行 `beforeTool`**【原文，harness/tool.d.ts】；hook 的 `memo` 属于所在任务【原文，HookApi】。

启动顺序（`worker/src/startup.ts`）：

```
0. 单实例锁 data/w.lock（flock）；拿不到 → 退出。
1. Harness.open（paused）。不调用任何会启动调度的方法。
2. inspect() 读出活任务与未结 submission，按 conversation_id 归并。
3. 从 app.db 读 conversation_id 非空且（state 非终态 或 durable 仍有活任务）的审次，分类：
   a finalize : app.db 已是 disposed/human_disposed，durable 仍有活任务
   b revoked  : app.db 是 human_queue（已撤权）
   c leaseLive: investigating 且 lease_until ≥ now（旧实例仍"持有"）
   d reacquire: queued，或 investigating 且租约已过期
4. 对 c：等待到 max(lease_until) 再继续（单实例锁保证旧持有者已死，最多等 TTL=30s）。等待后 c 全部变为 d。
5. 对 d：T3 取新代次 → grants[conv] = {mode:"active", reviewId, attempt}；T3 失败（G 已转人工）→ 归入 b。
   对 a：grants[conv] = {mode:"finalize", reviewId}。对 b：grants[conv] = {mode:"revoked", reviewId}。
6. 准入信号量按 active 数量预占。
7. resume()。此后 durable 恢复的任务：
   - active：纯重放，从断点继续（工具重跑、生成续跑）。
   - finalize：恢复的 dispose/release 工具按 finalize 路径读回业务结果、memo、terminate。
   - revoked：宿主控制循环立即对这些会话 conversation.abort()。在 abort 落地前，durable 可能已为其恢复的 generation 任务发出至多 1 次模型请求；这是成本不是正确性问题（结果无法提交），H-27 计数并记录。
```

**执行资格表（唯一行为表）**

| 模式 | 允许 |
|---|---|
| active | 经 `guard()` 重新检查租约、截止、硬限制后，调用模型、工具、提交 |
| finalize | 只读取已提交业务结果并收尾（memo、terminate）；不调查、不提交 |
| revoked | 停止；不发外部调用、不提交；由宿主控制循环 abort |
| （启动前） | 没有任何任务在跑：resume() 之前不存在"pendingTakeover 会话被执行"的情况，因为步骤 4 把等待放在 resume 之前 |

`guard()`（`extension/guard.ts`）是统一适配层：每个工具 `execute()` 第一行、每个向外部（判官、模型升级、Cloudflare）发请求的 helper 第一行都调用它。它读 grants（进程内存）并对 active 模式做一次 `core.leaseStatus()`（一次 SELECT），返回 `{mode, reviewId, attempt}` 或错误。工具把返回值**保存在调用局部变量**里，整个调用期间不再重读。`beforeTool` 仍做同样的检查（正常路径更早拦住、省一次 intent 提交），但正确性不依赖它。

### 7.4 重放与重启的区别

| 情形 | 触发 | 处理 | 模型看到的 |
|---|---|---|---|
| 恢复重放 | W 崩溃后启动（§7.3） | durable 从断点续跑；同 requestId；工具按 replay 规则重跑 | 原断点，无新输入 |
| 主动重启新代次 | W 活着但租约丢失（心跳停摆 > TTL，G 已 S8 requeue）| 宿主控制循环先 `conversation.abort()` 并 `waitForIdle()`，删除旧 grant；之后若 W 重新 T3 拿到该审次（新 attempt），新 grant 写入，并 `submit({content:"上一代次已中止；已有证据仍可引用。继续审核。", requestId: review_id#a<attempt>})` | 同一会话的旧转录 + 一条新输入 |

两者不混称"从原断点继续"。旧代次的在飞调用，因为 abort + waitForIdle 在重新 T3 之前完成，不可能查到新 attempt。

### 7.5 预算与费用

**硬限制 = 工具次数**；**软限制 = 费用**。如实命名，记录超出量。

- 工具次数：`beforeTool` 和 `guard()` 都调 T11 `reserveToolSlot(reviewId, attempt, call.id, call.name, estMicro)`。`call.id` 是 Pi 的 ToolCall.id【原文】，恢复重放相同 → `INSERT OR IGNORE` 不重复占用。`counts_toward_limit`：dispose/release = 0，其余 = 1。超限 → block（dispose/release 仍放行）。
- 物理请求：工具每次真正向外部发请求前 T11' `physical_requests+1`；重放会再加。逻辑次数（limit）与物理次数（费用）分开报。
- 工具费用：`afterTool` 与工具执行体结算 T12（判官返回 usage → 按 prices.yaml 算微元；无 usage/超时 → unknown，预算按 `reserved_micro` 计）。
- 主模型费用的**事实源是 durable 的 `pi.usage` 文档**（`UsageDoc`，按 `provider/model` 与工具名累计，**失败和中止的尝试也计入**【原文，README "Usage and Cost"】）。hooks 与工具的 `api` 都实现 `DocumentReader`（`snapshot` / `snapshotAsOf`【原文，types.d.ts】），所以 `beforeTool`、`onYield`、`guard()` 都能 `api.snapshot(UsageDoc, conversationId, ctx)` 读到当前累计【待核：snapshot 在 hook 内可用】。费用判断 = `micro(pi.usage.models) + micro(pi.usage.tools) + Σ reserved_micro(status=unknown)`。
- `model_call` 只做逻辑记录：`afterResponse` 调 T13 `INSERT OR IGNORE`，主键 = generation task id（`api.taskId`）；不用 memo 计数。物理尝试次数与真实费用看 `pi.usage`。
- 软限制的执行：`beforeTool`/`guard()` 发现费用 ≥ budget_micro → block 非终结工具；`onYield`/`afterTools` 发现超限 → 宿主控制循环 release(reason=budget_cost)。超出上界 = 一次在飞模型请求（输出长度上限由 `max_tokens` 固定）+ durable 重试策略（`retry.maxRetries=2`）+ 流超时内的重发；实际超出量写 `review.over_budget_micro`（T16），评测卡报告分布。不宣称绝对费用上限。
- `onYield` 续跑次数：T14 `bumpYield(reviewId, 1)` 写在 review 行（hook memo 属于所在任务，不能当审次计数）。
- 终结时（dispose/release 成功后）工具把 `pi.usage` 换算的 used_micro 经 T16 写回 review。

验收 H-22：同轮 3 工具、已用 11/12 → 第 1 个执行、后 2 个 block；release 不计次；工具重放 → tool_slot 行数不变、physical_requests+1；afterResponse 重放 → model_call 行数不变；pi.usage 与 model_call 对账一致。

---

## 8. Pi 绑定写法

### 8.1 Harness 打开（`worker/src/harness.ts`）

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(relayProvider());           // §13.3
models.setProvider(judgeProvider());           // §9.1
const registry = createRegistry();
registry.install(Moderation);
const harness = await Harness.open(await openNodeSqliteStorage(SESSION_DB), {
  models, registry,
  settings: { stream: { timeoutMs: 60_000, maxRetries: 0 }, retry: { maxRetries: 2 },
              toolExecution: "sequential", compaction: { enabled: false } },
  onReport: (e) => log.warn({ err: redact(e) }, "extension failure"),
}, ctx);
// 不在这里 resume()；见 §7.3
```

`toolExecution:"sequential"`：审核工具之间有因果，顺序执行使轨迹可读；预算正确性不依赖它。`compaction.enabled=false`：单审次上下文短，且避免 summary 复述正文。`stream.maxRetries=0` 把重试全部交给 durable 的 `retry`，便于计数。

### 8.2 一审次一会话

durable 的 `requestId` 去重只在单会话内【原文，README】，所以自建索引：`review.conversation_id` 列。流程：W 准入拿到租约后，若为空 → `harness.createConversation({ownership:{kind:"ownerless"}, agent:{model, instructions, tools}}, ctx)` → `core.bindConversation(reviewId, convId)`（条件 `conversation_id IS NULL`）。崩溃在两者之间 → 重启后再建一个，旧会话成为孤儿（无任务无成本），`scripts/gc-sessions.ts` 清理。然后 `conv.submit({type:"input", content: initialPrompt(reviewId), requestId: review_id, whenBusy:"reject"}, ctx)`。重复 submit 同 requestId 返回同一 submission【原文】。

备选【待核】：durable 的 session 级文档族（`defineDocFamily`）以 review_id 为 key，与 createConversation 同 commit；索引在 session.sqlite 里 G 看不到，MVP 后再评估。

### 8.3 工具定义（`extension/tools.ts`）

```ts
const dispose = defineTool({
  name: "dispose",
  description: "提交裁决。只接受证据 ID 与行动建议；原文、规则、校准由服务器按审次绑定。",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("pass"), Type.Literal("limit"), Type.Literal("takedown")]),
    evidence_ids: Type.Array(Type.String()),
    rule_ids: Type.Array(Type.String()),
    reason: Type.String({ maxLength: 500 }),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const g = guard(api);                                        // §7.3；局部变量，调用期间不再重读
    if (g.mode === "revoked") return err("E_LEASE_LOST");
    const memoed = await api.memo<RulingSummary>("ruling", ctx);
    if (memoed) return done(memoed);
    if (g.mode === "finalize") {                                 // 读回，不提交
      const r = core.readRuling(g.reviewId);
      if (!r) return err("E_STATE_INVALID");
      await api.memo("ruling", summarize(r), ctx);
      return done(summarize(r));
    }
    const used = microOf(await api.snapshot(UsageDoc, api.conversationId, ctx));
    const r = core.submitRuling({ reviewId: g.reviewId, actor: "agent", attempt: g.attempt, workerId: WORKER_ID,
      action: args.action, evidenceIds: args.evidence_ids, ruleIds: args.rule_ids,
      judgeCallIds: judgeCallsOf(g.reviewId), pins: g.pins, modelId: g.modelId, reason: args.reason, usedMicro: used });
    if (!r.ok) return { isError: true, content: text(`${r.code}: ${r.hint}`), details: { code: r.code } };
    await api.memo("ruling", summarize(r.ruling), ctx);          // app.db 之后才 memo
    return done(summarize(r.ruling));
  },
});
const done = (s: RulingSummary) => ({ content: text(`disposed ${s.action}`), details: s, control: { terminate: true } });
```

要点：`replay:"safe"`；两层幂等（memo、T4 读回）；`control:{terminate:true}` 让 durable 不再请求模型【原文，README "Tools"】；`details` 脱敏进 durable，`reason` 只进 app.db 受限字段。

其余工具：

| 工具 | 执行体 | 写 evidence | 外部调用（经 guard + T11'） |
|---|---|---|---|
| get_account_history | synth_event as-of 查询（§8.5） | 是 | 无 |
| get_thread_context | content as-of 查询，前后各 3 条 | 是 | 无 |
| get_image | 取图 → Clef 适配器 → judge_call | 是 | 是（同 review_id + image sha 复用 judge_call） |
| find_similar_dispositions | simhash 近邻 + as-of 有效裁决 | 是 | 无 |
| load_rule | 规则正文与例外（按 review.rules_ver） | 是（kind=rule） | 无 |
| judge | 判官复判（内容 + 所引证据 model_view）→ judge_call（含 evidence_set） | 是（kind=judge） | 是 |
| escalate_model | `api.commit(tx => configure(tx, api.conversationId, { model: STRONG }))`；写 review.agent_model | 否 | 否；下一请求生效【原文】；主比较中 block |
| release | T5（带 usedMicro）；memo；terminate | 否 | 否 |

### 8.4 hooks（`extension/hooks.ts`）

```ts
hook(ToolTask, {
  beforeTool: async (call, api, ctx) => {
    const g = grants.get(api.conversationId);
    if (!g || g.mode !== "active") return { block: g ? "E_LEASE_LOST" : "E_LEASE_HELD" };
    if (call.name === "escalate_model" && !FLAGS.escalation) return { block: "escalation disabled" };
    if (!ALLOWED_TOOLS.has(call.name)) return { block: "tool not allowed" };
    const st = core.leaseStatus(g.reviewId, WORKER_ID, g.attempt);
    if (!st.held) return { block: "E_LEASE_LOST" };
    if (st.deadlinePassed) return { block: "E_DEADLINE_PASSED" };
    const spent = microOf(await api.snapshot(UsageDoc, api.conversationId, ctx)) + core.unknownReserved(g.reviewId);
    if (spent >= g.budgetMicro && !TERMINAL_TOOLS.has(call.name)) return { block: "E_BUDGET_COST: 只能 release 或 dispose" };
    const r = core.reserveToolSlot(g.reviewId, g.attempt, call.id, call.name, estMicro(call.name));   // T11
    if (!r.ok) return { block: "E_BUDGET_EXCEEDED: 只能 release 或 dispose" };
    return undefined;
  },
  afterTool: async (call, result, api, ctx) => {
    const g = grants.get(api.conversationId); if (!g) return undefined;
    core.settleToolSlot(g.reviewId, call.id, microOfResult(result));                                 // T12
    return undefined;
  },
}),
hook(GenerationTask, {
  afterResponse: async (message, api, ctx) => {
    const g = grants.get(api.conversationId); if (!g) return;
    core.recordModelCall(api.taskId, g, message.usage);                                              // T13，INSERT OR IGNORE
  },
  afterTools: async (_a, _r, api, ctx) => {
    const g = grants.get(api.conversationId); if (!g || g.mode !== "active") return;
    const st = core.leaseStatus(g.reviewId, WORKER_ID, g.attempt);
    const spent = microOf(await api.snapshot(UsageDoc, api.conversationId, ctx));
    if (!st.held) hostLoop.request({ conversationId: api.conversationId, kind: "abort", reason: "revoked" });
    else if (spent >= g.budgetMicro) hostLoop.request({ conversationId: api.conversationId, kind: "release", reason: "budget_cost" });
  },
  onYield: async (answer, api, ctx) => {
    const g = grants.get(api.conversationId); if (!g || g.mode !== "active") return undefined;
    if (core.hasTerminal(g.reviewId)) return undefined;
    if (core.bumpYield(g.reviewId, 1)) return { continue: "你必须调用 dispose 或 release 结束本审次。" };   // T14
    hostLoop.request({ conversationId: api.conversationId, kind: "release", reason: "model_release" });
    return undefined;
  },
}),
```

hook 的 `api` 是 `HookApi`（taskId、conversationId、memo、DocumentReader），**没有 `conversation()`**【原文】。所以 hook 不自己 abort；它向宿主控制循环（`host-loop.ts`，W 主循环的一部分）投递请求，控制循环用 `harness.conversation(id)` 执行 T5 → `abort()`，并在 `waitForIdle()` 后删除 grant。abort 的实际取消行为在 §15.1 的 Pi 验证里确认。

### 8.5 证据：as-of 边界、模型可见片段、白名单

**边界**：审次创建时记 `snapshot_seq = ledger_seq.value`。所有取证查询加 `ingest_seq ≤ review.snapshot_seq`（知识边界），业务过滤用 `event_time`（例如近 7 天 = `event_time ≥ review.created_at − 7d`）。两者分开：事件何时发生 ≠ 系统何时知道它。

**历史有效裁决**（给线程邻居、相似内容、账号历史用）：
```sql
SELECT action FROM ruling WHERE content_id=? AND ingest_seq <= :snapshot_seq ORDER BY seq DESC LIMIT 1
```
取边界内**已入库的最高审次序号**，不是入库最晚的一条，所以旧审次晚于新审次完成也不会把旧裁决翻出来。

**模型/判官看到的**（`evidence.model_view`，受限存储）：

| 工具 | model_view | 查询 |
|---|---|---|
| get_thread_context | 前后各 3 条：`{content_id, text（截断 200 字）, account_id, event_time, prior_effective_action}`，整体 `untrusted:true` | content：`thread_id=? AND ingest_seq ≤ snapshot_seq`，按 event_time 取邻居；prior_effective_action 用上面的 SQL |
| get_account_history | 结构化：近 7 天各动作计数、最近 5 条裁决 `{seq, action, rule_ids, event_time}`、申诉次数 | synth_event + ruling，`ingest_seq ≤ snapshot_seq AND event_time ≥ created_at − 7d` |
| find_similar_dispositions | `{content_id, simhash_distance, action_as_of, event_time}` | content + ruling 同上 |
| load_rule | 规则正文与例外（可信通道） | rules_ver |
| get_image | 图给判官；主模型有视觉能力时也作为内容块给主模型（§13.3） | 图片不可变 |
| judge | 输入 = 内容原文 + 所引证据 model_view；返回校准概率；记录 evidence_set | input_sha 固定 |

**普通 API / 日志 / 仪表盘看到的**：白名单列 `evidence_id, kind, source_ref, snapshot_seq, body_sha, created_at`；无 summary、无 model_view。

验收 H-21：创建审次后 (a) 插入同毫秒时间戳的新裁决、(b) 插入业务时间更早但入库更晚的事件、(c) 旧审次晚于新审次完成，旧审次的工具结果全部不变。

### 8.6 faux provider（harness 测试）

`fauxProvider()` 脚本化回复：`faux.setResponses([fauxAssistantMessage([fauxToolCall("get_thread_context", {...})]), …])`【原文，pi-ai README】。测试用它驱动确定的工具序列，并在 CRASH_AT 点 `process.kill(process.pid, "SIGKILL")`。判官用 `judges/recorder.ts` 录制的响应回放。

---

## 9. 判官适配器与策略引擎

### 9.1 classifier API

**Jev 已可用（2026-10-08 实测）**：原生 System One 协议（`POST <base>/systemone`），返回 `jev-1.13.0`，choice 概率 + noul，单次 0.24–0.32s，约 480 输入 token/次；按官方渠道使用。接入：pi-ai 内置 `typesafe-system-one` API，`createProvider` 注册 `type:"classifier"` 模型条目指向 `JEV_BASE_URL`，不需要自写适配器。MVP 入口判官 = Jev。实测 4 条自写中文评论方向正确但概率全在 0.99–1.00，校准不能省。

自写三个 API：

```ts
createProvider({
  id: "mod-judges", auth,
  models: [
    { type: "classifier", id: "laya-mm-322m", api: "laya-batch", provider: "mod-judges", baseUrl: LAYA_URL, input: ["text"], cost: ZERO, contextWindow: 8192 },
    { type: "classifier", id: "qwen3.8-flash-logprob", api: "openai-logprob", provider: "mod-judges", baseUrl: RELAY_URL, input: ["text"], cost: PRICE_QWEN, contextWindow: 32768 },
    { type: "classifier", id: "clef-flash", api: "clef-mm", provider: "mod-judges", baseUrl: CF_URL, input: ["text", "image"], cost: ZERO, contextWindow: 8192 },
  ],
  classifiers: { "laya-batch": layaBatch(), "openai-logprob": openaiLogprob(), "clef-mm": clefMm() },
});
```

- `laya-batch`：10ms 窗口或 64 条微批，HTTP 到 Modal 或本机 `/v1/systemone`。
- `openai-logprob`：提示构造同 pi-ai `llama-cpp-classify`（选项标签单个 ASCII 大写字母，`max_tokens:1`，`logprobs:true, top_logprobs:20`）；只支持 choice。**解析契约**：对每个配置选项，在 top_logprobs 中匹配去除前导空格后等于该字母的 token，多个匹配取 logprob 最大；**配置的选项必须全部匹配到，否则 `abstain`**；`mass_covered = Σ exp(logprob)`，低于 0.5【估计阈值，开发集校准】也 `abstain`；首个 token 不是任何标签 → `abstain`。`abstain` 不是可信结果，连续 abstain 比例是运营指标。中转站 qwen3.8-flash、glm-5.3 返回 top_logprobs【实测】；视觉模型不返回【实测】。
- `clef-mm`：Cloudflare Workers AI 的 System One transport 只发 state/questions【原文，pi-ai 源码】；先试 `onPayload` 透传 `images`（§15.6），不行则直接调 Cloudflare REST，仍返回 `ClassifierResult` 形状。

### 9.2 校准（`judges/calib.ts`）

- 温度缩放：`p_i = softmax(log p_i / T)`，T 在开发集上最小化 NLL；文件 `calib/<judge>/<rule>@<ver>.json = {T, n, ece_before, ece_after, fitted_at, bucket:{judge, rules_ver, scene, n_options}}`。
- 桶键 = 判官模型 id × 规则版本 × 场景 × 选项数；任一变化 → 文件缺失 → `calibrated: null` → 策略引擎与 allowedActions 都不把它当可信结果（只允许 suspicious / 不进入有效结果）。
- isotonic 在桶样本 ≥ 1,000 时才启用，否则只画可靠性图。
- 对抗一致性：落在 suspicious 边界 ±0.05 的样本用 `shuffle_seed` 打乱选项复问一次；argmax 不一致 → `consistency_ok=0`。

### 9.3 策略引擎（`policy/engine.ts`）

输入：校准后概率 + scene + rules_ver；输出三态与命中规则。纯函数，100% 单测。`status ≠ ok` 或无校准 → `suspicious`；judge_down → G 直接 S2'（reason=judge_down），绝不 pass。含图路由（G 侧）：`images.length > 0` 时 pass 必须等图片检查完成；文本 block 可直接 block；图片检查 abstain/timeout → suspicious。引擎与 allowedActions 共用同一套阈值读取函数。

---

## 10. 规则、校准、版本固定

- 规则集版本 `rules@<sha>` = `rules/` 的 git tree sha；校准集 `calib@<sha>`；价格 `prices@<sha>`；证据快照版本 `evidence@<ver>` = synth 数据批次号。G 启动与 rollout 时加载到内存并登记 version_pin。
- 审次创建时三个版本 + prices_ver 写入 review 行；W 的工具按 review 行的版本读取（`policy.rulesAt(ver)` 从内存缓存或 git 读历史版本）。
- 灰度：`hash(content_id) % 100 < rollout_pct` 的**新审次**用新版本；已有审次不变。
- **影子回放分两类**（`policy/shadow.ts` 按规则 diff 自动分类）：

| 变更类型 | 判定 | 影子做法 |
|---|---|---|
| 只改 thresholds / scenes / default_action / 路由 | `text`、`exceptions`、`question` 的 sha 不变 | 复用旧 judge_call 的校准概率重算三态 |
| 改 text / exceptions / question / 选项 | 任一 sha 变化 | 对影子样本用固定证据（同 input_sha）**重新调用判官**；费用计入影子报告 |

演示场景 2 用第一类时如实标注"复用旧分数"。
- **发布门槛绑定配置**：`scripts/release-gate.ts` 写 `gate_run(config_sha, passed, report)`；`/api/rules/rollout` 要求存在 `passed=1` 且 `config_sha` 等于当前准备发布配置的记录，否则 409。四项门槛：contract tests 100%；目标样本翻转率达预期；回归池无退化；成本与转人审量不超限。
- contract tests 两层：日常 CI 用录制响应（结构、路由、阈值、权限）；发布前 `pnpm run contract:real` 用真实判官对变化的规则跑 contract tests 与该类回归池，结果进 gate_run。
- 工具代码变更：换 `WORKER_VERSION`，新审次才用；不热重装扩展。

---

## 11. 评测执行协议

### 11.1 数据冻结（`python/eval/freeze.py`）

1. 读取数据集 → 映射到 taxonomy（`rules/mapping.yaml`）→ `data/frozen/<dataset>@<ver>/{dev,val,blind}.ids`。
2. 泄漏检查（同线程、同账号、simhash 近重复不跨集；历史只含审次时间前事件）→ `leakage.json`，任一非零阻止冻结。
3. blind IDs 加密存放（age），开发期不解密；只在 `--final` 时读取。

### 11.2 疑似集冻结（`python/eval/suspicious.py`）

固定入口判官（模型 id + rules_ver + calib_ver）与路由规则，对各切分跑一遍快判，输出 `suspicious.<split>.ids`。A/B/B+/C 都读这同一个文件；脚本拒绝不带 `--suspicious-file` 的运行。系统级报告另含快判直接 pass/block 的结果。

### 11.3 四组运行器（`python/eval/run_group.py`）

| 组 | 实现 |
|---|---|
| B | 判官一次：内容 + scene → 三态 |
| B+ | 固定取证 → 全部证据 model_view + 内容 → 判官一次 |
| A | **W 的脚本驱动模式**（`worker/src/scripted.ts`）：同样的审次生命周期（T3、deadline、T11、hooks、T4、allowedActions），工具调用顺序由脚本固定（历史 → 线程 → 相似 → 规则 → judge），然后主模型一次判断并调用 dispose/release |
| C | 完整 W：模型按需选工具 |

A 与 C 的差别只有"谁决定下一个工具"。执行约束：`FLAG_ESCALATION=false`；主模型固定；各组独立环境——基线用 `sqlite3 app.base.db ".backup app.<group>.db"`（在线备份 API，避免 WAL 未检查点的提交丢失）；每组独立 `SESSION_DB`、`OUT_DIR`、`CACHE_NS=<group>`；人审配额 K/千条固定；终态校验三层（§11.5）。

### 11.4 指标定义

| 指标 | 分子 | 分母 | 备注 |
|---|---|---|---|
| 自动误放率（按违规） | 被自动放行的违规样本 | 全部违规样本 | 主指标 |
| 自动放行精度缺口 | 被自动放行的违规样本 | 全部自动放行样本 | 解释指标 |
| 自动误拦率（按正常） | 被自动拦截/限流的正常样本 | 全部正常样本 | 主指标 |
| 自动完成覆盖率 | 自动形成裁决的样本 | 疑似集全部样本 | |
| 转人审率 | release 样本（含超时、预算、撤权） | 疑似集全部样本 | 超配额未处理另列"待处理" |
| 自动裁决时延 p50/p95 | 审次创建 → 裁决 | 自动完成样本 | |
| 自动阶段终止时延 p50/p95 | 审次创建 → 裁决或 release | 疑似集全部样本 | 超时样本按 release 时刻计入，不消失 |
| 成本（微元/条，展示为分） | pi.usage 结算 + unknown 估计（标注） | 疑似集全部样本 | 另报 over_budget 分布与物理/逻辑调用比 |

三项并列报告：自动裁决时延、自动阶段终止时延、转人审率。转人审与未完成样本在质量指标里不作为"正确"。配对 McNemar 按样本配对；Wilson 区间；按案例族/类别/场景分层。评测卡字段缺一报错。

### 11.5 harness 赛道与对账（`scripts/reconcile.ts`）

分两种检查：

**即时安全约束（任何时刻可查，含崩溃中途）**：
1. 不重复：同 review_id ruling ≤ 1；同 event_id consumer_log ≤ 1。
2. 不倒退：`downstream_state.applied_seq` ≤ 已 sent/acked 事件的 max(seq)，且 ≥ 已 acked ruling 事件的 max(seq)。
3. 守恒（从**全部已接收内容**开始）：content 表每一行在 intake 有记录；intake 每行处于 {received/preprocessed 且（有有效租约 或 等待中）, judged 且 judged_review_id 非空, failed 且有审计}之一；每个非终态审次处于 {queued（无租约或租约有效）, investigating（租约有效）, human_queue（有未关闭 human_queue 行）}之一；没有 investigating 且租约过期超过 2 个扫描周期的行。
4. durable 侧：每个 active grant 对应的会话在 `inspect()` 中有活任务或已 settled 的 submission；没有 `conversation_id` 非空、app.db 为 active、durable 里既无活任务又无 settled submission 的审次。**不用 memo 判断终态**。

**排空后的最终一致（故障解除、outbox 排空、确认完成后）**：
5. `content_state.effective_seq` = ruling 的 max(seq)；`downstream_state.applied_seq` = 已 acked ruling 事件的 max(seq)；`downstream_human.pending=1` 的审次集合 = human_queue 未关闭集合。
6. 每个 active 审次的 durable submission 状态为 done 或 unanswered，无活任务。
7. 终结：等待 ≤ 3 × deadline，测试任务全部到达终态或 human_queue。

崩溃矩阵（`scripts/crash-matrix.sh`）：CRASH_AT ∈ {A,B,C,D} × 随机，各 kill ≥ 12 次（合计 ≥ 50），每次后跑即时约束，排空后跑最终一致。判官 100% 超时与 30% 抖动（放行 0）；2× 回放看背压；注入话术对比有无隔离。

---

## 12. 测试用例目录、夹具、CI

### 12.1 单元（test/unit，Vitest，无 IO）

| ID | 对象 | 要点 |
|---|---|---|
| U-01 | engine.ts | 三态边界、无校准只给 suspicious、judge_down 不 pass |
| U-02 | calib.ts | 温度拟合单调性、ECE、桶键变化 → null |
| U-03 | states.ts | S1–S11 全枚举，非法转换抛 E_STATE_INVALID |
| U-04 | submit-check.ts | 步 1–11 每步一个失败 + 一个通过；人工零证据通过；human 在 investigating 被拒 |
| U-05 | ids.ts | review_id 解析/生成往返 |
| U-06 | redact.ts | 含 text/body/reason/model_view 的对象经 redact 后不含正文 |
| U-07 | rules.ts | YAML 加载、版本 sha、contract tests 解析 |
| U-08 | openai-logprob 提示构造 | 与 llama-cpp-classify 的单 token 标签约定一致 |
| U-09 | allowed.ts | §5.4 第二步全分支 |
| U-10 | openai-logprob 解析 | 缺任一选项 → abstain；多 token；前导空格；mass 不足 → abstain |
| U-11 | shadow.ts | 变更分类 |
| U-12 | effective.ts | 唯一极大证据集替代；同证据不一致 → inconsistent；不可比 → none |
| U-13 | consumer.ts 纯逻辑 | §4 T10 四条规则 |

### 12.2 core 集成（真实 SQLite 临时文件）

| ID | 用例 |
|---|---|
| D-01 | T2 重复调用返回同一 ruling |
| D-02 | T3 两个 worker 并发只一个拿到租约 |
| D-03 | T4 后 content_state 正确；旧 seq 写入被 WHERE 拒绝 |
| D-04 | T6 原子性（中途异常全回滚） |
| D-05 | audit 触发器拒绝 UPDATE/DELETE；哈希链校验 |
| D-06 | outbox 投递两次，consumer applied 一次；旧 seq → stale |
| D-07 | 拒绝审计在回滚后仍存在 |
| D-08 | T9：同请求标识重试返回原审次；不同内容 → E_REQUEST_CONFLICT；两个不同请求得两个序号 |
| D-09 | content_state 待审初态 NULL/0 |
| D-10 | release → 人工 ruling 同 seq 仍 applied；重放 release → stale_notification；重放旧 ruling → stale；downstream_human 按审次关闭 |
| D-11 | T11 重放同 call_id 不重复占用；release 不计次（已用 12/12 仍可 release） |
| D-12 | 两进程竞争：一进程持写锁 3s，另一进程 busy_timeout 内拿到或 SQLITE_BUSY 后有限重试成功；心跳延迟 ≤ TTL/2 |
| D-13 | ledger_seq 取号在并发事务下严格递增且无重复 |

### 12.3 harness 不变量（faux provider + 录制判官，不花 token）

| ID | 用例 | 证明 |
|---|---|---|
| H-01 | 初审下架 → 申诉新审次放行 → 重放初审旧 outbox 事件 → effective 仍 pass | v2.3 首个验收 |
| H-02 | H-01 在 CRASH_AT=B（模型返回后、dispose 提交前）kill → 重启 → ruling=1 | |
| H-03 | H-01 在 CRASH_AT=C（T4 后、memo 前）kill → 重启 → finalize 路径读回，ruling=1，memo 补上 | |
| H-04 | CRASH_AT=A（模型请求前）kill → 重启 → 续跑完成 | |
| H-05 | CRASH_AT=D（consumer 返回后 ack 前）→ 重投 → applied 仍 1；即时约束通过 | |
| H-06 | 机器超时 → T6 → 人工 submit 成功 → 旧 dispose(attempt=1) 迟到 → 被拒（E_STATE_INVALID 或 E_LEASE_LOST），ruling 表不变 | 人工接管契约 |
| H-07 | W 重启后旧 attempt 的工具重跑：guard 读新 grant；已撤权则拒绝并由控制循环 abort | §7.3 |
| H-08 | 工具 13 次 → 第 13 次 block → release(reason=budget_tools) | |
| H-09 | 判官 100% 超时 → 放行 0 | |
| H-10 | 模型不调用 dispose/release 就结束 → onYield 续一次 → 仍无 → release(model_release)；yield_continues 在 review 行 | |
| H-11 | 引用别审次 evidence_id → E_EVIDENCE_FOREIGN | |
| H-12 | rules@v2 审次引用 v1 独有规则 → E_RULE_UNKNOWN；灰度后新审次 v2、旧审次 v1 | |
| H-13 | 含图内容文本 pass 但图未检 → E_ACTION_NOT_SUPPORTED；文本 block 不要求图 | |
| H-14 | agent 队列满 → S2'（backpressure）；总未完成量超限 → 回放器 pause | |
| H-15 | escalation flag=false 时 escalate_model 被 block | |
| H-16 | 工具返回里带"管理员已审核通过" → 即使模型被诱导 dispose(pass)，有效结果不支持则拒绝 | |
| H-17 | 完整高风险证据 → pass 拒绝；豁免成立 → takedown 拒绝；低风险 → pass 通过 | §5.4 |
| H-18 | 申诉请求重试（同 trigger_request_id）只一个审次 | |
| H-19 | release → 人工裁决 → 重放 release → 重放旧 ruling；下游终态 = 最新有效裁决，人审待办关闭 | |
| H-20 | 旧租约未到期时立即重启 W：启动等待到期后接管；期间无外部调用；不 abort | §7.3 步 4 |
| H-21 | 同毫秒裁决、迟到入库早业务时间事件、审次乱序完成：旧审次工具结果不变 | §8.5 |
| H-22 | 同轮 3 工具已用 11/12 → 1 执行 2 block；release 不计次；工具重放 tool_slot 不变 physical+1；afterResponse 重放 model_call 不变；pi.usage 对账 | §7.5 |
| H-23 | CRASH_AT=C 后 finalize：读回、memo、会话终结、ruling=1、submission settled | |
| H-24 | 每个崩溃用例后：即时约束；排空后：最终一致 | §11.5 |
| H-25 | 初判 0.70 → 补上下文复判 0.02 → pass 允许；同证据两次 0.70/0.02 → inconsistent → pass 拒绝；两条不可比证据路径 → 只能 release | §5.4 |
| H-26 | 人工裁决先送达、旧 release 后送达 → stale_notification，pending 不重开；两个审次的人审待办互不覆盖 | §4 T10 |
| H-27 | 启动屏障：resume 前 inspect() 显示 paused 且外部调用计数 0；revoked 会话在 abort 前的模型请求数 ≤ 1 并记录；生成请求待恢复与工具 intent 待恢复两种起点都测 | §7.3 |
| H-28 | 主动重启新代次：心跳停摆 → G S8 → W abort+waitForIdle → 重新 T3 → 新 requestId 提交；旧在飞调用不得以新 attempt 提交 | §7.4 |

### 12.4 contract tests 夹具

- `fixtures/refs.yaml`：`{fixture_id, dataset, row, sha256(text), required: true|false}`；`scripts/fetch-fixtures.sh` 在 CI 从公开源拉取（COLD：GitHub，Apache-2.0；ChineseHarm-Bench：HF，CC BY-NC，评测用途）到 `data/fixtures/`（不进 git），校验 sha256。
- 运行器输出 `planned / executed / passed / skipped`；`required` 夹具缺失 → 该规则的 contract 结果为 **fail**，不是 skip；非必需夹具缺失 → skip 并列出。门槛以 `passed == planned - skipped(non-required)` 且 `fail == 0` 判定。
- 自写无害夹具（注入话术、正常引用、合规付款码描述）存 `fixtures/benign/*.txt`，由模型生成，不含辱骂与暴力。
- 两层运行：`pnpm run contract`（录制响应）进 CI；`pnpm run contract:real` 发布前手动。

### 12.5 真实模型 e2e（test/e2e，默认跳过，`RUN_REAL=1`）

| ID | 用例 | 成本【估计】 |
|---|---|---|
| E-01 | 20 条短文本走完整 C 组，终态校验 | ¥1 |
| E-02 | 注入 30 条配对（有/无隔离） | ¥2 |
| E-03 | Jev 100 条 + 校准拟合冒烟；logprob 判官 100 条 | ¥0.5 |

### 12.6 CI（`.github/workflows/ci.yml`，已入库并通过）

```yaml
name: ci
on: [push, pull_request]
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 12.9.1
      - uses: actions/setup-node@v4
        with:
          node-version: 22.23.3
          cache: pnpm
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm run check
      - run: pnpm run test:unit
      - run: pnpm run test:harness
      - run: bash scripts/fetch-fixtures.sh
      - run: pnpm run contract
      - run: pnpm run redact-scan
  python:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: python
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv python install 3.11
      - run: uv sync --frozen
      - run: uv run pytest -q || test $? -eq 5
```

`redact-scan` 是启发式提示（连续 ≥20 个 CJK 字符且不在 docs/、rules/、fixtures/benign/、reports/ 下），不是泄漏边界；边界是 §8.5 的白名单列、夹具管理与 `/restricted` 的鉴权审计。

---

## 13. 部署与配置

### 13.1 开发机（Cloud Studio，2 核 4G 16G 盘，无 GPU）【实测】

已完成【实测 2026-10-08】：Node 22.23.3 于 `/opt/node`；pnpm 12.9.1；npm/pnpm 源腾讯镜像；uv 0.12.23；Python 3.11.17；项目 venv；apt 腾讯源；git 身份；仓库 `/workspace/pi-moderation-agent`，骨架 `pnpm install`、`pnpm run check`、`uv sync` 通过；`.env` 已有 Jev 四项（600 权限）。conda 弃用。

内存预算【估计】：W（durable + TypeBox 约 23MB 峰值【原文】+ 10 个会话）≈ 300MB；G ≈ 150MB；SQLite 页缓存 ≈ 100MB；Laya 本机 int8 ≈ 600MB（可选）。判官基准（W5）放 Modal/Kaggle。

### 13.2 进程与启动

```
scripts/start.sh      # G → W → replayer；各自 nohup，pid 写 run/*.pid，日志 logs/{g,w,replay}.log
scripts/kill-w.sh     # kill -9 W
scripts/reconcile.ts  # §11.5
scripts/backup.sh     # sqlite3 .backup 热备 app.db 与 session.sqlite
scripts/gc-sessions.ts
```

环境变量以仓库根 `.env.example` 为准（按需要的阶段排列）。运行参数：`APP_DB`、`SESSION_DB`、`ADMIT_MAX=10`、`LEASE_TTL_MS=30000`、`DEADLINE_MS_SHORT=60000`、`FLAG_ESCALATION=false`、`CRASH_AT`（仅测试）、`LOG_LEVEL`。配置文件（进 git）：`config/scenes.yaml`（场景 → 必查类别、可见性策略、截止）、`config/reviewers.json`、`config/models.json`、`config/prices.yaml`、`rules/`、`calib/`。

### 13.3 中转站 provider 与模型能力

- pi-ai `createProvider`，OpenAI 兼容，`baseUrl: RELAY_BASE_URL`；模型名与 `max_tokens` 上限按实测写 `config/models.json`。
- 视觉能力【用户口述，待逐个实测】：中转站除 glm-5.3 外的模型支持图片输入。影响：`AGENT_MODEL` 有视觉时 `get_image` 可把图作为内容块给主模型做语义证据；自动放行所需的"图片检查"仍必须是校准判官（Clef）的 `judge_call`，因为视觉模型不返回 logprobs【实测】；替开发者判定图片样本用 `VISION_CHECK_MODEL`，文本用 glm-5.3-flash。
- `config/prices.yaml`：每模型每百万 token 的微元，版本化；pi.usage 的 token 数 × 单价 = 费用。

### 13.4 日志与脱敏

pino JSON；全局 serializer 对键名 `text|body|reason|content|summary|model_view` 做 `[TEXT len=N sha=XXXX]` 替换；inspect CLI 同样。durable 的 session.sqlite 与 app.db 的 content/evidence 表是受限存储：`chmod 600`，备份不出开发机。

### 13.5 密钥

旧机器已报废。密钥由负责人按 `.env.example` 填入新机 `.env`。已有：Jev。待填：中转站（阶段 2 起）、Cloudflare（W4）、Modal/HF/云厂商（W4–W8）。

---

## 14. 开工顺序与停止条件

阶段按依赖排序，每阶段有通过条件与停止条件；10-22 演示范围按阶段实际完成度裁剪，不把未成立的恢复或权限检查包装成已完成。

| 阶段 | 做 | 通过条件 | 停止条件 |
|---|---|---|---|
| 0 骨架 | workspace、tsconfig、core 类型与 errors、schema.sql、fixtures/refs.yaml + fetch 脚本、CI | **已完成**【实测 2026-10-08】 | – |
| 1 core 语义 | T1–T16、states、effective、allowed、submit-check、budget、`control.tick()`、`outbox.dispatchOnce()`、`consumer.apply()`（全部可由测试直接调用） | U-01–U-13、D-01–D-13 全过 | D-08/D-10/D-11/D-12/D-13 任一不过 |
| 2 Pi 最小验证 | harness.ts、startup.ts（§7.3）、grants、guard、host-loop、工具（dispose/release/load_rule/线程/历史/judge 录制版）、hooks、faux 驱动；测试驱动直接调用 core 的控制循环与消费端 | H-01–H-08、H-10、H-17–H-28 过；`inspect()` 证明 resume 前无任务启动；abort 实际取消行为被观测到 | Pi 1.0.4 下任一 H 用例无法实现 → 记录原因，评估 Plan B（AgentSession + sink 幂等）或改设计，不绕过 |
| 3 真实模型 | Jev 入口判官（内置适配器）+ 录制；openai-logprob 判官 + 契约（对照用）；策略引擎；规则 ABUSE 3 条；主模型接入；pi.usage 费用对账 | E-03 冒烟；contract 100%；E-01 20 条终态一致；over_budget 分布有数 | 判官 abstain 率 > 30%【估计阈值】→ 换判官模型再继续 |
| 4 接入与界面 | G intake/预处理/快判/S1/S2/S2'；G 定时调用控制循环与 dispatcher；/api/metrics 与静态页；人审页最简；/restricted 鉴权 | 回放 500 条；H-09、H-11–H-16 过；H-24 在回放后通过 | – |
| 5 故障、效果、演示 | crash-matrix ≥ 20 次；synth C0–C3；版本切换；演示 3、5、1 降速、2 简版 | 四个演示各走一遍；reconcile 即时与最终一致全绿 | – |

阶段 1–2 预计 6–8 天【估计】，是最可能超期的部分；超期则 10-24 录屏只演示场景 3 与 5。阶段 2 的产出是一个小而完整的验证提交：固定判官响应、无害夹具、真实 SQLite、Pi 1.0.4、能稳定复现并关闭附录 X/Y 全部反例的测试。

---

## 15. 开工前验证清单

1. durable 骨架与启动屏障：`Harness.open` → `inspect()` 断言 `scheduling === "paused"` 且无任务被执行 → 分类 → `resume()`；faux 下 10 会话 kill 10 次；观测 `conversation.abort()` 对在飞生成任务的实际效果（是否取消、是否再发一次请求）。
2. node:sqlite 竞争：D-12 场景，结论写成"竞争后仍正确、可恢复"。
3. 中转站：主模型 tool call 往返；qwen3.8-flash top_logprobs；各模型图片输入能力逐个实测写入 `config/models.json`。
4. configure() 下一请求生效。
5. hook 内 `api.snapshot(UsageDoc, …)` 可读且包含失败尝试【待核】。
6. Clef onPayload 透传（W4 前）。
7. 数据重叠与计数；云厂商调 1 条。

---

## 附录 X 第六轮审查（开发文档 v1.1）处理记录

| 审查项 | 处理 | 落点 |
|---|---|---|
| 1 恢复流程互相矛盾；generation 任务可能先发模型请求；恢复不重跑 beforeTool | 采纳。核对 Pi：恢复进入 execute 阶段不重跑 beforeTool。启动屏障：对未到期租约在 resume **之前**等待，不存在 pendingTakeover 会话被执行；唯一行为表 active/finalize/revoked；`guard()` 作为统一适配层在工具执行体与所有外部调用 helper 第一行检查资格并存局部变量；revoked 会话在 abort 前 ≤1 次模型请求如实记录；重放与主动重启分开定义 | §7.3、§7.4、§8.3、H-20、H-27、H-28 |
| 2 memo 计数器错误；memo 存在性对账错误 | 采纳。核对 Pi：memo 是 first-writer-wins；terminal 记录 memos 为 never。model_call 主键 = generation task id，`INSERT OR IGNORE`；物理尝试与费用以 pi.usage 为事实源；对账看任务终态与 submission 状态，不看 memo | §7.5、§8.4、§11.5、H-22、H-23 |
| 3 旧疑似结果永久阻止放行 | 采纳。新增 `effective.ts`：按问题 × 证据集合分组，唯一极大证据集替代旧结果；同证据不一致 → inconsistent；不可比 → none；judge_call 加 evidence_set 列；ruling 记 effective_judge_calls | §5.4、§2.2、U-12、H-25 |
| 4 终结工具豁免未落实；逻辑调用 ≠ 物理请求；费用不是硬预算；分太粗 | 采纳。tool_slot 加 counts_toward_limit、physical_requests（T11'）；工具次数硬限制、费用软限制并记录 over_budget_micro；内部单位微元 | §2.2、§4、§7.5、D-11、H-22 |
| 5 as-of 仅时间戳不够 | 采纳。ledger_seq 入库序号 + review.snapshot_seq 边界；业务时间与入库序号分开；历史有效裁决取边界内最高 seq | §2.2、§8.5、D-13、H-21 |
| 6 下游人审标记被晚到事件重开 | 采纳。downstream_human 按审次；release 对已有 ruling 的审次 → stale_notification；ruling 关闭本审次待办；对账分即时约束与最终一致 | §4 T10、§11.5、D-10、H-19、H-26 |
| §9.1 与 U-10 矛盾 | 采纳：配置选项必须全部匹配否则 abstain | §9.1、U-10 |
| 守恒从 judged 开始 | 采纳：从全部已接收内容开始 | §11.5 |
| 延迟指标掩盖超时 | 采纳：自动裁决时延、自动阶段终止时延、转人审率并列 | §11.4 |
| 夹具 skip 变绿 | 采纳：planned/executed/passed/skipped，required 缺失 = fail | §12.4 |
| /restricted 鉴权 | 采纳：Bearer HUMAN_REVIEW_TOKEN + reviewer 列表 + confirm | §6.1、§6.4 |
| 文档不独立 | 采纳：全文自包含；v1.0/v1.1 存 docs/history | 全文 |
| 阶段依赖 | 采纳：控制循环、dispatcher、消费端作为 core 函数在阶段 1 实现，阶段 2 由测试驱动调用；HTTP/界面仍在阶段 4 | §1、§14 |
| HookApi 无 conversation() | 采纳：hook 只向宿主控制循环投递请求；abort 行为在 §15.1 验证 | §8.4、§15 |

未照搬的一处：审查建议"pendingTakeover 模式下等待接管、不产生外部调用"，本文用"在 resume 之前等待租约到期"实现同一目标，于是运行期不存在该模式；H-20 验证期间无外部调用。

## 附录 Y 第五轮审查（开发文档 v1.0）处理记录

| 审查项 | 处理 | 落点 |
|---|---|---|
| P0-1 放行检查不验证"证据支持放行" | allowedActions 纯函数；judge_call 指纹；ruling 存 allowed_actions；H-17 | §5.4 |
| P0-2 恢复顺序与租约衔接 | 启动顺序、审次分类、finalize 独立路径、执行资格绑定调用（v1.2 进一步收口，见附录 X-1） | §7.3 |
| P0-3 序号唯一 ≠ 请求幂等 | trigger_request_id + payload_sha + UNIQUE；T9 三分支；intake.judged_review_id | §2.2、§4、D-08、H-18 |
| P0-4 release 挡住人工裁决 | consumer_log + downstream_state；S9 关闭 human_queue（v1.2 进一步按审次管理，见 X-6） | §4 T10 |
| P0-5 预算整轮后更新 | tool_slot 按 ToolCall.id 原子占用；onYield 计数在 review 行（v1.2 修正 memo 用法，见 X-2） | §7.5 |
| P0-6 证据语义不足与快照只是标签 | model_view 受限 + 白名单列 + as-of（v1.2 加入库序号边界，见 X-5） | §8.5 |
| 待审初态 / 拒绝审计 / 幂等返回 / logprob 契约 / 费用单位 / 锁验证 / 影子两类 / 门槛绑定 / contract 两层 / A 对齐 / 指标分母 / 隔离含 WAL / 守恒 / CI YAML / 排期 | 全部采纳 | 对应章节 |

## 附录 Z 与 v2.3 的差异记录

| 项 | v2.3 | 本文 | 理由 |
|---|---|---|---|
| 准入并发 | ≤20 | MVP 10，8 周目标 20 | 2 核 4G【实测】 |
| 短文本机器截止 | agent p95 ≤30s（验收） | deadline 60s | 硬边界给 2 倍余量 |
| review_id → conversation_id | durable commit 内 ReviewIndex | app.db 列，durable 文档族备选 | G 需要可见 |
| 工具执行模式 | 未写 | sequential | 轨迹可读 |
| 14 天 MVP 排期 | §11.1 | 阶段 + 停止条件 | 第五、六轮审查 |
| 费用单位 | 元 | 微元内部、分展示 | 第六轮审查 |
| 预算 | "每审次最多 X 元" | 工具次数硬限制、费用软限制并记录超出 | 第六轮审查 |
| MVP 入口判官 | logprob 或 Laya 二选一 | Jev（已可用） | 2026-10-08 实测 |
