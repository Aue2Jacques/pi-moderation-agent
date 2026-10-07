# 开发文档 v1.1：pi-moderation-agent

日期：2026-10-08。基于冻结的项目文档 `docs/project-doc-v2.md` v2.3。v1.1 并入第五轮外部审查（`docs/reviews/round-5-dev-doc-review.md`，基于 ff46c7a）的六个 P0 与全部细节项；逐项处理见附录 Y。

本文把 v2.3 的约定落成：仓库结构、数据模型与 DDL、状态转换表、事务边界、提交校验（含 allowedActions 计算）、接口与错误码、租约与恢复、预算记账、Pi 绑定写法、评测执行协议、用例目录与 CI、部署与配置、分阶段开工顺序与停止条件。

写法约定：
- 与 v2.3 冲突时以 v2.3 为准，并在附录 Z 记录冲突。
- Pi 的 API 名称、签名均来自开发机安装的 `@earendil-works/pi-durable@1.0.4` 与 `@earendil-works/pi-ai@1.0.4` 的 `dist/*.d.ts` 与 README（2026-10-08 核对）。标注【待核】的是还没在代码里验证的点。
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
| 提交裁决检查什么、allowedActions 怎么算、错在哪一步报什么码 | §5 |
| G、W、人审页、运营 CLI 之间的接口 | §6 |
| 租约、截止、撤权、abort、W 重启顺序 | §7 |
| 预算与费用记账 | §7.5 |
| Pi 的哪些 API 用在哪，怎么写 | §8 |
| 判官适配器（含 logprob 契约）与策略引擎 | §9 |
| 规则、校准、版本固定、影子回放的两类变更 | §10 |
| 评测执行协议 | §11 |
| 测试用例目录与 CI | §12 |
| 部署、配置、密钥、日志 | §13 |
| 分阶段开工顺序与停止条件 | §14 |
| 开工前验证清单 | §15 |

---

## 1. 仓库结构与职责

```
pi-moderation-agent/
├── package.json              # pnpm workspace 根；脚本：check / test / g / w / replay
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/                 # 无 Pi 依赖：schema DDL、状态机、allowedActions、校验、错误码、记账、脱敏；G 与 W 共用
│   │   └── src/{db.ts, schema.sql, review.ts, states.ts, allowed.ts, submit-check.ts, budget.ts, errors.ts, ids.ts, redact.ts, prices.ts}
│   ├── judges/               # 判官适配器：pi-ai createProvider({classifiers}) 三个 API + 校准 + logprob 契约
│   │   └── src/{adapter.ts, laya-batch.ts, openai-logprob.ts, clef-mm.ts, calib.ts, recorder.ts}
│   ├── policy/               # 规则 YAML 加载、策略引擎三态、版本固定、contract tests 运行器、影子回放分类
│   │   └── src/{rules.ts, engine.ts, versions.ts, contract.ts, shadow.ts}
│   ├── gateway/              # 进程 G：队列、预处理、快判、控制层（租约扫描）、HTTP（仪表盘/人审/灰度/指标）
│   │   └── src/{main.ts, intake.ts, preprocess.ts, fastpath.ts, control.ts, outbox.ts, http/*.ts}
│   ├── worker/               # 进程 W：pi-durable Harness、moderation 扩展（工具+hooks）、启动对账、准入、命令轮询、A 组脚本驱动
│   │   └── src/{main.ts, startup.ts, harness.ts, extension/{tools.ts, hooks.ts, sections.ts}, admission.ts, commands.ts, scripted.ts}
│   ├── ops/                  # pi coding-agent 扩展：/shadow /rollout /status /calib（调 G 的 HTTP）
│   └── inspect/              # 调试 CLI：脱敏打印审次、轨迹、账本
├── rules/                    # 规则 YAML（git 版本化）+ mapping.yaml
├── calib/                    # 校准文件 calib/<judge>/<rule>@<ver>.json
├── config/                   # scenes.yaml、models.json、prices.yaml、reviewers.json
├── fixtures/                 # contract tests 夹具：公开数据集引用 + 少量自写无害文本（见 §12.4）
├── python/
│   ├── synth/                # 合成账号画像、线程上下文、案例族 C0–C5
│   ├── eval/                 # 冻结切分、疑似集冻结、A/B/B+/C 运行器、配对检验、评测卡、守恒检查
│   └── replay/               # 回放器：泊松到达，写 app.db intake
├── test/{unit, harness, e2e, fault}/
├── scripts/                  # 启动、kill、对账、备份、夹具拉取、发布门槛
├── docs/
└── .github/workflows/ci.yml
```

职责边界：
- `core` 是唯一允许写 app.db 业务表的地方；G、W、人审页、运营 CLI 全部通过 `core` 的函数写。提交校验、allowedActions、预算占用只有一份实现。
- `worker` 独占 `session.sqlite`（durable 文档：一个进程拥有一个存储，无跨进程锁）。G 永远不打开 session.sqlite。
- `python/*` 只读 app.db（评测、对账）或只写 intake 表（回放器）。

技术栈固定：Node 22.23.3【实测】、pnpm 12.9.1【实测】、TypeScript 5.x、SQLite 用 Node 内置 `node:sqlite`（同步接口 `DatabaseSync`；事务内禁止任何 await，禁止等待模型或网络）【待核：WAL、busy_timeout 行为，见 §15.2】、Vitest、TypeBox（pi-ai 已带）。Python 3.11.17 + uv【实测】。

---

## 2. 数据模型（app.db）

app.db 是唯一业务事实源（v2.3 §5.3）。SQLite WAL，`synchronous=NORMAL`，`busy_timeout=5000`。时间为毫秒整数。费用单位统一为**人民币分（整数）**，单价来自 `config/prices.yaml`（版本号 `prices@<sha>`，写入每条调用记录）；对外展示另附美元换算与汇率日期。

### 2.1 表清单与读写方

| 表 | 作用 | 写 | 读 |
|---|---|---|---|
| content | 原始内容（受限存储） | 回放器 | G 预处理、W 工具（受控片段）、受限视图 |
| intake | 接入队列（含完成标记） | 回放器、G | G |
| review | 审次记录（状态、租约、截止、版本固定、预算、触发请求标识） | G、W、人审页（经 core） | 全部 |
| ruling | 已提交裁决（PK review_id） | G 快判、W dispose、人审页 | 全部 |
| content_state | 内容的当前有效裁决（可为"尚无"） | 与 ruling / 审次创建同事务 | 仪表盘、工具（as-of 查询不用它） |
| outbox | 待投递事件 | 与 ruling / release 同事务 | dispatcher |
| consumer_log | 模拟端点的消费记录（event_id 去重） | dispatcher | 对账 |
| downstream_state | 模拟端点的实际处置状态 | 与 consumer_log 同事务 | 对账 |
| evidence | 证据文档（受限：全文与模型可见片段）+ 白名单元数据 | W 工具 | W、受限视图；普通 API 只读白名单列 |
| judge_call | 每次判官调用（输入指纹、问题指纹、原始与校准概率、模型 ID、延迟、费用） | G、W | 评测、仪表盘、allowedActions |
| model_call | 主模型每次调用（用量、费用、代次） | W | 预算、评测 |
| tool_slot | 每次工具调用的额度占用与费用结算（PK review_id+call_id） | W（经 core） | 预算 |
| worker_command | G → W 的控制命令 | G | W 轮询 |
| human_queue | 人审队列（含关闭标记） | 与 release / 人工裁决同事务 | 人审页 |
| feedback | 人审标注回流 | 人审页 | 校准器 |
| audit | 追加写审计（哈希链） | core 的独立提交 | 审计 |
| version_pin | 规则/校准/价格版本注册表 | G 热加载时 | W 按审次读取 |
| gate_run | 发布门槛运行记录（绑定配置指纹） | scripts/release-gate | /api/rules/rollout |
| metrics_minute | 每分钟聚合指标 | G | 仪表盘 |

### 2.2 DDL（核心表）

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;

CREATE TABLE content (
  content_id   TEXT PRIMARY KEY,          -- "coldv1:12345"
  scene        TEXT NOT NULL,             -- comment | danmaku | nickname | post | image
  text_sha     TEXT,
  text         TEXT,                      -- 受限：只有 content 表存正文
  image_refs   TEXT,                      -- JSON ["blob:sha256:..."]
  account_id   TEXT, thread_id TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE intake (
  content_id   TEXT PRIMARY KEY REFERENCES content(content_id),
  prio         INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL,             -- received | preprocessed | judged | failed
  judged_review_id TEXT,                  -- 完成标记：快判产生的审次（S1/S2/S2'），与审次创建同事务写
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
  trigger_request_id TEXT NOT NULL,       -- 稳定的触发请求标识（§4 P0-3）；fast/suspicious = content_id
  trigger_payload_sha TEXT NOT NULL,      -- 触发请求内容指纹；同标识不同内容 → 冲突
  state            TEXT NOT NULL,         -- 见 §3
  attempt          INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT, lease_until INTEGER,
  revoked_attempt  INTEGER,
  deadline_at      INTEGER,
  budget_tools     INTEGER NOT NULL DEFAULT 12,
  budget_fen       INTEGER NOT NULL DEFAULT 5,      -- 人民币分；v2.3 "每条 ≤¥0.05"
  yield_continues  INTEGER NOT NULL DEFAULT 0,      -- onYield 续跑次数（审次级，§7.5）
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL, prices_ver TEXT NOT NULL,
  judge_model      TEXT NOT NULL,
  agent_model      TEXT,
  conversation_id  TEXT,
  release_reason   TEXT,
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
  attempt      INTEGER,                   -- 机器裁决 = 提交时持有的代次；人工 NULL
  allowed_actions TEXT NOT NULL,          -- JSON：提交时 core 算出的允许集合（审计用）
  evidence_ids TEXT NOT NULL, rule_ids TEXT NOT NULL, judge_call_ids TEXT NOT NULL,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  model_id     TEXT,
  reason       TEXT,                      -- 受限
  created_at   INTEGER NOT NULL,
  UNIQUE(content_id, seq)
);

CREATE TABLE content_state (
  content_id       TEXT PRIMARY KEY,
  effective_action TEXT,                  -- NULL = 尚无裁决（待审初态）
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

CREATE TABLE consumer_log (                     -- 模拟端点：每个事件只处理一次
  event_id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL, content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  result     TEXT NOT NULL,               -- applied | stale | notified
  created_at INTEGER NOT NULL
);
CREATE TABLE downstream_state (                 -- 模拟端点：实际处置状态
  content_id TEXT PRIMARY KEY,
  applied_action TEXT, applied_seq INTEGER NOT NULL DEFAULT 0,
  human_pending INTEGER NOT NULL DEFAULT 0,     -- release 通知只改这个标志
  updated_at INTEGER NOT NULL
);

CREATE TABLE evidence (
  evidence_id  TEXT PRIMARY KEY,          -- "<review_id>#e<n>"
  review_id    TEXT NOT NULL REFERENCES review(review_id),
  attempt      INTEGER NOT NULL,
  kind         TEXT NOT NULL,             -- account_history | thread_context | image_check | similar | rule | judge
  source_ref   TEXT NOT NULL,             -- 白名单：来源引用（数据集 id、规则 id、judge_call_id）
  as_of        INTEGER NOT NULL,          -- 白名单：查询的时间点 = review.created_at
  body_sha     TEXT NOT NULL,             -- 白名单
  body         TEXT NOT NULL,             -- 受限：全文
  model_view   TEXT NOT NULL,             -- 受限：模型看到的受控片段 JSON（§8.5）
  created_at   INTEGER NOT NULL
);

CREATE TABLE judge_call (
  judge_call_id TEXT PRIMARY KEY,
  review_id TEXT, content_id TEXT NOT NULL, attempt INTEGER,
  provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
  input_sha TEXT NOT NULL,                -- sha256(canonical state JSON)：本次判官看到的内容+证据
  question_sha TEXT NOT NULL,             -- sha256(canonical questions JSON)：问题结构与选项
  rule_ids TEXT NOT NULL, rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  status TEXT NOT NULL,                   -- ok | timeout | error | abstain
  raw_probs TEXT, calibrated_probs TEXT, temperature REAL,
  mass_covered REAL,                      -- logprob 判官：返回选项覆盖的概率质量（§9.1 契约）
  shuffle_seed INTEGER, consistency_ok INTEGER,
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cost_fen INTEGER, prices_ver TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE model_call (
  model_call_id TEXT PRIMARY KEY,         -- "<conversation_id>#<generation_task_id>#<n>"
  review_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
  cost_fen INTEGER, cost_status TEXT NOT NULL,  -- settled | estimated | unknown
  prices_ver TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE tool_slot (                        -- 预算占用（§7.5）
  review_id TEXT NOT NULL, call_id TEXT NOT NULL,   -- call_id = Pi ToolCall.id，重放时相同
  attempt INTEGER NOT NULL, tool TEXT NOT NULL,
  reserved_fen INTEGER NOT NULL, settled_fen INTEGER,
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
  closed_at INTEGER, closed_by TEXT,      -- 人工裁决同事务关闭
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
```

要点：
- `ruling.review_id` 主键 = 一审次最多一条裁决；`UNIQUE(content_id, seq)` = 同一内容裁决序号不重复。
- `review` 的 `UNIQUE(content_id, trigger, trigger_request_id)` 是请求幂等的真正依据（§4）。
- `content_state.effective_action` 可为 NULL：待审初态在 S2 时创建行（NULL, 0, hidden），不伪造裁决。
- `audit` 哈希链：`hash = sha256(prev_hash + kind + ref_id + actor + payload + created_at)`；拒绝审计在业务事务回滚**之后**单独提交（§5.3）。

### 2.3 ID 规则

| ID | 格式 | 例子 |
|---|---|---|
| content_id | `<dataset>:<row>` | `coldv1:12345` |
| review_id | `<content_id>#<trigger>#<seq>` | `coldv1:12345#appeal#2` |
| trigger_request_id | fast/suspicious：`= content_id`；appeal/recheck：客户端生成 UUIDv7，重试时重用 | |
| evidence_id | `<review_id>#e<n>` | |
| outbox event_id | `<review_id>#<kind>` | |
| durable requestId | `= review_id` | |
| tool_slot call_id | `= Pi ToolCall.id` | |
| W 实例 id | `w-<hostname>-<pid>-<start_ms>` | |

---

## 3. 审次状态机

### 3.1 状态

```
queued / investigating / disposed / human_queue / human_disposed / failed
```
含义同 v1.0：`disposed` 与 `human_disposed` 是终态；`human_queue` 后机器代次永久失效；`failed` 只在 release 写入本身反复失败时出现。

### 3.2 转换表

| # | 从 | 到 | 触发者 | 前置条件 | 同事务写入 |
|---|---|---|---|---|---|
| S1 | – | disposed | G 快判 | 策略引擎 pass/block | review + ruling(fastpath) + content_state + outbox(ruling) + **intake.judged_review_id** |
| S2 | – | queued | G 快判 | suspicious 且 agent 队列未满 | review + **content_state(NULL,0,hidden)** + intake.judged_review_id |
| S2' | – | human_queue | G 快判 | suspicious 但队列满 / 判官不可用 | review(release_reason) + content_state(初态) + human_queue + outbox(release) + intake.judged_review_id |
| S3 | queued | investigating | W 准入 | 未过 deadline；无活租约或租约已过期 | review(attempt+1, lease_owner, lease_until) |
| S4 | investigating | investigating | W 心跳 | 持有当前代次 | review(lease_until) |
| S5 | investigating | disposed | W dispose | §5 全部通过 | ruling(agent, attempt, allowed_actions) + content_state(条件) + outbox(ruling) + review(state) |
| S6 | investigating | human_queue | W release | 持有当前代次 | review(state, reason, lease_owner=NULL) + human_queue + outbox(release) |
| S7 | investigating | human_queue | G 控制层 | 过 deadline / 预算超限 / 租约过期且 attempts ≥ N | review(lease_owner=NULL, revoked_attempt, state) + human_queue + outbox(release) + worker_command(abort) |
| S8 | investigating | queued | G 控制层 | 租约过期（W 死）且 attempts < N 且未过 deadline | review(lease_owner=NULL, state=queued) |
| S9 | human_queue | human_disposed | 人审页 | 无 ruling；人工授权通过 | ruling(human, attempt NULL) + content_state(条件) + outbox(ruling) + review(state) + **human_queue.closed_at/closed_by** |
| S10 | 终态 | （新审次 queued） | 申诉/重审/规则变更 | 幂等见 §4 T9 | 新 review 行 |
| S11 | queued | human_queue | G 控制层 | queued 里等到过 deadline | 同 S7 无 abort 命令 |

不允许的转换由提交层拒绝并写审计：终态 → 任何；`human_queue → investigating`；任何携带 `attempt ≠ review.attempt` 或 `lease_owner ≠ 当前` 的机器写入。

### 3.3 内容的有效处置

```
effective(content) = ruling with max(seq) among committed rulings of content；无 ruling 时为"尚无"
```
写 ruling 的事务执行：
```sql
UPDATE content_state SET effective_action=?, effective_seq=?, visibility=?, updated_at=?
WHERE content_id=? AND ? > effective_seq;
```
（行在 S1/S2/S2' 已创建。）release 不碰 content_state。

---

## 4. 事务边界

每个编号是 `packages/core/src/review.ts` 的一个函数，内部 `BEGIN IMMEDIATE … COMMIT`，事务内无 await、无网络。

| # | 函数 | 写入 | 幂等性 |
|---|---|---|---|
| T1 | `intakeInsert(content)` | content + intake | content_id 冲突忽略 |
| T2 | `fastDispose(contentId, decision)` | S1 全部，含 intake.judged_review_id | review_id = `<content_id>#fast#1` 冲突 → 读回已有 ruling；G 重试时若 intake.judged_review_id 已非空直接返回该审次，不再二次路由 |
| T2' | `createSuspiciousReview(contentId, pins)` | S2 / S2' | 同上（review_id `<content_id>#suspicious#1`） |
| T3 | `acquireLease(reviewId, workerId, ttl)` | S3 | `WHERE state='queued' OR (state='investigating' AND lease_until < now)`；0 行 → `E_LEASE_HELD`（含 `lease_until`，调用方据此等待） |
| T3' | `renewLease(reviewId, workerId, attempt, ttl)` | S4 | `WHERE lease_owner=? AND attempt=?`；0 行 → `E_LEASE_LOST` |
| T4 | `submitRuling(input)` | S5 / S9 | §5 |
| T5 | `releaseToHuman(reviewId, actor, attempt?, reason)` | S6 / S7 / S11 | 已 human_queue → duplicate；终态 → `E_STATE_INVALID` |
| T6 | `revokeAndRelease(reviewId, reason)` | S7 | command_id `<review_id>#abort#<attempt>` 去重 |
| T7 | `requeue(reviewId)` | S8 | 条件更新 |
| T8 | `outboxMark(eventId, status, nextAt)` | outbox | 条件更新 |
| T9 | `createFollowupReview(contentId, trigger, triggerRequestId, payloadSha)` | S10 | 先查 `(content_id, trigger, trigger_request_id)`：存在且 payload_sha 相同 → 返回原审次；存在且不同 → `E_REQUEST_CONFLICT`；不存在 → seq = max+1 插入。`BEGIN IMMEDIATE` 串行化保证两个不同请求各得一个序号，同一请求重试只得一个审次 |
| T10 | `consumerApply(event)` | consumer_log + downstream_state | event_id 主键去重；`ruling`：`seq > applied_seq` 才应用并写 applied_action/applied_seq，否则 stale；`release`：只置 `human_pending=1`，结果 notified，不比较序号 |
| T11 | `reserveToolSlot(reviewId, attempt, callId, tool, estFen)` | tool_slot | `INSERT OR IGNORE`；新插入后若 `count(status≠'blocked') > budget_tools` 或 `sum(reserved∪settled) > budget_fen` → 改 status=blocked 并返回 `E_BUDGET_EXCEEDED`；已存在 → 返回原状态（重放不重复占用） |
| T12 | `settleToolSlot(reviewId, callId, fen \| null)` | tool_slot | null → status=unknown；条件 `status='reserved'` |
| T13 | `recordModelCall(id, usage, status)` | model_call | 主键去重 |
| T14 | `bumpYield(reviewId, max)` | review.yield_continues | `WHERE yield_continues < max` 返回是否允许 |
| T15 | `appendRejectAudit(...)` | audit | 在业务事务回滚之后独立提交 |

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
  humanAuth?: { reviewerId: string; token: string };
};
```

### 5.2 检查顺序（T4 事务内，首个失败即回滚）

| 步 | 检查 | 错误码 |
|---|---|---|
| 1 | review 存在 | E_REVIEW_NOT_FOUND |
| 2 | 已有 ruling：若 `actor` 相同且（agent 时）`attempt` 相同 → 恢复读取，返回原裁决 `duplicate:true`；否则 → E_STATE_INVALID（终态不可再提交） | – / E_STATE_INVALID |
| 3 | 状态允许：agent 需 `investigating`；human 需 `human_queue`；fastpath 需新建 | E_STATE_INVALID |
| 4 | 身份：agent 需 `lease_owner=workerId AND attempt=review.attempt AND lease_until ≥ now AND revoked_attempt IS NOT attempt`；human 需 `verifyHumanAuth()` | E_LEASE_LOST / E_ATTEMPT_STALE / E_HUMAN_AUTH |
| 5 | 截止：agent 需 `now < deadline_at` | E_DEADLINE_PASSED |
| 6 | 预算：agent 需 tool_slot 汇总未超（§7.5） | E_BUDGET_EXCEEDED |
| 7 | 版本：pins 与 review 行三个版本相等 | E_VERSION_MISMATCH |
| 8 | 规则存在于 rulesVer 且适用 scene；action ∈ 规则 `allowed_actions` | E_RULE_UNKNOWN / E_ACTION_NOT_ALLOWED |
| 9 | 证据归属：每个 evidence 的 review_id = reviewId，attempt ≤ review.attempt | E_EVIDENCE_FOREIGN |
| 10 | 判官归属与指纹：每个 judge_call 的 review_id = reviewId；rules_ver/calib_ver/evidence_ver = pins；`input_sha` 等于 core 对该审次内容+所引证据重算的指纹 | E_JUDGE_FOREIGN |
| 11 | **allowedActions**：`action ∈ allowedActions(review, trustedJudgeCalls, evidence)`（§5.4） | E_ACTION_NOT_SUPPORTED |
| 12 | 写入 S5/S9 | – |

human：跳过 5、6、11（人工可零证据，但 7–10 仍检查）。fastpath：证据只来自 judge_call，11 同样执行。

### 5.3 拒绝审计

T4 失败 → 回滚 → 调用方（同一个 core 函数内）立即 T15 单独提交 `audit(kind='submit_rejected', payload={code, step, reviewId, actor, attempt, action})`。审计不含 reason 与证据正文。测试 D-07 验证回滚后审计行仍存在。

### 5.4 allowedActions（packages/core/src/allowed.ts，纯函数，100% 单测）

输入：审次 pins、`scene`、`has_images`、该审次全部 judge_call、evidence 列表、规则集 `rulesAt(rulesVer)`、校准 `calibAt(calibVer)`。

```
trusted = judge_calls where status='ok' AND calibrated_probs IS NOT NULL
          AND input_sha ∈ fingerprintsOf(review)       // 内容 + 本审次证据的合法指纹集合
          AND question_sha ∈ questionsOf(rulesVer)     // 问题结构属于本版规则
          AND (shuffle 复问存在时 consistency_ok = 1)
for rule r in applicable(scene, rulesVer):
    calls_r = trusted with r.id ∈ rule_ids, 取 created_at 最新一条
    p_r     = calls_r.calibrated_probs[r.question.violation_option]      // 无则 undefined
    exc_r   = for each exception x of r: 最新 trusted judge_call 回答 x.question 的 choice ∈ {applies, not_applies, unknown}；无记录 = unknown
    block_support(r) = p_r ≥ r.thresholds.block AND all(exc_r == not_applies)
    pass_support(r)  = p_r !== undefined AND p_r < r.thresholds.pass
required = requiredCategories(scene) ∪ (has_images ? {image_check} : ∅)
image_ok = !has_images OR exists trusted call with api='clef-mm' AND status='ok'（或去重库命中记录）
allowed = {}
if any block_support(r):      allowed += r.default_action for those r   // takedown 或 limit
if no block_support AND all(required categories have pass_support) AND image_ok AND no trusted call 落在 suspicious 区间 for required:
                               allowed += pass
return allowed   // release 永远允许，不在此集合内
```

规则：
- 高风险证据（p_r ≥ block）→ pass 不在集合；成立的豁免（exc = applies）→ 该规则不支持下架，若无其他规则支持则集合为空，只能 release；低风险全覆盖 → pass 在集合。
- 文本已有 block_support 时，其他类别不要求覆盖（允许提前结束，v2.3 §6.4）。
- 证据 ID 只是引用；授权来自 trusted judge_call 与规则。模型不能通过引用别的证据改变集合。
- 判官调用的 `input_sha` 由 core 在调用前计算并写入 judge_call，提交时重算比对：`sha256(canonical({content_sha, scene, evidence: sorted body_sha of referenced evidence, evidence_ver}))`。
- 集合写入 `ruling.allowed_actions`，便于审计与评测统计。

验收用例 H-17（见 §12）：三条断言同时成立：高风险→pass 拒绝；豁免成立→takedown 拒绝；低风险→pass 通过。

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
| E_BUDGET_EXCEEDED | 409 | |
| E_VERSION_MISMATCH | 409 | |
| E_RULE_UNKNOWN | 422 | |
| E_ACTION_NOT_ALLOWED | 422 | 动作不在规则/场景白名单 |
| E_EVIDENCE_FOREIGN | 422 | |
| E_JUDGE_FOREIGN | 422 | 判官结果不属于本审次或指纹不符 |
| E_ACTION_NOT_SUPPORTED | 422 | 动作不在 allowedActions（附集合与缺失项） |
| E_HUMAN_AUTH | 401 | |
| E_JUDGE_UNAVAILABLE | 503 | fail-closed |
| E_BACKPRESSURE | 429 | |

工具层把错误码作为 `isError:true` 的结果返回给模型，附固定提示（E_ACTION_NOT_SUPPORTED 附 allowed 集合与未满足的必查项）。

---

## 6. 接口

### 6.1 G 的 HTTP（127.0.0.1:8080）

同 v1.0，两处修改：
- `GET /api/reviews/:id` 的 evidence 列表**只返回白名单列**：`evidence_id, kind, source_ref, as_of, body_sha, created_at`。`model_view`、`body`、`ruling.reason` 只在 `/restricted`（需 `X-Reviewer` + `X-Confirm: yes`，写审计）。
- `POST /api/appeals` 请求体必须带 `trigger_request_id`（客户端 UUIDv7）与 `reason_code`；重试重用同一 id。

### 6.2 W 的 HTTP（127.0.0.1:8081）

同 v1.0：`/health`、`/abort`、`/trace/:review_id`。

### 6.3 G ↔ W 通过 app.db

同 v1.0（W 自行取 queued；`ADMIT_MAX` MVP 10；心跳 5s/TTL 30s；G 每 2s 扫描；W 每 500ms 轮询 worker_command）。补充：W 在 T3 得到 `E_LEASE_HELD` 时，把审次放入本地 `pendingTakeover`，到 `lease_until` 后重试，不 abort、不跳过。

### 6.4 人工授权

同 v1.0（`HUMAN_REVIEW_TOKEN` + `config/reviewers.json`，与租约无关）。

### 6.5 判官适配器接口

同 v1.0 的请求/响应 JSON，响应增加 `input_sha`、`question_sha`、`mass_covered`。

---

## 7. 租约、截止、撤权、恢复、预算

### 7.1 时间线

同 v1.0（短文本 deadline 60s；TTL 30s；心跳 5s；G 到期 → T6 → 尽力 abort；迟到 dispose 在 T4 步 2/4 被拒）。

### 7.2 abort 为何只是尽力

同 v1.0：真正的门是 T4；abort 省钱与清理。

### 7.3 W 启动顺序（P0-2）

durable 事实【原文，types.d.ts】：`Harness.open()` 后调度处于 `paused`；`resume()`、`submit()`、`compact()`、`abort()`、`Submission.wait()`、`waitForTask()`、`waitForIdle()` 都会启动调度；`inspect()` 只读、不跑任务代码。

```
0. 单实例锁：data/w.lock（flock）；拿不到 → 退出。确保只有一个 W。
1. open storage（不 resume，不 submit，不 abort，不 wait）。
2. inspect() 读出活任务与未结 submission，映射到 conversation_id。
3. 从 app.db 读所有 conversation_id 非空且 state ∉ 终态 或 durable 仍有活任务的审次，分类：
   a. disposed / human_disposed，durable 仍有活任务      → finalizeOnly：映射 {mode:"finalize", ruling}
   b. human_queue（已撤权）                                → revoked：映射 {mode:"revoked"}；标记待 abort
   c. investigating 且 lease_until ≥ now 且 lease_owner ≠ 我 → pendingTakeover（等租约过期再 T3）；暂不映射
   d. investigating 且租约已过期 / queued 且 durable 有任务  → T3 取新代次；成功 → {mode:"active", attempt}
   e. T3 失败（已被 G 处理）                                → 回到 b 或 a
4. 准入信号量按 active 数量预占。
5. resume()。
6. 对 b 类逐个 conversation.abort()（此时调度已启动，abort 合法）。
7. 对 c 类定时重试 T3；期间 durable 若恢复了该会话的工具调用，工具执行体查映射得到 undefined → 返回 E_LEASE_HELD 错误结果，不提交；并在 afterTool 里 abort 该会话，等待取得租约后再 submit 新 input（requestId 加 `#a<attempt>` 后缀）。
```

执行资格绑定到具体调用（P0-2 第三点）：工具 `execute()` 进入时从映射读 `{mode, attempt}` 并**保存在该调用的局部变量**里，整个调用期间不再重读。映射的更新只在步 3 与"租约丢失 → abort 完成 → 重新 T3"这一条路径上发生，而且重新 T3 之前必须 `conversation.abort()` 并 `waitForIdle()`，保证同一进程内没有旧代次的调用仍在运行。所以旧调用不可能"查到最新 attempt 换上新代次"。

finalize 路径（P0-2 第三点，C 崩溃点）：`dispose` 重跑 → memo 无 → 映射 mode=finalize → 不调 T4 的提交分支，调 `core.readRuling(reviewId)` → memo → 返回 terminate。`release` 同理读 review.state。这是"读取已提交裁决并补收尾"，不是再次申请处置权限。

### 7.4 迟到结果

旧代次的 dispose 在任何路径到达 T4：步 2（已有 ruling 且 actor/attempt 不同）→ E_STATE_INVALID；步 4（撤权）→ E_LEASE_LOST / E_ATTEMPT_STALE。两者都不新增、不覆盖裁决。H-06 的断言改为"被拒绝（两码之一）且 ruling 表不变"。

### 7.5 预算与费用（P0-5）

- 工具次数：`beforeTool(call)` 调 T11 `reserveToolSlot(reviewId, attempt, call.id, call.name, estFen(call.name))`。`call.id` 是 Pi 的 ToolCall.id【原文，pi-ai types.d.ts】，恢复重放时相同，所以 `INSERT OR IGNORE` 天然不重复占用。超限 → `{block: "E_BUDGET_EXCEEDED"}`；此时 `dispose`/`release` 仍放行（它们的 estFen=0 且不计入次数）。
- 费用：`estFen` 来自 `config/prices.yaml` 的保守估计（判官调用按最大输入长度估，工具无模型调用为 0）。`afterTool` 调 T12 结算实际费用（判官返回 usage 时）；超时或无 usage → `unknown`，按 `estFen` 计入占用。预算判断用 `sum(coalesce(settled_fen, reserved_fen))`，即硬预算且保守。
- 主模型费用：`afterResponse(message)` 里取 `message.usage`（pi-ai `Usage` 含 input/output/cacheRead/cacheWrite【原文】），T13 写 model_call，id = `<conversation_id>#<api.taskId>#<n>`（n 为该生成任务内第几次响应，用 `api.memo("n")` 计数，memo 属于该任务【原文，HookApi】，正好匹配）；`cost_fen` 按 prices.yaml 算。主模型调用无法在 `beforeRequest` 阻止（hook 无 block 返回），所以费用超限的处理是：`afterResponse` 发现超限 → 下一次 `beforeTool` block 并由 `afterTools` 触发 release；最多多花一次模型调用，记入评测卡。
- `onYield` 续跑次数：hook memo 属于所在 generation task，**不能**当审次计数；改为 T14 `bumpYield(reviewId, 1)` 写在 review 行。超过 → W 调 T5 release(model_release)。
- 验收 H-22：同轮 3 个工具、已用 11/12 → 只有第 1 个执行，后 2 个 block；工具重放不重复占用；afterResponse 重放不重复记账。

---

## 8. Pi 绑定写法

### 8.1 Harness 打开

同 v1.0 示例，但 `harness.resume()` 移到 §7.3 第 5 步，`settings.compaction.enabled=false`，`toolExecution:"sequential"`（因果可读；预算正确性不依赖它，依赖 T11）。

### 8.2 一审次一会话

同 v1.0：`review.conversation_id` 列 + `harness.createConversation({ownership:{kind:"ownerless"}, agent:{...}})` + `bindConversation()` 条件写回；孤儿会话由 gc 脚本清理。submit 的 `requestId = review_id`（首次代次）或 `review_id#a<attempt>`（重新接管后的新 input），`whenBusy:"reject"`。

### 8.3 工具定义

骨架同 v1.0，三处修改：
1. `execute()` 开头 `const grant = grants.get(api.conversationId)`（§7.3 的映射），整个调用只用 `grant`；`grant === undefined` → 返回 `E_LEASE_HELD` 错误结果。
2. `dispose` 按 `grant.mode` 分支：`finalize` → `core.readRuling` → memo → terminate；`active` → T4 → memo → terminate；`revoked` → 返回 E_LEASE_LOST。
3. 所有取证工具的查询带 `as_of = review.created_at`（§8.5）。

### 8.4 hooks

```ts
hook(ToolTask, {
  beforeTool: async (call, api, ctx) => {
    const grant = grants.get(api.conversationId);
    if (!grant || grant.mode !== "active") return { block: grant ? "E_LEASE_LOST" : "E_LEASE_HELD" };
    if (call.name === "escalate_model" && !FLAGS.escalation) return { block: "escalation disabled" };
    if (!ALLOWED_TOOLS.has(call.name)) return { block: "tool not allowed" };
    const st = core.leaseStatus(grant.reviewId, WORKER_ID, grant.attempt);
    if (!st.held) return { block: "E_LEASE_LOST" };
    if (st.deadlinePassed) return { block: "E_DEADLINE_PASSED" };
    const r = core.reserveToolSlot(grant.reviewId, grant.attempt, call.id, call.name, estFen(call.name));   // T11
    if (!r.ok) return { block: `E_BUDGET_EXCEEDED: 只能 release 或 dispose` };
    return undefined;
  },
  afterTool: async (call, result, api, ctx) => {
    const grant = grants.get(api.conversationId); if (!grant) return undefined;
    core.settleToolSlot(grant.reviewId, call.id, feeOf(result));                                            // T12
    return undefined;
  },
}),
hook(GenerationTask, {
  afterResponse: async (message, api, ctx) => {
    const grant = grants.get(api.conversationId); if (!grant) return;
    const n = (await api.memo<number>("n", ctx)) ?? 0; await api.memo("n", n + 1, ctx);
    core.recordModelCall(`${api.conversationId}#${api.taskId}#${n}`, grant, message.usage);                 // T13
  },
  afterTools: async (_a, _r, api, ctx) => {
    const grant = grants.get(api.conversationId); if (!grant) return;
    const st = core.leaseStatus(grant.reviewId, WORKER_ID, grant.attempt);
    if (!st.held || st.budgetExceeded) await releaseAndAbort(grant, st.held ? "budget" : "revoked");
  },
  onYield: async (answer, api, ctx) => {
    const grant = grants.get(api.conversationId); if (!grant || grant.mode !== "active") return undefined;
    if (core.hasTerminal(grant.reviewId)) return undefined;
    if (core.bumpYield(grant.reviewId, 1)) return { continue: "你必须调用 dispose 或 release 结束本审次。" };   // T14
    await releaseAndAbort(grant, "model_release");
    return undefined;
  },
}),
```

`releaseAndAbort`：T5 → memo → `conversation.abort()`（通过 `api.conversation(id)` 的句柄）。

### 8.5 证据：模型可见片段与白名单（P0-6）

两条边界分开：
- **模型/判官看到的**（`evidence.model_view`，受限存储）：完成判断所必需的受控原文片段与结构化事实。规则：

| 工具 | model_view 内容 | as-of 实现 |
|---|---|---|
| get_thread_context | 前后各 N=3 条评论：`{content_id, text（截断 200 字）, account_id, created_at, prior_effective_action}`，整体标 `untrusted:true` | `content.created_at ≤ review.created_at`；`prior_effective_action` = 该邻居在 `review.created_at` 之前最后一条 ruling 的 action（查 ruling 表 `created_at ≤ as_of`，不读 content_state） |
| get_account_history | 结构化：近 7 天各动作计数、最近 5 条裁决 `{seq, action, rule_ids, created_at}`、申诉次数 | synth 事件表 `event_time ≤ review.created_at`；ruling 表同上 |
| find_similar_dispositions | 近邻列表 `{content_id, simhash_distance, action_as_of, created_at}` | ruling `created_at ≤ as_of` |
| load_rule | 规则正文与例外全文（可信通道，不标 untrusted） | 按 rules_ver |
| get_image | 图片给判官（Clef）；若主模型有视觉能力，也可把图作为内容块给主模型（§13.3） | 图片不可变 |
| judge | 判官输入 = 内容原文 + 所引证据的 model_view；返回校准概率 | 由 input_sha 固定 |

- **日志/仪表盘/普通 API 看到的**（白名单列）：`evidence_id, kind, source_ref, as_of, body_sha, created_at`。没有 summary，没有 model_view。
- 评测各组的隔离仍靠独立 app.db（§11.3）；as-of 查询保证同一库内后创建的裁决不会被先创建的审次看到。验收 H-21：创建审次后插入新裁决与新历史事件，旧审次的工具结果不变。
- 开发者不读样本正文的铁律（v2.3 §8.4）约束的是人，不约束模型；model_view 的调试查看走 `/restricted` 并写审计。

---

## 9. 判官适配器与策略引擎

### 9.1 classifier API

**Jev 已可用（2026-10-08 实测）**：负责人提供的渠道是原生 System One 协议（`POST <base>/systemone`），返回 `jev-1.13.0`，choice 概率 + noul，单次 0.24–0.32s，约 480 输入 token/次；按官方渠道使用。接入方式：pi-ai 内置 `typesafe-system-one` API，`createProvider` 注册一个 `type:"classifier"` 模型条目指向 `JEV_BASE_URL` 即可，**不需要自写适配器**。自写的三个 API 保留：`openai-logprob`（判官基准对照与 agent 内复判）、`laya-batch`、`clef-mm`。MVP 的入口判官改为 Jev（最少代码、延迟达标）；阶段 3 的停止条件对 Jev 同样适用。实测 4 条自写中文评论方向正确但概率全在 0.99–1.00，校准步骤不能省。

其余同 v1.0。补充 **openai-logprob 适配器契约**：
- 提示构造同 pi-ai `llama-cpp-classify`：选项标签为单个 ASCII 大写字母，`max_tokens:1`，`logprobs:true, top_logprobs:20`。
- 解析：对每个选项标签，匹配 top_logprobs 中 token 去除前导空格后等于该字母的条目；多个匹配取 logprob 最大者；未出现的选项**不视为 0**。
- `mass_covered = Σ exp(logprob of matched options)`。若 `mass_covered < 0.5`【估计阈值，开发集校准】或匹配到的选项数 < 2 → `status: "abstain"`，不输出概率；否则在匹配到的选项上归一化，并把 `mass_covered` 写入 judge_call。
- 返回的首个 token 不是任何标签（例如模型输出了汉字）→ `abstain`。
- `abstain` 在策略引擎与 allowedActions 中都不是可信结果；连续 abstain 比例是运营指标。

### 9.2 校准

同 v1.0（温度缩放；桶键 = 判官 × 规则版本 × 场景 × 选项数；无校准只允许 suspicious；isotonic ≥1,000；边界 ±0.05 复问）。

### 9.3 策略引擎

同 v1.0（纯函数；judge_down → suspicious；含图 pass 必须等图检）。引擎与 allowedActions 共用同一套阈值读取函数，避免 G 与 W 两套口径。

---

## 10. 规则、校准、版本固定

同 v1.0 的版本号来源、审次固定、灰度分桶、工具代码不热换。两处修改：

- **影子回放分两类**（`policy/shadow.ts` 按规则 diff 自动分类）：

| 变更类型 | 判定方法 | 影子做法 |
|---|---|---|
| 只改 thresholds / scenes / default_action / 路由 | `question`、`text`、`exceptions` 的 sha 不变 | 复用旧 judge_call 的校准概率重算三态 |
| 改 text / exceptions / question / 选项 | 任一 sha 变化 | 对影子样本用固定证据（同 input_sha 的内容+证据）**重新调用判官**；费用计入影子报告 |

演示场景 2 用第一类（阈值变化）时如实标注"复用旧分数"；若演示规则语义变化，必须走第二类。
- **发布门槛绑定配置**：`scripts/release-gate.ts` 写 `gate_run(config_sha=sha256(rules_ver+calib_ver+judge_model+agent_model+prices_ver), passed, report)`；`/api/rules/rollout` 要求存在 `passed=1` 且 `config_sha` 等于当前准备发布配置的记录，否则 409。
- contract tests 两层：日常 CI 用录制响应（验证结构、路由、阈值、权限）；规则发布前 `pnpm run contract:real` 用真实判官对**变化的规则**跑 contract tests 与该类回归池，结果进 gate_run 报告。

---

## 11. 评测执行协议

### 11.1 数据冻结、11.2 疑似集冻结

同 v1.0。

### 11.3 四组运行器

| 组 | 实现 |
|---|---|
| B | 判官一次 |
| B+ | 固定取证 → 全部证据 model_view + 内容 → 判官一次 |
| A | **在 W 内以脚本驱动模式运行**（`worker/src/scripted.ts`）：同样的审次生命周期（T3 租约、deadline、T11 预算、hooks、T4 校验、allowedActions），区别只是工具调用顺序由脚本固定（历史 → 线程 → 相似 → 规则 → judge），然后主模型一次判断并调用 dispose/release |
| C | 完整 W：模型按需选工具 |

A 与 C 的差别只有"谁决定下一个工具"，提交权限、预算、截止、模型完全相同。

执行约束：`FLAG_ESCALATION=false`；主模型固定；各组独立环境——基线用 `sqlite3 app.base.db ".backup app.<group>.db"`（在线备份 API，避免 WAL 未检查点的提交丢失）；每组独立 `SESSION_DB`、`OUT_DIR`、判官响应缓存命名空间 `CACHE_NS=<group>`；人审配额 K/千条固定；终态校验三层（§11.5）。

### 11.4 统计与指标分母

| 指标 | 分子 | 分母 | 备注 |
|---|---|---|---|
| 自动误放率（按违规） | 被自动放行的违规样本 | 全部违规样本 | 主指标 |
| 自动放行精度缺口 | 被自动放行的违规样本 | 全部自动放行样本 | 解释指标 |
| 自动误拦率（按正常） | 被自动拦截/限流的正常样本 | 全部正常样本 | 主指标 |
| 自动完成覆盖率 | 自动形成裁决的样本 | 疑似集全部样本 | |
| 转人审量 | release 样本 | 疑似集全部样本 | 超配额未处理另列"待处理" |
| 完整耗时 p50/p95 | 审次创建 → 裁决或 release | 自动完成样本 | 转人审样本另列 |
| 成本（分/条） | 判官 + 主模型 + 工具结算（unknown 按估计计入并标注） | 疑似集全部样本 | |

转人审与未完成样本在质量指标里不作为"正确"，单独一列。配对 McNemar 按样本配对；Wilson 区间；按案例族/类别/场景分层。评测卡字段缺一报错。

### 11.5 harness 赛道与对账（含守恒检查）

`scripts/reconcile.ts` 断言：
1. 不重复：同 review_id ruling ≤ 1；同 event_id consumer_log ≤ 1。
2. **守恒**：intake 中每个 `status='judged'` 的 content_id 都有 `judged_review_id`；每个非终态审次都处于 `queued`（无租约或租约有效）/ `investigating`（租约有效）/ `human_queue`（有未关闭 human_queue 行）之一；没有"状态是 investigating 且租约过期超过 2 个扫描周期"的行；没有 `conversation_id` 非空但 durable 里既无活任务也无终结 memo 的 active 审次。
3. **三层一致**：`content_state.effective_seq` = ruling 的 max(seq)；durable 的 dispose/release memo 存在当且仅当对应审次为终态或 human_queue；`downstream_state.applied_seq` = 已 acked 的 ruling 事件的 max(seq)，`human_pending` 与 human_queue 未关闭行一致。
4. 终结：故障解除后等待 ≤ 3 × deadline，测试任务全部到达终态或 human_queue。

崩溃矩阵、判官超时、2× 回放、注入同 v1.0。

---

## 12. 测试用例目录与 CI

### 12.1 单元

U-01…U-08 同 v1.0；新增 U-09 `allowed.ts`（§5.4 全分支）、U-10 logprob 解析契约（缺选项、多 token、前导空格、质量不足 → abstain）、U-11 `shadow.ts` 变更分类。

### 12.2 core 集成（真实 SQLite）

D-01…D-06 同 v1.0；新增 D-07 拒绝审计在回滚后仍存在；D-08 T9 同请求标识重试返回原审次、不同内容 → E_REQUEST_CONFLICT、两个不同请求得两个序号；D-09 content_state 待审初态 NULL/0；D-10 T10 release 后 ruling 同 seq 仍应用，重放 release 与旧 ruling 不改变 downstream_state；D-11 T11 重放同 call_id 不重复占用；D-12 两进程竞争：一个进程持写锁 3s，另一进程 busy_timeout 内拿到或得到 SQLITE_BUSY 后有限重试成功，心跳延迟不超过 TTL/2。

### 12.3 harness 不变量（faux provider + 录制判官）

H-01…H-16 同 v1.0（H-06 断言按 §7.4 修改）。新增：

| ID | 用例 | 证明 |
|---|---|---|
| H-17 | 完整高风险证据 → dispose(pass) 拒绝；豁免成立 → dispose(takedown) 拒绝；低风险 → pass 通过 | 权限门检查结论 |
| H-18 | 申诉请求重试（响应丢失后重发同 trigger_request_id） | 只一个审次 |
| H-19 | release → 人工裁决 → 重放 release → 重放旧 ruling | 下游终态 = 最新有效裁决 |
| H-20 | 旧租约未到期时立即重启 W | 审次进入 pendingTakeover，租约到期后接管完成，不被 abort |
| H-21 | 创建审次后插入新裁决与新历史事件 | 旧审次工具结果不变（as-of） |
| H-22 | 同轮 3 工具、已用 11/12；工具重放；afterResponse 重放 | 预算不超发、不重复记账 |
| H-23 | CRASH_AT=C 后恢复（finalize 路径） | 读回裁决、补 memo、会话终结、ruling=1 |
| H-24 | 守恒与三层一致（§11.5）在每个崩溃用例后运行 | 零丢失 |

### 12.4 contract tests 夹具

- 数据集引用：`fixtures/refs.yaml` 存 `{fixture_id, dataset, row, sha256(text)}`；`scripts/fetch-fixtures.sh` 在 CI 里从公开源拉取（COLD：GitHub，Apache-2.0；ChineseHarm-Bench：HF，CC BY-NC，评测用途）到 `data/fixtures/`（不进 git），并校验 sha256。拉不到 → 该夹具 skip 并在 CI 摘要列出，不算通过。
- 自写无害夹具（注入话术、正常引用、合规付款码描述等）直接存 `fixtures/benign/*.txt`，由模型生成，内容不含辱骂与暴力。
- 两层运行：`pnpm run contract`（录制响应）进 CI；`pnpm run contract:real` 发布前手动。

### 12.5 真实模型 e2e

同 v1.0（默认跳过）。

### 12.6 CI

```yaml
name: ci
on: [push, pull_request]
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 12 }
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
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - run: uv python install 3.11
      - run: uv sync
      - run: uv run pytest python -q
```

`redact-scan` 是启发式提示（连续 ≥20 个 CJK 字符且不在 docs/、rules/、fixtures/benign/ 下），不是泄漏边界；真正的边界是 §8.5 的白名单列、夹具管理（§12.4）与 `/restricted` 的访问审计。

---

## 13. 部署与配置

### 13.1 开发机、13.2 进程与启动

同 v1.0。`.env` 清单以仓库根 `.env.example` 为准（按需要的周次排列）。

### 13.3 中转站 provider 与模型能力

- pi-ai `createProvider`，OpenAI 兼容，`baseUrl: RELAY_BASE_URL`；模型名与 `max_tokens` 上限按实测写 `config/models.json`。
- 视觉能力【用户口述，待逐个实测】：中转站上除 glm-5.3 外的模型都支持图片输入。影响：(a) `AGENT_MODEL` 若有视觉，`get_image` 可把图作为内容块给主模型做语义证据；(b) 自动放行所需的"图片检查"仍必须是校准判官（Clef）的 `judge_call`，因为视觉模型不返回 logprobs【实测】，没有可校准概率；(c) 替开发者判定图片数据集样本用 `VISION_CHECK_MODEL`（.env 新增），文本仍用 glm-5.3-flash。
- 费用：`config/prices.yaml` 记每模型每百万 token 的人民币分，版本化。

### 13.4 日志与脱敏、13.5 密钥

同 v1.0。旧机器已报废，密钥由负责人按 `.env.example` 填入新机。

---

## 14. 开工顺序与停止条件（替代 v1.0 的 14 天表）

不再给精确日程。阶段按依赖排序，每阶段有通过条件与停止条件；10-22 演示范围按阶段实际完成度裁剪，不把未成立的恢复或权限检查包装成已完成。

| 阶段 | 做 | 通过条件 | 停止条件（触发则停下修，不进下一阶段） |
|---|---|---|---|
| 0 接口与夹具 | workspace、tsconfig、core 类型与 errors、schema.sql、fixtures/refs.yaml + fetch 脚本、CI 骨架 | `pnpm run check` 过；CI 绿（空测试） | – |
| 1 core 语义 | T1–T15、states、allowed.ts、submit-check、budget、consumer | U-01–U-11、D-01–D-12 全过 | D-08/D-10/D-12 任一不过 |
| 2 Pi 最小验证 | harness.ts、startup.ts（§7.3）、tools（dispose/release/load_rule/线程/历史）、hooks、faux 驱动 | H-01、H-02、H-03、H-06、H-17、H-18、H-19、H-20、H-22、H-23、H-24 过；`inspect()` 证明 resume 前无任务启动 | Pi 1.0.4 下任一 H 用例无法实现 → 记录原因，评估 Plan B（AgentSession + sink 幂等）或改设计，不绕过 |
| 3 真实模型 | Jev 入口判官（内置适配器）+ 录制；openai-logprob 判官 + 契约（对照用）；策略引擎；规则 ABUSE 3 条；主模型接入 | E-03 冒烟；contract 100%；E-01 20 条终态一致 | 判官 abstain 率 > 30%【估计阈值】→ 换判官模型再继续 |
| 4 回放与界面 | G intake/预处理/快判/S1/S2/S2'/outbox；控制层；/api/metrics 与静态页；人审页最简 | 回放 500 条；H-14 过；H-24 在回放后通过 | – |
| 5 故障、效果、演示 | crash-matrix ≥ 20 次；注入 H-16；synth C0–C3；版本切换 H-12；演示 3、5、1 降速、2 简版 | 四个演示各走一遍；reconcile 全绿 | – |

阶段 0–2 预计 6–8 天【估计】，是最可能超期的部分；超期则 10-24 录屏只演示场景 3 与 5。

---

## 15. 开工前验证清单

1. durable 骨架与启动顺序：`Harness.open` → `inspect()` → 断言 `scheduling === "paused"` 且无任务被执行 → `resume()`；faux 下 10 会话 kill 10 次。
2. node:sqlite 竞争：D-12 的场景（持锁 3s、busy_timeout、重试、事件循环阻塞时长），结论写成"竞争后仍正确、可恢复"的测试，不写"不报 BUSY"。
3. 中转站：主模型 tool call 往返；qwen3.8-flash top_logprobs；各模型图片输入能力逐个实测并写入 `config/models.json`。
4. configure() 下一请求生效。
5. 数据重叠与计数；云厂商调 1 条。
6. Clef onPayload 透传（W4 前）。

---

## 附录 Y 第五轮审查（开发文档 v1.0）处理记录

| 审查项 | 处理 | 落点 |
|---|---|---|
| P0-1 放行检查不验证"证据支持放行" | 采纳。新增 allowedActions 纯函数；judge_call 加 input_sha/question_sha/evidence_ver/attempt；ruling 存 allowed_actions；三条断言的 H-17 | §5.4、§2.2、§12.3 |
| P0-2 恢复顺序与租约衔接 | 采纳。核对 Pi：open 后 scheduling=paused，submit/abort/wait 都启动调度，inspect 只读。固定 7 步启动顺序；审次分类 a–e；pendingTakeover 不 abort；finalize 独立路径；执行资格绑定到调用局部变量，重新接管前必须 abort + waitForIdle | §7.3、§8.3、§8.4、H-20、H-23 |
| P0-3 序号唯一 ≠ 请求幂等 | 采纳。review 加 trigger_request_id + payload_sha，UNIQUE(content_id, trigger, trigger_request_id)；T9 三分支；fast/suspicious 的标识 = content_id；intake.judged_review_id 完成标记与审次创建同事务 | §2.2、§4 T2/T2'/T9、D-08、H-18 |
| P0-4 release 事件挡住人工裁决 | 采纳。outbox_consumer 拆为 consumer_log + downstream_state；release 只置 human_pending；ruling 比序号；S9 同事务关闭 human_queue | §2.2、§4 T10、§3.2 S9、D-10、H-19 |
| P0-5 预算整轮后更新 | 采纳。tool_slot 按 ToolCall.id 原子占用（T11）、结算（T12）、unknown 按估计计入；model_call 记账（T13）；onYield 计数改审次行（T14）；核对 HookApi memo 属于所在任务 | §7.5、§8.4、D-11、H-22 |
| P0-6 证据语义不足与快照只是标签 | 采纳，实现选 as-of 查询而非物理快照：evidence 加 as_of 与 model_view（受限）；普通 API 只返回白名单列；get_thread_context 给截断原文；prior action 按 ruling.created_at ≤ as_of | §8.5、§6.1、H-21 |
| 待审初态 | 采纳：effective_action 可 NULL，S2 创建初态行 | §2.2、§3.2、D-09 |
| 拒绝审计 | 采纳：回滚后独立提交 T15 | §5.3、D-07 |
| 幂等返回与 H-06 冲突 | 采纳：步 2 区分恢复读取（同 actor+attempt）与新提交 | §5.2、§7.4 |
| logprob 解析契约 | 采纳：mass_covered、abstain 规则、不把缺失选项当 0 | §9.1、U-10 |
| 费用单位 | 采纳：统一人民币分 + prices.yaml 版本化 | §2、§7.5 |
| 数据库锁验证 | 采纳：改为竞争后正确性测试 D-12 | §12.2、§15.2 |
| 影子回放两类变更 | 采纳 | §10 |
| 发布门槛绑定配置 | 采纳：gate_run.config_sha | §10、§2.2 |
| contract tests 两层 | 采纳 | §10、§12.4 |
| A 组对齐执行限制 | 采纳：A 作为 W 的脚本驱动模式 | §11.3 |
| 指标分母 | 采纳：两种口径分名，待处理单列 | §11.4 |
| 环境隔离含 WAL 与 session | 采纳：`.backup` + 独立 SESSION_DB/OUT_DIR/CACHE_NS | §11.3 |
| 零丢失需守恒检查 | 采纳：reconcile 四类断言，H-24 | §11.5 |
| CI YAML 错误、夹具、redact-scan 定性 | 采纳：改 `with:`；fetch-fixtures；扫描降为启发式 | §12.4、§12.6 |
| 14 天表按依赖调整 | 采纳：改为 6 阶段 + 通过/停止条件 | §14 |

未完全照搬的一处：P0-6 建议"每个审次绑定不可变证据清单和快照"，本文用 as-of 时间点查询实现同样的不变性（数据集与合成事件本身不可变，裁决按 created_at 过滤），避免为每个审次复制快照；验收 H-21 覆盖该保证。若实现中发现 as-of 查不干净（例如 content 表被回放器更新），再改物理快照。

## 附录 Z 与 v2.3 的差异记录

| 项 | v2.3 | 本文 | 理由 |
|---|---|---|---|
| 准入并发 | ≤20 | MVP 10，8 周目标 20 | 2 核 4G【实测】 |
| 短文本机器截止 | agent p95 ≤30s（验收） | deadline 60s | 硬边界给 2 倍余量 |
| review_id → conversation_id 索引位置 | durable commit 内 ReviewIndex | app.db 列，durable 文档族备选 | G 需要可见 |
| 工具执行模式 | 未写 | sequential | 轨迹可读；预算不依赖它 |
| 14 天 MVP 排期 | §11.1 | 改为阶段 + 停止条件 | 第五轮审查 |
| 费用单位 | 元 / 美元混用 | 人民币分 | 第五轮审查 |
