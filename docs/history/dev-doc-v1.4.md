# 开发文档 v1.4：pi-moderation-agent

日期：2026-10-07。基于冻结的项目文档 `docs/project-doc-v2.md` v2.3。v1.4 对 v1.3 做定点修订，并入第八轮外部审查（`docs/reviews/round-8-dev-doc-v1.3-review.md`，基于 afbf267）的 13 项检查；处理记录见附录 V。v1.3 并入第七轮自审（附录 X）。历史版本在 `docs/history/`（v1.0–v1.3）。**本文自包含。** 按第八轮意见，此后不再整篇重写：阶段 1 起每个问题对应一个先失败、修复后通过的测试。

写法约定：
- 与 v2.3 冲突时以 v2.3 为准，并在附录 Z 记录。
- Pi 的 API 名称、签名均来自 `@earendil-works/pi-durable@1.0.4` 与 `@earendil-works/pi-ai@1.0.4` 的 `dist/*.d.ts`、README 与同版本源码（2026-10-08/09 核对）。【原文】= 可在这些来源中找到的原句；【源码】= 只在同版本 src 中确认；【待核】= 未验证；【实测】= 本机或开发机跑过；【估计】= 拍的。
- 正文（content text）在本文、代码、日志、普通 API、测试断言里都用 `content_ref`（sha256）或 fixture ID 引用。模型与判官可以读到受控原文片段（§8.5），这是两条不同的边界。

---

## 0. 本文回答的问题

| 问题 | 章节 |
|---|---|
| 仓库长什么样，谁负责什么 | §1 |
| app.db 有哪些表，谁写谁读 | §2 |
| 审次状态如何转换，谁有权触发 | §3 |
| 哪些写入必须在同一事务 | §4 |
| 提交裁决检查什么、哪个判官答案是当前依据、allowedActions 怎么算 | §5 |
| G、W、人审页、运营 CLI 之间的接口 | §6 |
| W 启动屏障、执行资格、租约、撤权、abort、重放与重启的区别 | §7 |
| 预算与费用记账（硬限制与软限制） | §7.5 |
| Pi 的哪些 API 用在哪，怎么写 | §8 |
| 判官适配器（含 Jev 接入、logprob 契约）与策略引擎 | §9 |
| 规则、校准、版本固定、影子回放的两类变更 | §10 |
| 评测执行协议与指标定义 | §11 |
| 测试用例目录、夹具、CI | §12 |
| 部署、配置、密钥、日志、SQLite 使用规则 | §13 |
| 分阶段开工顺序与停止条件 | §14 |
| 开工前验证清单 | §15 |
| v2.3 契约覆盖表（机制 → 用例 → 阶段/周次） | 附录 W |
| 第八轮审查处理记录 | 附录 V |

---

## 1. 仓库结构与职责

```
pi-moderation-agent/
├── package.json              # pnpm workspace 根；脚本：check / test / contract / redact-scan / g / w
├── pnpm-workspace.yaml       # allowBuilds（pnpm 12）
├── tsconfig.base.json, tsconfig.json
├── packages/
│   ├── core/                 # 无 Pi 依赖：DDL、状态机、有效判官答案、allowedActions、校验、预算、控制循环、投递、消费端、对账、错误码、脱敏、价格
│   │   └── src/{db.ts, schema.sql, review.ts, states.ts, effective.ts, allowed.ts, submit-check.ts, budget.ts,
│   │            control.ts, outbox.ts, consumer.ts, reconcile.ts, errors.ts, ids.ts, redact.ts, prices.ts, intake-cli.ts}
│   ├── judges/               # 判官适配器：Jev（pi-ai 内置 typesafe-system-one）、openai-logprob、laya-batch、clef-mm；校准；录制
│   ├── policy/               # 规则 YAML、策略引擎三态、版本固定、contract tests 运行器、影子回放分类
│   ├── gateway/              # 进程 G：队列、预处理、快判、定时调用 core 的控制循环与 dispatcher、HTTP
│   ├── worker/               # 进程 W：pi-durable Harness、启动屏障、执行资格表、moderation 扩展、宿主控制循环、A 组脚本驱动
│   │   └── src/{main.ts, startup.ts, grants.ts, harness.ts, host-loop.ts, extension/{tools.ts, hooks.ts, sections.ts, guard.ts}, scripted.ts}
│   ├── ops/                  # pi coding-agent 扩展：/shadow /rollout /status /calib（调 G 的 HTTP）
│   └── inspect/              # 调试 CLI：脱敏打印审次、轨迹、账本
├── rules/                    # 规则 YAML（git 版本化）+ mapping.yaml
├── calib/                    # calib/<judge>/<rule>@<ver>.json
├── config/                   # scenes.yaml（场景 → 必查类别、动作白名单、可见性、截止、严重度）、models.json、prices.yaml、reviewers.json
├── fixtures/                 # refs.yaml（公开数据集引用）+ benign/（自写无害文本）
├── python/{synth,eval,replay}/   # uv 项目：合成数据、评测运行器与统计、回放器（通过 core 的 intake-cli 写入，见 §13.6）
├── test/{unit,harness,e2e,fault}/
├── scripts/                  # start/kill/backup/fetch-fixtures/release-gate/crash-matrix/gc-sessions
├── docs/{project-doc-v2.md, dev-doc-v1.md, history/, reviews/}
└── .github/workflows/ci.yml
```

职责边界：
- `core` 是唯一允许写 app.db 业务表的地方。G、W、人审页、运营 CLI、测试驱动、**Python 回放器**（经 `intake-cli`，§13.6）全部通过 core 的函数写。控制循环的一次扫描（`control.tick()`）、outbox 投递一步（`outbox.dispatchOnce()`）、模拟消费端（`consumer.apply()`）、对账（`reconcile.instant()` / `reconcile.final()`）都是 core 的函数，G 只是定时调用它们，测试可以直接调用。
- `worker` 独占 `session.sqlite`（durable 文档：一个进程拥有一个存储，无跨进程锁【原文】）。G 永远不打开 session.sqlite；对账的 durable 侧检查按 §11.5 的两种模式进行。
- core 里不在 §4 事务表中的辅助函数（只读或单行写）：`leaseStatus`、`usedToolSlots`、`unknownReserved`、`hasTerminal`、`readRuling`、`bindConversation`（条件写 review.conversation_id / submission_id）、`verifyHumanAuth`、`fingerprintsOf`、`questionsOf`。

技术栈固定：Node 22.23.3【实测】、pnpm 12.9.1【实测】、TypeScript 5.9、SQLite 用 Node 内置 `node:sqlite`（同步 `DatabaseSync`；使用规则见 §13.5）、Vitest 3、TypeBox（pi-ai 已带）。Python 3.11.17 + uv【实测】。骨架已搭好并通过 `pnpm run check`【实测 2026-10-08】。

---

## 2. 数据模型（app.db）

app.db 是唯一业务事实源（v2.3 §5.3）。SQLite WAL，`synchronous=NORMAL`。时间为毫秒整数。**费用内部单位微元（10⁻⁶ 元，整数）**，单价来自 `config/prices.yaml`（`prices@<sha>`）；展示换算成元/分。

### 2.1 表清单与读写方

| 表 | 作用 | 写 | 读 |
|---|---|---|---|
| ledger_seq | 全局入库序号（单行计数器） | 所有写 ruling / synth_event / content 的事务 | 审次创建（取边界） |
| content | 原始内容（受限存储），带 ingest_seq | 回放器（经 intake-cli） | G 预处理、W 工具（受控片段）、受限视图 |
| synth_event | 合成账号事件，带业务时间与 ingest_seq | synth 导入（经 intake-cli） | W 工具（as-of） |
| intake | 接入队列（含完成标记） | 回放器、G | G、守恒检查 |
| review | 审次记录 | G、W、人审页（经 core） | 全部 |
| ruling | 已提交裁决（PK review_id），带 ingest_seq | G 快判、W dispose、人审页 | 全部 |
| content_state | 内容的当前有效裁决（可为"尚无"） | 与 ruling / 审次创建同事务（upsert） | 仪表盘 |
| outbox | 待投递事件 | 与 ruling / release 同事务 | dispatcher |
| delivery_receipt | 模拟端点每次收到投递的收据（含重复） | consumer.apply | 对账 |
| consumer_log | 模拟端点的消费结果（event_id 去重） | consumer.apply | 对账 |
| downstream_state | 模拟端点的内容处置状态 | consumer.apply | 对账 |
| downstream_human | 模拟端点的人审待办，按审次 | consumer.apply | 对账 |
| evidence | 证据（白名单元数据 + 受限全文与模型片段） | W 工具 | W、受限视图；普通 API 只读白名单列 |
| judge_call | 每次判官调用（调用级：输入指纹、证据集合、状态、延迟、费用） | G、W | 评测、费用 |
| judge_answer | 判官调用里的每个问题的答案（问题指纹、choice、概率） | 与 judge_call 同事务 | effective、allowedActions |
| model_call | 主模型每个 generation task 的逻辑记录 | W hooks | 评测对账 |
| tool_slot | 每次逻辑工具调用的额度占用（硬限制） | W（经 core） | 预算 |
| tool_request | 每次物理外发请求的账单（结算按请求幂等） | W（经 core） | 预算、费用对账 |
| worker_command | G → W 控制命令 | G | W 轮询 |
| human_queue | 人审队列（含关闭标记） | 与 release / 人工裁决同事务 | 人审页 |
| feedback | 人审标注回流 | 人审页 | 校准器 |
| audit | 追加写审计（哈希链） | core 的独立提交 | 审计 |
| version_pin | 规则/校准/价格版本注册表 | G 热加载时 | W 按审次读取 |
| gate_run | 发布门槛运行记录（绑定配置指纹） | scripts/release-gate | /api/rules/rollout |
| metrics_minute | 每分钟聚合指标（字段见 §6.1） | G | 仪表盘 |

### 2.2 DDL

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
-- busy_timeout 与 foreign_keys 按连接设置，见 §13.5

CREATE TABLE ledger_seq (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
INSERT INTO ledger_seq VALUES (1, 0);
-- 取号：UPDATE ledger_seq SET value=value+1 WHERE id=1 RETURNING value;（同一事务，BEGIN IMMEDIATE 下串行）

CREATE TABLE content (
  content_id   TEXT PRIMARY KEY,
  scene        TEXT NOT NULL CHECK(scene IN ('comment','danmaku','nickname','post','image')),
  text_sha     TEXT,                      -- sha256(归一化文本)，给 simhash/去重与 input_sha 用
  text         TEXT,                      -- 受限
  image_refs   TEXT,
  account_id   TEXT, thread_id TEXT,
  event_time   INTEGER NOT NULL,          -- 业务时间
  ingest_seq   INTEGER NOT NULL,          -- 入库序号
  created_at   INTEGER NOT NULL
);
CREATE INDEX content_thread ON content(thread_id, event_time);
CREATE INDEX content_account ON content(account_id, event_time);

CREATE TABLE synth_event (
  event_id   TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK(kind IN ('prior_ruling','appeal','post','warning')),
  payload    TEXT NOT NULL,
  event_time INTEGER NOT NULL, ingest_seq INTEGER NOT NULL
);
CREATE INDEX synth_event_acct ON synth_event(account_id, event_time);

CREATE TABLE intake (
  content_id   TEXT PRIMARY KEY REFERENCES content(content_id),
  prio         INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL CHECK(status IN ('received','preprocessed','judged')),
  judged_review_id TEXT,                  -- 完成标记，与审次创建同事务写
  lease_owner  TEXT, lease_until INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX intake_status ON intake(status, prio, created_at);

CREATE TABLE review (
  review_id        TEXT PRIMARY KEY,      -- "<content_id>#<trigger>#<seq>"
  content_id       TEXT NOT NULL REFERENCES content(content_id),
  seq              INTEGER NOT NULL,
  trigger          TEXT NOT NULL CHECK(trigger IN ('fast','suspicious','appeal','recheck','rule_change')),
  trigger_request_id TEXT NOT NULL,       -- §2.3
  trigger_payload_sha TEXT NOT NULL,
  state            TEXT NOT NULL CHECK(state IN ('queued','investigating','disposed','human_queue','human_disposed')),
  attempt          INTEGER NOT NULL DEFAULT 0,
  lease_owner      TEXT, lease_until INTEGER,
  revoked_attempt  INTEGER,
  deadline_at      INTEGER,
  snapshot_seq     INTEGER NOT NULL,      -- 证据可见边界（§8.5）
  budget_tools     INTEGER NOT NULL DEFAULT 12,
  budget_micro     INTEGER NOT NULL DEFAULT 50000,
  used_micro       INTEGER,               -- 终结时写（§7.5）
  cost_status      TEXT CHECK(cost_status IN ('settled','estimated')),
  over_budget_micro INTEGER,
  yield_continues  INTEGER NOT NULL DEFAULT 0,
  rules_ver TEXT NOT NULL,                -- 策略包版本 = rules/ + config/scenes.yaml 的联合 sha（§10）
  calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL, prices_ver TEXT NOT NULL,
  judge_model      TEXT NOT NULL,
  agent_model      TEXT,
  conversation_id  TEXT,
  submission_id    TEXT,                  -- durable submission id，对账用（§11.5）；缺失时按 §7.3 步 8 幂等补齐
  release_reason   TEXT,                  -- timeout | budget_tools | budget_cost | evidence_gap | judge_down | model_release | backpressure | revoked | preprocess_error
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(content_id, seq),
  UNIQUE(content_id, trigger_request_id),
  UNIQUE(review_id, content_id, seq),     -- 供 ruling 的三列外键引用
  CHECK((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE INDEX review_state_deadline ON review(state, deadline_at);
CREATE INDEX review_state_lease ON review(state, lease_until);
CREATE INDEX review_content ON review(content_id, seq DESC);
CREATE INDEX review_conv ON review(conversation_id);

CREATE TABLE ruling (
  review_id    TEXT PRIMARY KEY REFERENCES review(review_id),
  content_id   TEXT NOT NULL, seq INTEGER NOT NULL,
  action       TEXT NOT NULL CHECK(action IN ('pass','limit','takedown')),
  actor        TEXT NOT NULL CHECK(actor IN ('fastpath','agent','human')),
  attempt      INTEGER,
  allowed_actions TEXT NOT NULL,
  effective_answers TEXT NOT NULL,        -- JSON：提交时每条规则的有效 judge_answer id（§5.4）
  evidence_ids TEXT NOT NULL, rule_ids TEXT NOT NULL, judge_call_ids TEXT NOT NULL,
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  model_id     TEXT,
  reason       TEXT,                      -- 受限
  ingest_seq   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(content_id, seq),
  FOREIGN KEY(review_id, content_id, seq) REFERENCES review(review_id, content_id, seq),   -- 三列联合身份：裁决只能指向同一行审次
  CHECK(actor <> 'agent' OR attempt IS NOT NULL)
);
CREATE INDEX ruling_content_ingest ON ruling(content_id, ingest_seq);

CREATE TABLE content_state (
  content_id       TEXT PRIMARY KEY REFERENCES content(content_id),
  effective_action TEXT CHECK(effective_action IN ('pass','limit','takedown')),
  effective_seq    INTEGER NOT NULL DEFAULT 0,
  visibility       TEXT NOT NULL CHECK(visibility IN ('visible','self_only','hidden')),
  updated_at       INTEGER NOT NULL,
  CHECK((effective_action IS NULL) = (effective_seq = 0))
);

CREATE TABLE outbox (
  event_id     TEXT PRIMARY KEY,          -- "<review_id>#<kind>"
  review_id TEXT NOT NULL REFERENCES review(review_id), content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('ruling','release')),
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','acked','dead')),
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(status, next_at);

CREATE TABLE delivery_receipt (                 -- 每次收到投递都记一条，含重复
  receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   TEXT NOT NULL, received_at INTEGER NOT NULL
);
CREATE INDEX delivery_receipt_event ON delivery_receipt(event_id);

CREATE TABLE consumer_log (
  event_id   TEXT PRIMARY KEY,
  kind TEXT NOT NULL, review_id TEXT NOT NULL, content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  result     TEXT NOT NULL CHECK(result IN ('applied','stale','notified','stale_notification')),
  created_at INTEGER NOT NULL
);
CREATE INDEX consumer_log_review ON consumer_log(review_id, kind);
CREATE TABLE downstream_state (
  content_id TEXT PRIMARY KEY,
  applied_action TEXT, applied_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE downstream_human (
  review_id TEXT PRIMARY KEY, content_id TEXT NOT NULL,
  pending INTEGER NOT NULL CHECK(pending IN (0,1)),
  opened_by TEXT, closed_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX downstream_human_content ON downstream_human(content_id, pending);

CREATE TABLE evidence (
  evidence_id  TEXT PRIMARY KEY,
  review_id    TEXT NOT NULL REFERENCES review(review_id),
  attempt      INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('account_history','thread_context','image_check','similar','rule','judge')),
  source_ref   TEXT NOT NULL,
  snapshot_seq INTEGER NOT NULL,
  body_sha     TEXT NOT NULL,
  body         TEXT NOT NULL,             -- 受限
  model_view   TEXT NOT NULL,             -- 受限
  created_at   INTEGER NOT NULL
);
CREATE INDEX evidence_review ON evidence(review_id);

CREATE TABLE judge_call (                       -- 调用级
  judge_call_id TEXT PRIMARY KEY,
  review_id TEXT REFERENCES review(review_id), content_id TEXT NOT NULL, attempt INTEGER,
  provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
  input_sha TEXT NOT NULL,                -- sha256(canonical state)：内容 + 所引证据
  evidence_set TEXT NOT NULL,             -- JSON：所引 content-bearing 证据的 body_sha 排序列表（§5.4；不含 kind=rule）
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','timeout','error','abstain')),
  shuffle_seed INTEGER,
  confirms_call_id TEXT,                  -- 复问时指向被确认的那次调用（§9.2）
  mass_covered REAL,
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cost_micro INTEGER, cost_status TEXT NOT NULL CHECK(cost_status IN ('settled','estimated','unknown')),
  prices_ver TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX judge_call_review ON judge_call(review_id);

CREATE TABLE judge_answer (                     -- 问题级：一次调用多个问题
  judge_call_id TEXT NOT NULL REFERENCES judge_call(judge_call_id),
  question_sha  TEXT NOT NULL,            -- sha256(canonical question)：规则问题、例外问题或内置问题（§5.4）
  rule_id       TEXT,                     -- 规则问题/例外问题所属规则；内置问题为 NULL
  question_kind TEXT NOT NULL CHECK(question_kind IN ('rule','exception','image_check')),
  choice        TEXT NOT NULL,
  raw_probs     TEXT NOT NULL, calibrated_probs TEXT, temperature REAL,
  PRIMARY KEY(judge_call_id, question_sha)
);
CREATE INDEX judge_answer_q ON judge_answer(question_sha);

CREATE TABLE model_call (
  generation_task_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES review(review_id), attempt INTEGER NOT NULL, conversation_id TEXT NOT NULL,
  model TEXT NOT NULL,
  first_usage TEXT,                       -- 首个终态响应（可能是失败尝试）的 usage JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX model_call_review ON model_call(review_id);

CREATE TABLE tool_slot (                        -- 逻辑工具调用：额度占用与聚合
  review_id TEXT NOT NULL REFERENCES review(review_id), call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL, tool TEXT NOT NULL,
  counts_toward_limit INTEGER NOT NULL CHECK(counts_toward_limit IN (0,1)),
  reserved_micro INTEGER NOT NULL,        -- 调用前对"一次物理请求"的保守估计
  status TEXT NOT NULL CHECK(status IN ('reserved','blocked')),
  block_reason TEXT,                      -- budget_tools | budget_cost | deadline | revoked
  created_at INTEGER NOT NULL,
  PRIMARY KEY(review_id, call_id)
);

CREATE TABLE tool_request (                     -- 物理请求账单：一次外发一行，结算按行幂等（§7.5）
  review_id TEXT NOT NULL, call_id TEXT NOT NULL, request_no INTEGER NOT NULL,   -- 同一逻辑调用内递增
  judge_call_id TEXT,                     -- 判官请求指向 judge_call；主模型请求不在此表（在 pi.usage）
  cost_micro INTEGER,
  cost_status TEXT NOT NULL CHECK(cost_status IN ('inflight','settled','unknown')),
  created_at INTEGER NOT NULL, settled_at INTEGER,
  PRIMARY KEY(review_id, call_id, request_no),
  FOREIGN KEY(review_id, call_id) REFERENCES tool_slot(review_id, call_id)
);

CREATE TABLE worker_command (
  command_id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('abort')), attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','ignored')),
  created_at INTEGER NOT NULL, done_at INTEGER
);
CREATE INDEX worker_command_status ON worker_command(status);

CREATE TABLE human_queue (
  review_id TEXT PRIMARY KEY REFERENCES review(review_id),
  severity INTEGER NOT NULL, due_at INTEGER NOT NULL, reason TEXT NOT NULL,
  claimed_by TEXT, claimed_at INTEGER,
  closed_at INTEGER, closed_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX human_queue_open ON human_queue(closed_at, severity DESC, due_at);

CREATE TABLE feedback (
  feedback_id TEXT PRIMARY KEY, review_id TEXT NOT NULL REFERENCES review(review_id),
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
  loaded_at INTEGER NOT NULL, rollout_pct INTEGER NOT NULL DEFAULT 0 CHECK(rollout_pct BETWEEN 0 AND 100),
  PRIMARY KEY(kind, version)
);

CREATE TABLE gate_run (
  gate_run_id TEXT PRIMARY KEY,
  config_sha TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)), report TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE metrics_minute (minute INTEGER PRIMARY KEY, payload TEXT NOT NULL);
```

要点：
- `ruling.review_id` 主键 = 一审次最多一条裁决；`UNIQUE(content_id, seq)` + 复合外键 = 裁决必须对应真实审次。
- `review` 的 `UNIQUE(content_id, trigger_request_id)` 是请求幂等的依据（§4 T9）；同一 request_id 换 trigger 不再开新审次。
- `ledger_seq` 单行计数器；`ingest_seq` = 系统何时知道这条记录，与业务时间 `event_time` 分开（§8.5）。
- `content_state` 用 upsert（§3.3）；待审初态 (NULL, 0, hidden)。
- `judge_call`（调用级）与 `judge_answer`（问题级）分开：一次调用可含多条规则问题、例外问题与内置问题。
- `audit` 哈希链：`hash = sha256(prev_hash + kind + ref_id + actor + payload + created_at)`；拒绝审计在业务事务回滚之后单独提交（§5.3）。
- 没有 `failed` 状态：预处理失败走 S2'（reason=preprocess_error）；release 写入失败由控制循环重试到成功。

### 2.3 ID 规则

| ID | 格式 |
|---|---|
| content_id | `<dataset>:<row>` |
| review_id | `<content_id>#<trigger>#<seq>` |
| trigger_request_id | fast/suspicious：`= content_id`；appeal/recheck：客户端 UUIDv7，重试重用；rule_change：`rc:<rules_ver>` |
| evidence_id | `<review_id>#e<n>` |
| outbox event_id | `<review_id>#<kind>` |
| durable requestId | 首次代次 `= review_id`；主动重启新代次 `= review_id#a<attempt>`（§7.4） |
| tool_slot call_id | `= Pi ToolCall.id` |
| model_call 主键 | `= generation task id`（hook 的 `api.taskId`） |
| judge_call_id | UUIDv7 |
| question_sha | `sha256(canonical({kind, rule_id?, exception_id?, instructions, criteria}))`；内置 image_check 问题固定为 `q:image_check@<ver>` 的 sha |
| W 实例 id | `w-<hostname>-<pid>-<start_ms>` |

---

## 3. 审次状态机

### 3.1 状态

```
queued / investigating / disposed / human_queue / human_disposed
```
`disposed`、`human_disposed` 终态；`human_queue` 后机器代次永久失效。快判直接通过/拦截的审次（trigger=fast）一步到 `disposed`。

### 3.2 转换表

| # | 从 | 到 | 触发者 | 前置条件 | 同事务写入 |
|---|---|---|---|---|---|
| S1 | – | disposed | G 快判 | 策略引擎 pass/block | review + ruling(fastpath) + content_state(upsert 裁决) + outbox(ruling) + intake.judged_review_id + judge_call.review_id 绑定 |
| S2 | – | queued | G 快判 | suspicious 且 agent 队列未满 | review(snapshot_seq, deadline_at, 版本固定) + content_state(upsert 初态) + intake.judged_review_id + judge_call.review_id 绑定 |
| S2' | – | human_queue | G 快判 | suspicious 但队列满 / 判官不可用 / 预处理失败 | review(release_reason) + content_state(初态) + human_queue + outbox(release) + intake.judged_review_id + judge_call.review_id 绑定 |
| S3 | queued | investigating | W 准入 | `deadline_at > now AND attempt < MAX_ATTEMPTS` | review(attempt+1, lease_owner, lease_until) |
| S3' | investigating | investigating | W 准入（租约过期自取） | `lease_until < now AND deadline_at > now AND attempt < MAX_ATTEMPTS` | 同 S3 |
| S4 | investigating | investigating | W 心跳 | 持有当前代次 | review(lease_until) |
| S5 | investigating | disposed | W dispose | §5 全部通过 | ruling(agent, attempt, allowed_actions, effective_answers) + content_state(upsert 条件) + outbox(ruling) + review(state, used_micro, cost_status) |
| S6 | investigating | human_queue | W release | 持有当前代次 | review(state, release_reason, lease_owner=NULL, used_micro, cost_status) + human_queue + outbox(release) |
| S7 | investigating | human_queue | G 控制循环（T6） | 过 deadline / 租约过期且 attempt ≥ MAX_ATTEMPTS | review(lease_owner=NULL, revoked_attempt, state, used_micro 回退口径, cost_status=estimated) + human_queue + outbox(release) + worker_command(abort) |
| S8 | investigating | queued | G 控制循环（T7） | 租约过期且 attempt < MAX_ATTEMPTS 且未过 deadline | review(lease_owner=NULL, state=queued) |
| S9 | human_queue | human_disposed | 人审页 | 无 ruling；人工授权通过 | ruling(human) + content_state(upsert 条件) + outbox(ruling) + review(state) + human_queue.closed_at/closed_by |
| S10 | 终态 | （新审次 queued） | 申诉/重审/规则变更 | 该内容最新审次 ∈ {disposed, human_disposed}（T9 检查） | 新 review 行 |
| S11 | queued | human_queue | G 控制循环（T6） | queued 里等到过 deadline | 同 S7 无 abort 命令 |

不允许的转换由提交层拒绝并写审计：终态 → 任何；`human_queue → investigating`；任何携带 `attempt ≠ review.attempt` 或 `lease_owner ≠ 当前` 的机器写入（dispose、release、心跳都检查）。

human_queue 的 `severity` 取命中规则的最大 severity（无命中取场景默认，`config/scenes.yaml`），`due_at = created_at + scenes.yaml.human_sla_ms`。

### 3.3 内容的有效处置

```
effective(content) = ruling with max(seq) among committed rulings of content；无则"尚无"
```
写 ruling 的事务与审次创建事务都执行 upsert：
```sql
INSERT INTO content_state(content_id, effective_action, effective_seq, visibility, updated_at)
VALUES (:cid, :action, :seq, :visibility, :now)          -- 初态时 action=NULL, seq=0, visibility 按场景待审策略
ON CONFLICT(content_id) DO UPDATE SET
  effective_action=excluded.effective_action, effective_seq=excluded.effective_seq,
  visibility=excluded.visibility, updated_at=excluded.updated_at
WHERE excluded.effective_seq > content_state.effective_seq;
```
visibility：裁决 pass → visible；limit → self_only；takedown → hidden；待审 → `scenes.yaml.pending_visibility`（MVP 一律 hidden）。release 不碰 content_state。

---

## 4. 事务边界

每个编号是 `packages/core/src/*.ts` 的一个函数，内部 `BEGIN IMMEDIATE … COMMIT`（§13.5），事务内无 await、无网络。

| # | 函数 | 写入 | 幂等性 / 规则 |
|---|---|---|---|
| T1 | `intakeInsert(content)` | content(ingest_seq 取号) + intake | content_id 冲突忽略 |
| T2 | `fastDispose(contentId, decision, judgeCallIds)` | S1 全部 | review_id `<content_id>#fast#1` 冲突 → 读回已有 ruling；intake.judged_review_id 已非空 → 直接返回该审次，不二次路由 |
| T2' | `createSuspiciousReview(contentId, pins, judgeCallIds, reason?)` | S2 / S2'；`snapshot_seq = ledger_seq.value`（只读当前值） | 同上 |
| T3 | `acquireLease(reviewId, workerId, ttl)` | S3 / S3' | `WHERE (state='queued' OR (state='investigating' AND lease_until < now)) AND deadline_at > now AND attempt < MAX_ATTEMPTS`；0 行时回读 state：investigating 且租约有效 → `E_LEASE_HELD{lease_until}`；其余 → `E_STATE_INVALID` |
| T3' | `renewLease(reviewId, workerId, attempt, ttl)` | S4 | `WHERE state='investigating' AND lease_owner=? AND attempt=? AND lease_until >= now AND revoked_attempt IS NOT attempt`；0 行 → `E_LEASE_LOST`。**过期租约不能续**：过期后只能走 S3' 新代次 |
| T4 | `submitRuling(input)` | S5 / S9（ruling.ingest_seq 取号） | §5；ruling 的 `content_id/seq` 从已读取的 review 行派生，不接受调用方指定 |
| T5 | `releaseToHuman(reviewId, actor, attempt?, workerId?, reason, usedMicro?)` | S6 / S11 | actor=agent：`WHERE state='investigating' AND lease_owner=? AND attempt=? AND lease_until >= now AND revoked_attempt IS NOT attempt`，0 行 → `E_ATTEMPT_STALE`；actor=control（S11）不检查租约；已 human_queue → duplicate；终态 → `E_STATE_INVALID` |
| T6 | `revokeAndRelease(reviewId, reason)` | S7 | command_id `<review_id>#abort#<attempt>` 去重；used_micro 按回退口径（§7.5） |
| T7 | `requeue(reviewId)` | S8 | `WHERE state='investigating' AND lease_until < now AND attempt < MAX_ATTEMPTS AND deadline_at > now` |
| T8 | `outboxMark(eventId, status, nextAt)` | outbox | 条件更新 |
| T9 | `createFollowupReview(contentId, trigger, triggerRequestId, payloadSha)` | S10 | ① 查 `(content_id, trigger_request_id)`：存在且 payload_sha 相同 → 返回原审次；存在且不同 → `E_REQUEST_CONFLICT`；② 该内容最新审次（max seq）state ∉ {disposed, human_disposed} → `E_STATE_INVALID`；③ seq = max+1 插入 |
| T10 | `consumer.apply(event)` | delivery_receipt + consumer_log + downstream_state + downstream_human | 见下 |
| T11 | `reserveToolSlot(reviewId, attempt, callId, tool, estMicro)` | tool_slot | `INSERT OR IGNORE`；新插入且 `usedToolSlots(reviewId) > budget_tools` → status=blocked, block_reason=budget_tools，返回 `E_BUDGET_EXCEEDED`；已存在 → 返回原状态 |
| T11' | `openToolRequest(reviewId, callId)` → request_no | tool_request(inflight) | 工具每次真正向外部发请求前调用；重放产生新的 request_no |
| T12 | `settleToolRequest(reviewId, callId, requestNo, micro \| null, judgeCallId?)` | tool_request | `WHERE cost_status='inflight'`：有费用 → settled；null → unknown。同一 request_no 重复结算是空操作（幂等）；缓存命中不开新请求 |
| T13 | `recordModelCall(taskId, review, usage)` | model_call | `INSERT OR IGNORE` |
| T14 | `bumpYield(reviewId, max)` | review.yield_continues | `WHERE yield_continues < max` |
| T15 | `appendRejectAudit(...)` | audit | 业务事务 ROLLBACK 之后独立 BEGIN IMMEDIATE 提交 |
| T16 | `recordJudgeCall(call, answers)` | judge_call + judge_answer | 主键去重 |
| T17 | `updateReviewCost(reviewId, usedMicro, costStatus, overMicro)` | review.used_micro / cost_status / over_budget_micro | 可多次更新（后到用量）；不碰 ruling |

`usedToolSlots(reviewId) = SELECT COALESCE(SUM(counts_toward_limit),0) FROM tool_slot WHERE review_id=? AND status<>'blocked'`。T11 与 §5.2 步 6 都用这一个函数。

**T10 消费规则（按审次管理人审生命周期）**：
```
无条件 INSERT delivery_receipt(event_id, now)
event_id 已在 consumer_log → 重复投递：返回原结果，不改状态（与"第一次送达但已过时"不同，后者才产生 stale / stale_notification）
kind = ruling（review r, seq s）：
    if s > downstream_state.applied_seq → upsert applied_action/applied_seq, result=applied
    else result=stale
    无论哪种：upsert downstream_human[r] = {pending:0, closed_by:event_id}
kind = release（review r）：
    if consumer_log 已有 r 的 ruling 事件 → result=stale_notification，不改状态
    else upsert downstream_human[r] = {pending:1, opened_by:event_id}, result=notified
```

durable 侧顺序固定：**先 app.db 事务，后 durable memo**。代码审查检查点：`grep -n "memo(" packages/worker/src` 每处之前必有 core 事务调用。

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
  usedMicro?: number;                          // agent：提交时从 pi.usage + tool_slot 算出
  humanAuth?: { reviewerId: string; token: string };
};
```

### 5.2 检查顺序（T4 事务内，首个失败即回滚）

| 步 | 检查 | 错误码 |
|---|---|---|
| 1 | review 存在 | E_REVIEW_NOT_FOUND |
| 2 | 已有 ruling：`actor` 相同且（agent 时）`attempt` 相同 → 恢复读取，返回原裁决 `duplicate:true`；否则 E_STATE_INVALID | – / E_STATE_INVALID |
| 3 | 状态允许：agent 需 `investigating`；human 需 `human_queue`；fastpath 需新建 | E_STATE_INVALID |
| 4 | 身份（agent）：`lease_owner ≠ workerId` 或 `lease_until < now` → E_LEASE_LOST；`attempt ≠ review.attempt` 或 `revoked_attempt = attempt` → E_ATTEMPT_STALE。human：`verifyHumanAuth()` | E_LEASE_LOST / E_ATTEMPT_STALE / E_HUMAN_AUTH |
| 5 | 截止：agent 需 `now < deadline_at` | E_DEADLINE_PASSED |
| 6 | 工具次数硬限制：`usedToolSlots(reviewId) ≤ budget_tools`（dispose/release 不计，blocked 行不计） | E_BUDGET_EXCEEDED |
| 7 | 版本：pins 与 review 行相等 | E_VERSION_MISMATCH |
| 8 | 动作白名单：`action ∈ scenes.yaml[scene].allowed_actions`；`action ∈ {limit, takedown}` 时 `ruleIds` 非空（human 也要求），且每条规则存在于 rulesVer、适用 scene，且 `action ∈ ruleAllowed(r) = {pass} ∪ {r.default_action}` | E_ACTION_NOT_ALLOWED / E_RULE_UNKNOWN |
| 9 | 证据归属：每个 evidence 的 review_id = reviewId 且 attempt ≤ review.attempt | E_EVIDENCE_FOREIGN |
| 10 | 判官归属与指纹：每个 judge_call 的 review_id = reviewId；三个版本 = pins；`input_sha` 等于 core 重算值 | E_JUDGE_FOREIGN |
| 11 | **有效判官答案 + allowedActions**（§5.4）：`action ∈ allowedActions` | E_ACTION_NOT_SUPPORTED |
| 12 | 写入 S5/S9；ruling 记录 allowed_actions 与 effective_answers | – |

human：跳过 5、6、11（人工可零证据：evidenceIds/judgeCallIds 可空，但 limit/takedown 必须给 ruleIds）。fastpath：证据只来自 judge_call，11 同样执行。费用是软限制，不在此处拒绝（§7.5）。

### 5.3 拒绝审计

T4 失败 → ROLLBACK → 同一 core 函数内立即 T15（新的 BEGIN IMMEDIATE）提交 `audit(kind='submit_rejected', payload={code, step, reviewId, actor, attempt, action})`。D-07 验证回滚后审计行仍存在。

### 5.4 有效判官答案与 allowedActions（`core/effective.ts`、`core/allowed.ts`，纯函数）

**第一步：对每个问题，选出"当前裁决依据"（`effective.ts`）。**

```
trustedCalls = judge_call where review_id = this AND status='ok'
               AND input_sha ∈ fingerprintsOf(review)          // 内容 + 本审次证据的合法指纹集合
answers(q)   = judge_answer where question_sha = q.sha AND judge_call_id ∈ trustedCalls AND calibrated_probs IS NOT NULL
对问题 q：
  按 judge_call.evidence_set 分组（evidence_set 只含 content-bearing 证据：account_history / thread_context / image_check / similar；不含 rule / judge）
  组内：choice 不一致 → group.inconsistent；否则 group.p = 最新一条的校准概率
  group.confirmed(action) = 组内存在一对答案 (a, b)：b.confirms_call_id = a.judge_call_id；两者 input_sha、question_sha、model、calib_ver 相同；
                            且 a 与 b **各自都满足 action 的条件**（放行：两次 p 都 < thresholds.pass 且 choice 都是该问题的放行选项；拦截：两次 p 都 ≥ block）
  有效组 = evidence_set 为唯一极大元的组（⊇ 其他所有组）；不存在唯一极大 → effective(q) = none
```
含义：补了新证据（证据集合变大）的复判替代此前判断；同证据反复调用若结果不一致 → inconsistent；两条互不包含的证据路径 → none，只能继续补证或 release。`load_rule` 不改变证据集合，所以反复读规则不会制造新的单样本。**确认不是"两次 choice 相同"**：0.20 → 0.02 两次都选"正常"也不算确认，因为第一次不满足放行条件（U-12、H-25f）。**放行选项**：每个问题在规则 YAML 里声明 `pass_choices`（例如 `none`、`benign_mention`）；`unknown` 永远不是放行选项，两次都选 unknown 且 p 很低也不放行（H-25g）。

**第二步：allowedActions（`allowed.ts`）。**

```
for rule r in applicable(scene, rulesVer):                 // r 有一个规则问题 q_r 与若干例外问题 q_x
    e = effective(q_r)
    exc_r = for each exception x: effective(q_x).choice ∈ {applies, not_applies, unknown}；无 → unknown
    block_support(r) = e ≠ none AND !e.inconsistent AND e.p ≥ r.thresholds.block AND all(exc_r == not_applies)
    pass_support(r)  = e ≠ none AND !e.inconsistent AND e.confirmed(pass)          // 两次都满足放行条件（见上）
    suspicious(r)    = e ≠ none AND !pass_support(r) AND !block_support(r)
covered(c) = ∀ r ∈ rules(c, scene): pass_support(r)         // 类别 c 的全部规则都支持放行
required   = requiredCategories(scene) ∪ (has_images ? {image_check} : ∅)
             // image_check 是内置类别：其"规则"= 内置问题 q:image_check，阈值在 scenes.yaml
allowed = {}
if any block_support(r):        allowed += r.default_action for those r      // takedown / limit
if no block_support AND ∀ c ∈ required: covered(c):   allowed += pass
return allowed                                                // release 永远允许，不在集合内
```
规则：
- 高风险有效答案 → pass 不在集合；豁免成立（exc=applies）→ 该规则不支持下架；补证据后有效答案变为低风险**且经复问确认** → pass 进入集合。
- `confirmed(pass)` 是放行侧的硬要求，**对 fastpath 与 agent 同样适用**：任何自动放行都必须由同输入的第二次（打乱选项的）答案确认，且两次各自满足放行条件（§9.2）。快判的确认在同一次 System One 调用内完成（§9.2），所以 G 的单次调用预算不变，但每个规则问题的 token 数约翻倍，快判成本与延迟按新口径重测（E-03）。
- 文本已有 block_support 时其他类别不要求覆盖（v2.3 §6.4 提前结束）。
- 证据 ID 只是引用，授权来自有效判官答案与规则。

验收：H-17、H-25（a–g），其中 d：证据集合逐步扩大、每组单样本 → 不放行；e：上一组 inconsistent，超集组单条低分 → 不放行，超集组两条各自满足放行 → 放行；f：0.20 → 0.02 两次 choice 相同 → 不放行；g：两次都选 unknown 且 p 很低 → 不放行。

### 5.5 错误码全表

| 码 | HTTP | 含义 / 产生处 |
|---|---|---|
| E_REVIEW_NOT_FOUND | 404 | T4 |
| E_STATE_INVALID | 409 | T3/T4/T5/T9：状态不允许（含终态重复提交、上一审次未终结） |
| E_REQUEST_CONFLICT | 409 | T9：同触发请求标识不同内容 |
| E_LEASE_HELD | 409 | T3：租约被他人持有（附 lease_until） |
| E_LEASE_LOST | 409 | T3'/T4/hooks：租约不属于调用方或已过期；无 grant |
| E_ATTEMPT_STALE | 409 | T4/T5：执行代次已失效（代次不符或已撤销） |
| E_DEADLINE_PASSED | 409 | T4/hooks |
| E_BUDGET_EXCEEDED | 409 | T11/T4：工具次数硬限制 |
| E_BUDGET_COST | 409 | hooks：费用软限制触发（只 block 非终结工具） |
| E_VERSION_MISMATCH | 409 | T4 |
| E_RULE_UNKNOWN | 422 | T4 |
| E_ACTION_NOT_ALLOWED | 422 | T4：动作不在场景/规则白名单，或 limit/takedown 无 ruleIds |
| E_EVIDENCE_FOREIGN | 422 | T4 |
| E_JUDGE_FOREIGN | 422 | T4 |
| E_ACTION_NOT_SUPPORTED | 422 | T4：动作不在 allowedActions（附集合、每条规则的有效答案状态与缺失项） |
| E_HUMAN_AUTH | 401 | T4/HTTP |
| E_JUDGE_UNAVAILABLE | 503 | G 快判：判官不可用 → S2'（fail-closed） |
| E_BACKPRESSURE | 429 | G 准入 / 回放器 pause |

工具层把错误码作为 `isError:true` 的结果返回给模型，附固定提示。

---

## 6. 接口

### 6.1 G 的 HTTP（127.0.0.1:8080）

| 方法 路径 | 用途 | 说明 |
|---|---|---|
| GET /api/health | 存活 | {ok, version, queues} |
| GET /api/metrics | 仪表盘（SSE 每秒） | metrics_minute 最新 + 实时：`{intake_rate, fast_rate, agent_rate, pass_pct, block_pct, suspicious_pct, release_pct, queue_agent, queue_human, outstanding_total, p50_fast, p95_fast, p50_agent, p95_agent, cost_micro_per_1k, judge_abstain_pct, over_budget_count}` |
| GET /api/reviews?state=&limit= | 审次列表 | 脱敏 |
| GET /api/reviews/:id | 审次详情 | review + ruling（去 reason）+ evidence 白名单列（evidence_id, kind, source_ref, snapshot_seq, body_sha, created_at）+ judge_call/judge_answer（去原始输入） |
| GET /api/reviews/:id/restricted | 受限视图 | 鉴权：`Authorization: Bearer <HUMAN_REVIEW_TOKEN>` + `X-Reviewer`（须在 reviewers.json）+ `X-Confirm: yes`；返回 evidence.body、model_view、ruling.reason；写 audit(kind='restricted_view') |
| POST /api/human/claim | 领取人审任务 | 同上鉴权；按 `human_queue_open` 索引（未关闭、severity 降序、due_at 升序）取第一条并写 claimed_by |
| POST /api/human/submit | 人工裁决 | 同上鉴权；SubmitRulingInput(actor=human) |
| POST /api/appeals | 申诉 | {content_id, trigger_request_id(UUIDv7), reason_code}；重试重用同一 id |
| POST /api/rules/shadow | 影子回放 | {rule_id, version} → {kind, flips, insufficient, total, rejudged, cost_micro} |
| POST /api/rules/rollout | 灰度 | {rule_id, version, pct}；要求 gate_run(config_sha 匹配, passed=1) |
| GET /api/calib、POST /api/calib/approve | 校准面板 | current / candidate / support / status |
| POST /api/replay/pause、/resume | 背压控制回放器 | |

### 6.2 W 的 HTTP（127.0.0.1:8081，只给 G、reconcile 与 inspect 用）

| 方法 路径 | 用途 |
|---|---|
| GET /health | {worker_id, grants 统计, scheduling} |
| GET /sessions | 按 conversation_id 列出：活任务（来自 `harness.inspect()`）、submission 状态（`harness.submission(id).status()`，id 来自 review.submission_id）、grant 模式。reconcile 的 durable 侧检查用它 |
| POST /abort | {review_id, attempt} → 立即执行一次命令轮询；返回 aborted \| not_running \| stale |
| GET /trace/:review_id | 轨迹（脱敏）：durable `entries()` 投影 |

### 6.3 G ↔ W 通过 app.db

- 准入：W 自己从 review 表取 queued / 过期 investigating 的审次（T3）；并发上限 `ADMIT_MAX`（MVP 10【估计】；8 周目标 20）。T3 返回 `E_LEASE_HELD` 只会在 G 控制循环尚未处理的竞争窗口出现，W 跳过该审次、下轮再看；不 abort。
- 心跳：W 每 5s T3'，TTL 30s。
- 控制循环 `control.tick(now)`：对 `deadline_at < now AND state IN ('queued','investigating')` 执行 T6（S7/S11）；对 `lease_until < now AND state='investigating'` 执行 `attempt < MAX_ATTEMPTS ? T7 : T6`。G 每 2s 调用；测试直接调用。
- W 每 500ms 轮询 `worker_command` pending。
- **背压**：`outstanding_total = COUNT(intake WHERE status<>'judged') + COUNT(review WHERE state IN ('queued','investigating'))`；`queue_agent = COUNT(review WHERE state='queued')`；`queue_human = COUNT(human_queue WHERE closed_at IS NULL)`。阈值：`QUEUE_AGENT_MAX=50`、`QUEUE_HUMAN_MAX=500`、`OUTSTANDING_MAX=2000`【估计】。`queue_agent ≥ QUEUE_AGENT_MAX` → 新疑似走 S2'（backpressure）；`queue_human ≥ QUEUE_HUMAN_MAX OR outstanding_total ≥ OUTSTANDING_MAX` → `POST /api/replay/pause`，低于 80% 时 resume。

### 6.4 人工授权

`HUMAN_REVIEW_TOKEN` + `config/reviewers.json`；`core.verifyHumanAuth(reviewerId, token)`；`/restricted` 与人审接口共用。

### 6.5 判官适配器接口

```json
请求 {"request_id","review_id","content_id","rule_version":"rules@<sha>",
      "state":{"content":{"text_ref":"sha256:…","text":"…","scene":"comment"},
               "evidence":[{"evidence_id","kind","model_view":{…},"untrusted":true}],
               "images":[{"ref":"blob:sha256:…"}]},
      "questions":{"<question_sha>":{"type":"choice","kind":"rule|exception|image_check","rule_id":"ABUSE-003","instructions":"…","criteria":{…}}},
      "options":{"shuffle_seed":17,"confirms_call_id":null,"timeout_ms":400,"calib":"calib/<judge>@<ver>"}}
响应 {"judge":{"provider","model","api"},"status":"ok|timeout|error|abstain",
      "input_sha","evidence_set":[…],"mass_covered",
      "answers":{"<question_sha>":{"choice","probabilities":{…},"confidence","calibrated":{"probabilities":{…},"T"}}},
      "latency_ms","usage":{"input","output","cost_micro","cost_status"}}
```
问题键就是 question_sha，响应按键回填 judge_answer。内部映射到 pi-ai `ClassifierContext { state, questions }` 与 `ClassifierResult { answers, stopReason, usage }`；`classify()` 对 provider 错误返回 `stopReason:"error"` 而不抛【原文，pi-ai README】。

---

## 7. 执行资格、租约、恢复、预算

### 7.1 时间线

```
G 创建审次：deadline_at = now + 60s（短文本；验收口径 p95 ≤30s 的 2 倍余量）
W 准入：   attempt=1, lease_until = now + 30s；每 5s 续约
W 调查：   每次外部调用前经 guard() 检查执行资格（§7.3）
到期：     G 控制循环 → T6 → 尽力 POST W /abort
迟到：     旧代次 dispose 到达 T4 → 步 2 或步 4 拒绝；不新增、不覆盖
人工：     人审页 submit(actor=human) → 跳过机器条件 → human_disposed
```
单次生成的时间上界【计算】= `stream.timeoutMs` × (1 + `retry.maxRetries`) + 重试等待 = 15s × 2 + `baseDelayMs`（durable 默认 2000ms【源码，agent.ts DEFAULT_RETRY_POLICY】，一次重试）≈ 32s（§8.1），小于 60s 截止；超出截止的在飞请求结果由 T4 步 5 拒绝。实际墙钟在 H-27/E-01 观测。

### 7.2 abort 为何只是尽力

durable 的 `Conversation.abort()` 撤回排队输入、标记每个活任务、等到空闲【原文，types.d.ts】；W 可能已死或模型请求在飞。S7 的正确性只依赖 T4 的门；abort 省钱和清理。

### 7.3 W 启动屏障与执行资格表（grants）

durable 事实：`Harness.open()` 不启动调度（scheduler `open()` "Dispatches nothing"【源码】；`inspect().scheduling` 取值 `"paused" | "running" | "closing"`【原文，harness/types.d.ts】）；`resume()`、`submit()`、`compact()`、`abort()`、`Submission.wait()`、`waitForTask()`、`waitForIdle()` 都会启动调度【原文】；`inspect()` 只读不跑任务代码【原文】；工具恢复从 `execute` 阶段进入，`beforeTool` 只在 `call` 阶段运行【原文，tool.d.ts；源码确认不重跑】；hook 的 `memo` 属于所在任务【原文，HookApi】；`requestId` 的去重范围是会话【原文，types.d.ts "scoped to the conversation"】。

启动顺序（`worker/src/startup.ts`）：

```
0. 单实例锁 data/w.lock（flock）；拿不到 → 退出。
1. Harness.open（不调用任何会启动调度的方法）。
2. inspect() 读出活任务与未结 submission，按 conversation_id 归并。
3. 从 app.db 读 conversation_id 非空且（state 非终态 或 durable 仍有活任务）的审次，分类：
   a finalize : app.db 已是 disposed/human_disposed，durable 仍有活任务
   b revoked  : app.db 是 human_queue
   c leaseLive: investigating 且 lease_until ≥ now
   d reacquire: queued，或 investigating 且租约已过期
4. 对 c：等待到 max(lease_until)（单实例锁保证旧持有者已死，最多 TTL=30s）。之后 c 全部归入 d。
5. 对 d：T3 取新代次 → grants[conv] = {mode:"active", reviewId, attempt, pins, modelId, budgetTools, budgetMicro}；
   T3 失败 E_STATE_INVALID（G 已转人工或已终态）→ 按 app.db 状态归入 b 或 a。
   对 a：grants[conv] = {mode:"finalize", reviewId}。对 b：grants[conv] = {mode:"revoked", reviewId}。
6. 准入信号量按 active 数量预占。
7. resume()。此后：
   - active：纯重放。
   - finalize：恢复的终结工具按 finalize 路径读回业务结果、memo、terminate；恢复的是 generation 任务时，模型随后发出的 dispose/release 在 beforeTool 放行（§8.4），同样走 finalize 路径。
   - revoked：宿主控制循环立即 conversation.abort()。abort 落地前 durable 可能已为其恢复的 generation 任务发出模型请求；次数是 H-27 的观测结果，不预设上界。
8. **提交缝隙补齐**（在 resume 之后，因为 submit 会启动调度）：对每个 active grant，若 `review.submission_id` 为空 → 用固定首次 requestId（`review_id`）`submit()`；durable 对同 requestId 返回已有 submission【原文】，所以"submit 已持久化但未回写 id"与"从未 submit"两种崩溃状态都由这一步幂等收口，然后 `bindSubmission()`。不会产生第二份逻辑审核（H-31）。
```

**执行资格表（唯一行为表）**

| 模式 | 允许 |
|---|---|
| active | 经 `guard()` 重新检查租约、截止、硬限制后，调用模型、工具、提交 |
| finalize | 只读取已提交业务结果并收尾（memo、terminate）；不调查、不提交；非终结工具 block |
| revoked | 不提交；非终结工具 block；终结工具返回 E_LEASE_LOST；由宿主控制循环 abort。abort 前可能有少量模型请求（见上） |
| （启动前） | 没有任务在跑：等待放在 resume 之前 |

`guard()`（`extension/guard.ts`）是统一适配层：每个工具 `execute()` 第一行、每个向外部发请求的 helper 第一行都调用它。它读 grants（进程内存）并对 active 模式做一次 `core.leaseStatus()`，返回 `{mode, reviewId, attempt, pins, modelId, budgetMicro}` 或错误。工具把返回值保存在调用局部变量里，整个调用期间不再重读。`beforeTool` 做同样检查（正常路径更早拦住），但正确性不依赖它。

### 7.4 重放与重启的区别

| 情形 | 触发 | 处理 | 模型看到的 |
|---|---|---|---|
| 恢复重放 | W 崩溃后启动（§7.3） | durable 从断点续跑；同 requestId；工具按 replay 规则重跑 | 原断点，无新输入 |
| 主动重启新代次 | W 活着但租约丢失（心跳停摆 > TTL，G 已 S8 requeue）| 宿主控制循环先 `conversation.abort()` 并 `waitForIdle()`，删除旧 grant；之后若 W 重新 T3 拿到该审次（新 attempt），新 grant 写入，`submit({content:"上一代次已中止；已有证据仍可引用。继续审核。", requestId: review_id#a<attempt>})` | 同一会话的旧转录 + 一条新输入 |

两者不混称"从原断点继续"。旧代次的在飞调用，因为 abort + waitForIdle 在重新 T3 之前完成，不可能查到新 attempt（H-28）。

### 7.5 预算与费用

**硬限制 = 工具次数**；**软限制 = 费用**。

- 工具次数：`beforeTool` 与 `guard()` 都调 T11。`counts_toward_limit`：dispose/release = 0，其余 = 1。超限 → block（dispose/release 仍放行）。本轮出现 blocked 行且审次未终结 → `afterTools` 让宿主控制循环 release(reason=budget_tools)（H-08）。
- 物理请求：每次真正外发前 T11' 开一行 `tool_request(inflight)`；重放产生新的 request_no。逻辑次数（limit，tool_slot）与物理次数（tool_request 行数）分开报。
- 工具费用：T12 按 `(review_id, call_id, request_no)` 结算，幂等；判官请求的费用来自 judge_call.usage，只记在 tool_request 一处（judge_call.cost_micro 是同一个数的副本，**不参与求和**）。
- 主模型费用事实源 = durable `pi.usage`（`UsageDoc`：按 provider/model 与工具名累计，失败和中止的尝试也计入【原文，README "Usage and Cost"】）。`HookApi` 与 `ToolExecutionApi` 都实现 `DocumentReader`（`snapshot(token, conversationId, ctx)`【原文】）。
- **费用公式（唯一口径，所有路径共用）**：
  `spent = micro(pi.usage.models) + Σ tool_request.cost_micro(settled) + Σ_{tool_request inflight|unknown} tool_slot.reserved_micro`
  同一逻辑调用内已结算的请求与仍未知的请求各算各的，不会互相覆盖；不依赖 `pi.usage.tools`。
- `model_call` 只做逻辑记录（T13）；`first_usage` 可能来自失败尝试，仅供对账参考。
- 软限制执行：`beforeTool`/`guard()` 发现 `spent ≥ budget_micro` → block 非终结工具（E_BUDGET_COST）；`afterTools`/`onYield` 发现超限 → 宿主控制循环 release(budget_cost)。超出量写 `review.over_budget_micro`，评测卡报告分布；不宣称绝对费用上限，也不预设"多一次请求"的上界。
- `onYield` 续跑：T14 写 review 行。
- **费用可以后续更新，裁决不能**：S5/S6/S7/S11 时用上面公式写 `used_micro`；只要存在 inflight/unknown 的请求或 pi.usage 可能未定（撤权后在飞请求仍会结束），`cost_status=estimated`；宿主控制循环在会话 idle 后、对账时再用同一公式 T17 更新一次，全部 settled 才标 `settled`。G 的 T6（S7/S11）没有 pi.usage，用 `Σ model_call.first_usage 换算 + Σ tool_request.settled + Σ reserved(inflight|unknown)` 作 estimated 初值，W 的宿主循环随后 T17 修正。

验收 H-22。

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
  settings: { stream: { timeoutMs: 15_000, maxRetries: 0 }, retry: { maxRetries: 1, baseDelayMs: 2000 },
              toolExecution: "sequential", compaction: { enabled: false } },
  onReport: (e) => log.warn({ err: redact(e) }, "extension failure"),
}, ctx);
// 不在这里 resume()；见 §7.3
```

`stream.timeoutMs=15s`、`retry.maxRetries=1`、`baseDelayMs=2s` → 单次生成 ≈ ≤ 32s【计算】< 60s 截止（§7.1）。`toolExecution:"sequential"`：轨迹可读；预算正确性不依赖它。`compaction.enabled=false`。

### 8.2 一审次一会话

durable 的 `requestId` 去重范围是会话【原文】，所以自建索引：`review.conversation_id` 列。流程：W 准入拿到租约后，若为空 → `harness.createConversation({ownership:{kind:"ownerless"}, agent:{model, instructions, tools}}, ctx)` → `core.bindConversation(reviewId, convId)`（条件 `conversation_id IS NULL`）；`submit(...)` 后 `core.bindSubmission(reviewId, submission.id)`。崩溃在创建与写回之间 → 重启后再建，旧会话成孤儿（无任务无成本），`scripts/gc-sessions.ts` 清理。`submit({type:"input", content: initialPrompt(reviewId), requestId: review_id, whenBusy:"reject"}, ctx)`；重复 submit 同 requestId 返回同一 submission【原文】。

### 8.3 工具定义（`extension/tools.ts`）

```ts
const dispose = defineTool({
  name: "dispose",
  description: "提交裁决。只接受证据 ID 与行动建议；原文、规则、校准由服务器按审次绑定。单独成轮调用。",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("pass"), Type.Literal("limit"), Type.Literal("takedown")]),
    evidence_ids: Type.Array(Type.String()),
    rule_ids: Type.Array(Type.String()),
    reason: Type.String({ maxLength: 500 }),
  }),
  replay: "safe",
  execute: async (args, api, ctx) => {
    const g = guard(api);                                        // 局部变量，调用期间不再重读
    if (g.mode === "revoked") return err("E_LEASE_LOST");
    const memoed = await api.memo<RulingSummary>("ruling", ctx);
    if (memoed) return done(memoed);
    if (g.mode === "finalize") {
      const r = core.readRuling(g.reviewId);
      if (!r) return err("E_STATE_INVALID");
      await api.memo("ruling", summarize(r), ctx);
      return done(summarize(r));
    }
    const spent = core.spentMicro(g.reviewId, microOf(await api.snapshot(UsageDoc, api.conversationId, ctx)));
    const r = core.submitRuling({ reviewId: g.reviewId, actor: "agent", attempt: g.attempt, workerId: WORKER_ID,
      action: args.action, evidenceIds: args.evidence_ids, ruleIds: args.rule_ids,
      judgeCallIds: judgeCallsOf(g.reviewId), pins: g.pins, modelId: g.modelId, reason: args.reason, usedMicro: spent });
    if (!r.ok) return { isError: true, content: text(`${r.code}: ${r.hint}`), details: { code: r.code } };
    await api.memo("ruling", summarize(r.ruling), ctx);          // app.db 之后才 memo
    return done(summarize(r.ruling));
  },
});
const done = (s: RulingSummary) => ({ content: text(`disposed ${s.action}`), details: s, control: { terminate: true } });
```

`control:{terminate:true}` 只在"该轮每个结果都要求"时结束 run【原文，README "Tools"】，被 block 的结果不满足它。**最终保障在宿主层**：dispose/release 成功后，工具向宿主控制循环投递 `{kind:"finished"}`，控制循环对该会话 `conversation.abort()` → `waitForIdle()` → 删除 grant；业务已终结后模型的任何后续调用都被 guard/beforeTool 拒绝。系统提示仍要求终结工具单独成轮（降低多余请求），但不靠它保证正确性；多余的模型请求次数是 H-22 的观测值。`api.commit(change, ctx)` 两个参数【原文】。

其余工具：

| 工具 | 执行体 | 写 evidence | 外部调用（经 guard + T11'） |
|---|---|---|---|
| get_account_history | synth_event + ruling(join content 取 account_id) as-of 查询 | 是 | 无 |
| get_thread_context | content as-of 查询，前后各 3 条 | 是 | 无 |
| get_image | 取图 → Clef 适配器 → T16（内置 image_check 问题） | 是 | 是（同 review_id + image sha 复用） |
| find_similar_dispositions | simhash（text_sha）近邻 + as-of 有效裁决 | 是 | 无 |
| load_rule | 规则正文与例外（按 review.rules_ver） | 是（kind=rule，不进 evidence_set） | 无 |
| judge | 判官复判：内容 + 所引证据 model_view；问题 = 所选规则的问题 + 其例外问题；→ T16 | 是（kind=judge） | 是 |
| confirm | 对最近一次 judge 的同证据集合打乱选项复问（confirms_call_id）；放行前必需 | 是 | 是 |
| escalate_model | `api.commit(tx => configure(tx, api.conversationId, { model: STRONG }), ctx)`；写 review.agent_model | 否 | 否；下一请求生效【原文】；主比较中 block |
| release | T5（带 usedMicro）；memo；terminate | 否 | 否 |

### 8.4 hooks（`extension/hooks.ts`）

```ts
const TERMINAL = new Set(["dispose", "release"]);
hook(ToolTask, {
  beforeTool: async (call, api, ctx) => {
    const g = grants.get(api.conversationId);
    if (!g) return { block: "E_LEASE_LOST" };
    if (g.mode === "finalize") return TERMINAL.has(call.name) ? undefined : { block: "finalize: 只允许 dispose/release" };
    if (g.mode === "revoked") return { block: "E_LEASE_LOST" };
    if (call.name === "escalate_model" && !FLAGS.escalation) return { block: "escalation disabled" };
    if (!ALLOWED_TOOLS.has(call.name)) return { block: "tool not allowed" };
    if (core.hasTerminal(g.reviewId)) return { block: "审次已终结" };                 // 终结后的同轮其他工具
    const st = core.leaseStatus(g.reviewId, WORKER_ID, g.attempt);
    if (!st.held) return { block: "E_LEASE_LOST" };
    if (st.deadlinePassed) return { block: "E_DEADLINE_PASSED" };
    const spent = core.spentMicro(g.reviewId, microOf(await api.snapshot(UsageDoc, api.conversationId, ctx)));
    if (spent >= g.budgetMicro && !TERMINAL.has(call.name)) return { block: "E_BUDGET_COST: 只能 release 或 dispose" };
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
    core.recordModelCall(api.taskId, g, message.usage);                                              // T13
  },
  afterTools: async (_a, results, api, ctx) => {
    const g = grants.get(api.conversationId); if (!g || g.mode !== "active") return;
    const st = core.leaseStatus(g.reviewId, WORKER_ID, g.attempt);
    if (!st.held) { hostLoop.request({ conversationId: api.conversationId, kind: "abort", reason: "revoked" }); return; }
    if (core.hasTerminal(g.reviewId)) return;
    if (core.roundHadBlocked(g.reviewId, "budget_tools")) { hostLoop.request({ ..., kind: "release", reason: "budget_tools" }); return; }
    const spent = core.spentMicro(g.reviewId, microOf(await api.snapshot(UsageDoc, api.conversationId, ctx)));
    if (spent >= g.budgetMicro) hostLoop.request({ ..., kind: "release", reason: "budget_cost" });
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

`beforeTool` 收到的 `api.taskId` 是当前 ToolTask 的 id，不是生成轮次（同轮各工具是不同的 ToolTask【源码，tool.ts ToolTaskInput {assistant, callId}】），所以不按轮次记账，改为查 app.db 的终结状态。`HookApi`（taskId、conversationId、memo、DocumentReader）**没有 `conversation()`**【原文】，所以 hook 只向宿主控制循环（`host-loop.ts`）投递请求，控制循环用 `harness.conversation(id)` 执行 T5 → `abort()` → `waitForIdle()` → 删除 grant。abort 的实际取消行为在 §15.1 验证。

### 8.5 证据：as-of 边界、模型可见片段、白名单

**边界**：审次创建时记 `snapshot_seq = ledger_seq.value`。所有取证查询加 `ingest_seq ≤ review.snapshot_seq`（知识边界），业务过滤用 `event_time`。

**历史有效裁决**：
```sql
SELECT action FROM ruling WHERE content_id=? AND ingest_seq <= :snapshot_seq ORDER BY seq DESC LIMIT 1
```
取边界内已入库的最高审次序号，不是入库最晚的一条。

**模型/判官看到的**（`evidence.model_view`，受限）：

| 工具 | model_view | 查询 |
|---|---|---|
| get_thread_context | 前后各 3 条：`{content_id, text（截断 200 字）, account_id, event_time, prior_effective_action}`，整体 `untrusted:true` | content `thread_id=? AND ingest_seq ≤ snapshot_seq`，按 event_time 取邻居；prior_effective_action 用上面的 SQL |
| get_account_history | 结构化：近 7 天各动作计数、最近 5 条裁决 `{seq, action, rule_ids, created_at}`、申诉次数 | synth_event `account_id=? AND ingest_seq ≤ snapshot_seq AND event_time ≥ created_at − 7d`；ruling JOIN content ON content_id 取 account_id，`ruling.ingest_seq ≤ snapshot_seq AND ruling.created_at ≥ created_at − 7d` |
| find_similar_dispositions | `{content_id, simhash_distance, action_as_of, event_time}` | content + ruling 同上 |
| load_rule | 规则正文与例外（可信通道） | rules_ver |
| get_image | 图给判官；主模型有视觉能力时也作为内容块给主模型 | 图片不可变 |
| judge / confirm | 输入 = 内容原文 + 所引证据 model_view；返回每个问题的校准概率；记录 evidence_set | input_sha 固定 |

**普通 API / 日志 / 仪表盘**：白名单列 `evidence_id, kind, source_ref, snapshot_seq, body_sha, created_at`。

验收 H-21：(a) 同毫秒新裁决、(b) 业务时间更早但入库更晚的事件、(c) 旧审次晚于新审次完成，旧审次的工具结果全部不变。

### 8.6 faux provider（harness 测试）

`fauxProvider()` 脚本化回复。**含工具调用的脚本回复必须带 `{ stopReason: "toolUse" }`**：`faux.setResponses([fauxAssistantMessage([fauxToolCall("get_thread_context", {...})], { stopReason: "toolUse" })])`【原文，pi-ai README 1456–1461】；默认 stopReason 是 `"stop"`，durable 会把它当最终答案【源码】。faux 的响应队列按请求开始顺序消费，多个并发会话不是确定性的【原文，README 1507/1515】：harness 测试每会话一个 faux provider（不同 provider id，agent.model 指向各自模型），或 `ADMIT_MAX=1`。判官用 `judges/recorder.ts` 录制的响应回放。崩溃点用 `CRASH_AT` 触发 `process.kill(process.pid, "SIGKILL")`。

---

## 9. 判官适配器与策略引擎

### 9.1 classifier API

**Jev 已可用（2026-10-08 实测）**：原生 System One 协议，`jev-1.13.0`，choice 概率 + noul，单次 0.24–0.32s，约 480 输入 token/次；一次调用可含多个问题【实测】。接入写法（pi-ai 内置 API 实现 + 自建 provider）：

```ts
import { createProvider } from "@earendil-works/pi-ai";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import { llamaCppClassifyApi } from "@earendil-works/pi-ai/api/llama-cpp-classify.lazy";   // 仅作标签约定参考

export const judgeProvider = () => createProvider({
  id: "mod-judges",
  auth: { apiKey: { name: "JEV_API_KEY", resolve: async () => ({ auth: { apiKey: process.env.JEV_API_KEY } }) } },   // 【待核：auth 形状】
  models: [
    { type: "classifier", id: "jev-latest", name: "Jev 1.13", api: "typesafe-system-one", provider: "mod-judges",
      baseUrl: process.env.JEV_BASE_URL, input: ["text"], cost: PRICE_JEV, contextWindow: 8192 },
    { type: "classifier", id: "qwen3.8-flash-logprob", name: "Qwen3.8 flash logprob", api: "openai-logprob", provider: "mod-judges",
      baseUrl: RELAY_URL, input: ["text"], cost: PRICE_QWEN, contextWindow: 32768 },
    { type: "classifier", id: "laya-mm-322m", name: "Laya multilingual 322M", api: "laya-batch", provider: "mod-judges",
      baseUrl: LAYA_URL, input: ["text"], cost: ZERO, contextWindow: 8192 },
    { type: "classifier", id: "clef-flash", name: "Clef flash", api: "clef-mm", provider: "mod-judges",
      baseUrl: CF_URL, input: ["text", "image"], cost: ZERO, contextWindow: 8192 },
  ],
  classifiers: {
    "typesafe-system-one": typesafeSystemOneApi(),        // 内置实现；URL = baseUrl 去尾斜杠 + "/systemone"【源码】
    "openai-logprob": openaiLogprob(),
    "laya-batch": layaBatch(),
    "clef-mm": clefMm(),
  },
});
```
`name` 是必填字段【原文，BaseModel】。自定义 provider 必须在 `classifiers` 里按 API id 注册实现【原文，README "Custom providers register classifier models and implementations by API ID"】。

- `openai-logprob`：提示构造沿用 pi-ai `llama-cpp-classify` 的标签约定（单 token 标签，顺序 A–Z、a–z、0–9，最多 62 选项【原文】）；请求参数是本项目的 OpenAI 兼容写法 `max_tokens:1, logprobs:true, top_logprobs:20`（llama-cpp-classify 自身用的是 llama-server 原生参数，不同）。**解析契约**：对每个配置选项在 top_logprobs 中匹配去除前导空格后等于该标签的 token，多个匹配取最大；**配置的选项必须全部匹配到，否则 abstain**；`mass_covered = Σ exp(logprob)` < 0.5【估计阈值】也 abstain；首个 token 不是任何标签 → abstain。中转站 qwen3.8-flash、glm-5.3 返回 top_logprobs【实测】；视觉模型不返回【实测】。
- `laya-batch`：10ms 窗口或 64 条微批。
- `clef-mm`：Cloudflare System One transport 只发 state/questions，发送前经 `onPayload`【源码】；先试 onPayload 透传 images（§15.6），不行则直接调 Cloudflare REST。内置 image_check 问题：`{kind:"image_check", criteria:{violent, weapon, qr_or_contact, none}}`，阈值在 scenes.yaml。

### 9.2 校准与复问

- 温度缩放：T 在开发集上最小化 NLL；文件 `calib/<judge>/<rule>@<ver>.json`。桶键 = 判官模型 id × 规则版本 × 场景 × 选项数；任一变化 → 文件缺失 → `calibrated: null` → 不进入有效答案。isotonic ≥1,000 样本才启用。
- **确认（confirm）**：同一 input_sha、同一问题、打乱选项顺序（`shuffle_seed`）的第二个答案，`confirms_call_id` 指向原调用。统一口径：**所有自动放行（fastpath 与 agent）都必须确认**。**3b 实测（2026-10-07，Jev，50 条自写句子 × 3 问题）**：同调用两份、分开两次、原样重复三臂的 choice 一致率都是 100%，违规概率平均差 0.002–0.003，p90 ≤ 0.01，即 **Jev 对同一输入基本是确定性的，打乱选项也不改变答案**。因此对 Jev 来说，确认不是独立采样，它只守住"选项顺序敏感"这一种失效；堵住"逐步加证据碰低分"靠的是证据集合分组（§5.4 第一步），不是采样噪声。决定：快判用同调用两份（多约 325 个输入 token、0 次额外调用、0 延迟），W 的 confirm 工具保留但只对非确定性判官（logprob 判官）才有信息量；评测卡注明。实现两种：
  - G 快判：在同一次 System One 调用里，每个规则问题放两份（原序 + 打乱序，question_sha 相同、`variant` 不同），一次调用得到原答案与确认答案（Jev 一次调用多问题【实测】；两份答案是否足够独立 **待 E-03 用一致率与分开两次调用对比后决定**，不独立则改为两次调用）。
  - W：`confirm` 工具单独调用一次。
  - 规则：确认对 (a, b) 的两次各自满足放行条件才算 `confirmed(pass)`；argmax 不一致 → 该组 inconsistent。成本：放行侧 token 约翻倍（快判）或 +1 次调用（W）【估计】，E-03 重测。

### 9.3 策略引擎（`policy/engine.ts`）

- 输入：judge_answer 校准概率 + scene + rules_ver；输出三态与命中规则。纯函数，100% 单测。
- **快判一次调用包含**：场景适用规则的全部规则问题 + 这些规则的全部例外问题 +（含图时）内置 image_check 问题。带例外的规则，例外问题未得到 `not_applies` 答案时**不得快拦**，只能 suspicious（U-01、U-09 用例）。
- `status ≠ ok` 或无校准 → suspicious；judge_down → S2'（reason=judge_down），绝不 pass。含图：pass 必须等 image_check 完成；文本 block 可直接 block；image_check abstain/timeout → suspicious。
- 引擎与 allowedActions 共用同一套阈值读取函数与 `ruleAllowed(r)`。

---

## 10. 规则、校准、版本固定

- 规则 YAML 字段（v2.3 §6.3）+ 本文新增：`question.pass_choices`（放行选项列表，§5.4）；无 `allowed_actions` 字段，规则级允许动作 = `{pass} ∪ {default_action}`；场景级白名单在 `config/scenes.yaml`。
- **策略包版本** `rules@<sha>` = `rules/` 目录 **与 `config/scenes.yaml`** 的联合 git tree sha（`git rev-parse HEAD:rules` 与 `HEAD:config/scenes.yaml` 拼接后 sha256）。scenes.yaml 决定必查类别、动作白名单、image_check 阈值、可见性与截止，是安全策略的一部分，必须随审次固定；改 scenes.yaml = 发布新策略包，走影子/门槛/灰度。其余版本：`calib@<sha>`、`prices@<sha>`、`evidence@<ver>`。审次创建时写入 review 行；W 按 review 行读取（`policy.bundleAt(ver)` 同时给出规则与场景配置）。
- 灰度：`hash(content_id) % 100 < rollout_pct` 的新审次用新版本。
- 影子回放两类：只改 thresholds/scenes/default_action/路由 → 复用旧 judge_answer 校准概率重算三态；改 text/exceptions/question/选项 → 用固定证据重新调用判官，费用计入报告。`insufficient` 的判定：影子规则需要的问题在旧 judge_answer 里没有且无法在固定证据上重调（例如需要新工具证据）→ 该样本标 insufficient，不计入可上线结论。
- 发布门槛绑定配置：`gate_run(config_sha)`；`/api/rules/rollout` 要求匹配且 passed=1，否则 409（D-14）。四项门槛：contract tests 100%；目标样本翻转率达预期；回归池无退化；成本与转人审量不超限。
- contract tests 两层：CI 用录制响应；发布前 `pnpm run contract:real`。
- 工具代码变更：换 `WORKER_VERSION`，新审次才用。
- 规则生效时延：`/api/rules/rollout` 返回时刻 → 首个用新版本的审次创建时刻，写 metrics；验收 ≤5 分钟（E-04）。

---

## 11. 评测执行协议

### 11.1 数据冻结、11.2 疑似集冻结

同前：`freeze.py` 切分 + 泄漏检查 + blind 加密；`suspicious.py` 固定入口判官与路由，输出 `suspicious.<split>.ids`，四组共用，脚本拒绝不带 `--suspicious-file` 的运行。

### 11.3 四组运行器

| 组 | 实现 | 审次生命周期 |
|---|---|---|
| B | 判官一次：内容 + scene → 三态 | **不走** T3–T4；无 review 行 |
| B+ | 固定取证 → 全部证据 model_view + 内容 → 判官一次 | 不走 T3–T4；取证用案例清单里冻结的 snapshot_seq |
| A | W 脚本驱动模式：同样的生命周期（T3、deadline、T11、hooks、T4、allowedActions、confirm），工具顺序固定（历史 → 线程 → 相似 → 规则 → judge → confirm）后主模型一次判断并调用 dispose/release | 完整 |
| C | 完整 W | 完整 |

B/B+ 的指标映射：pass/block = 自动完成，suspicious = 转人审；它们的时延与成本不含审次开销，**不与 A/C 横比时延**，只比质量指标。主比较 C 对 A。

**证据边界由案例清单冻结，不由任一组的运行产生**：`suspicious.py` 在冻结疑似集时同时为每条内容记下 `snapshot_seq`（= 基线库当时的 ledger_seq）写入案例清单；实验模式下 T2' 从案例清单读取该值而不是取库内当前值（`EXPERIMENT_CASELIST=<file>`）。于是 A/B/B+/C 对同一内容看到完全相同的历史，组内先后完成的其他裁决不会进入后续审次的证据。各组独立环境（`sqlite3 app.base.db ".backup app.<group>.db"`；独立 `SESSION_DB`、`OUT_DIR`、`CACHE_NS`）只是防缓存与写冲突，不是证据隔离的依据。"连续审核如何影响后续历史"若要研究，另做系统级实验。执行约束：`FLAG_ESCALATION=false`；主模型固定；人审配额 `K=30/千条`【估计】；人工 oracle 介入前后分开报。

### 11.4 指标定义

| 指标 | 分子 | 分母 | 备注 |
|---|---|---|---|
| 自动误放率（按违规） | 被自动放行的违规样本 | 全部违规样本 | 主指标 |
| 自动放行精度缺口 | 被自动放行的违规样本 | 全部自动放行样本 | 解释 |
| 自动误拦率（按正常） | 被自动拦截/限流的正常样本 | 全部正常样本 | 主指标 |
| 自动完成覆盖率 | 自动形成裁决的样本 | 疑似集全部样本 | |
| 转人审率 | release 样本（含超时、预算、撤权） | 疑似集全部样本 | 超配额未处理另列"待处理" |
| 自动裁决时延 p50/p95 | 审次创建 → 裁决 | 自动完成样本 | |
| 自动阶段终止时延 p50/p95 | 审次创建 → 裁决或 release | 疑似集全部样本 | 超时样本按 release 时刻计入 |
| 成本（微元/条） | used_micro（settled 或 estimated 分开报） | 疑似集全部样本 | 另报 over_budget 分布、物理/逻辑调用比、confirm 占比 |
| 三项吞吐 | 接入速度 / 快判完成速度 / 完整审核完成速度（条/秒） | – | v2.3 §5.4 |
| 安全赛道 | 模型被诱导率（轨迹里出现与注入一致的动作建议）/ 代码阻止率（T4 拒绝）/ 正常内容误拒或误转人审率 | 每组 300 条配对 | v2.3 §9.2 |

配对 McNemar；Wilson 区间；按案例族/类别/场景分层。评测卡字段缺一报错。

### 11.5 对账（`core/reconcile.ts`）

**即时安全约束（任何时刻可查，含崩溃中途）**：
1. 不重复（副作用级）：每个 `event_id` 在 delivery_receipt 的收据数 ≥ 1 时，consumer_log 恰 1 行且 downstream 只应用一次；崩溃用例断言收据数 ≥ 2 且 applied=1（D-06、H-05）。
2. 不倒退：`downstream_state.applied_seq` ≤ 已 sent/acked ruling 事件的 max(seq)，且 ≥ 已 acked ruling 事件的 max(seq)。
3. 三项分开的检查：
   - **守恒**（无时限）：content 每行在 intake 有记录；intake 每行处于 `status IN ('received','preprocessed')`（有归属：待 G 处理）或 `status='judged' AND judged_review_id IS NOT NULL`；review 非终态行处于 `queued` / `investigating` / `human_queue AND EXISTS(human_queue 未关闭)` 之一。只证明"有记录、有归属"。
   - **排队超时**（明确时限，`INTAKE_QUEUE_MAX_MS=60000`、`AGENT_QUEUE_MAX_MS=DEADLINE`）：`received/preprocessed AND created_at < now − INTAKE_QUEUE_MAX_MS` 或 `queued AND deadline_at < now − 2×SCAN_MS` 或 `investigating AND lease_until < now − 2×SCAN_MS` → 报"超时未处理"，这是队列与控制循环的问题，不是丢失。
   - **控制循环健康**：G 把每次 `control.tick` 的时刻写 `metrics_minute`（或 health 表）；`now − last_tick > 2×SCAN_MS` → 报"控制循环停摆"。
4. durable 侧（两种模式）：**W 活着** → 调 `GET /sessions`：每个 active grant 的会话有活任务或 submission 状态 settled；没有 app.db 为 active 而 durable 既无活任务又无 settled submission 的审次。**W 已死** → reconcile **取得并持有 `w.lock` 直到关闭存储**，用 `openNodeSqliteStorage` 正常打开 session.sqlite（该函数没有只读选项【源码，storage/sqlite/node.ts】，打开会设置 WAL 等参数）+ `inspect()`，不 resume、不 submit；这是独占离线检查，不是只读读。不用 memo 判断终态。

**排空后的最终一致**：
5. `content_state.effective_seq` = ruling 的 max(seq)（对所有有 ruling 的内容，含快判路径）；`downstream_state.applied_seq` = 已 acked ruling 事件的 max(seq)；`downstream_human.pending=1` 的审次集合 = human_queue 未关闭集合。
6. **进入过 durable 的**终态审次（`conversation_id IS NOT NULL`）其 submission 状态为 done 或 unanswered，无活任务；快判直接完成、未进 W 即转人工后人工完成的审次标"不适用"，不算失败。
7. 终结：等待 ≤ 3 × deadline，测试任务全部到达终态或 human_queue。

崩溃矩阵（`scripts/crash-matrix.sh`）：CRASH_AT ∈ {A,B,C,D} × 随机。演示前最小量 ≥ 20 次；W7 汇总 ≥ 50 次（v2.3 §9.2 Wilson 上界口径）。每次后跑即时约束，排空后跑最终一致。

---

## 12. 测试用例目录、夹具、CI

### 12.1 单元（test/unit，无 IO）

| ID | 对象 | 要点 |
|---|---|---|
| U-01 | engine.ts | 三态边界、无校准只给 suspicious、judge_down 不 pass、**带例外规则未问例外不得快拦** |
| U-02 | calib.ts | 温度拟合单调性、ECE、桶键变化 → null |
| U-03 | states.ts | S1–S11、S3' 全枚举，非法转换抛 E_STATE_INVALID |
| U-04 | submit-check.ts | 步 1–11 每步失败 + 通过；步 6 通过用例带 blocked 行；人工零证据 pass 通过、零 ruleIds 的 takedown 被拒；步 4 两码映射 |
| U-05 | ids.ts | review_id 往返；rule_change 的 trigger_request_id |
| U-06 | redact.ts | 含 text/body/reason/model_view 的对象脱敏 |
| U-07 | rules.ts | YAML 加载、版本 sha、contract 解析、ruleAllowed |
| U-08 | openai-logprob 提示构造 | 标签顺序 A–Z/a–z/0–9；请求参数 |
| U-09 | allowed.ts | §5.4 第二步全分支，含 covered(c) 多规则、image_check 内置、例外 unknown 不拦 |
| U-10 | openai-logprob 解析 | 缺任一选项 → abstain；多 token；前导空格；mass 不足 |
| U-11 | shadow.ts | 变更分类；insufficient 判定 |
| U-12 | effective.ts | 唯一极大替代；同证据不一致；不可比 → none；rule 证据不改变集合；confirmed(action) 判定：两次各自满足、choice 同为 pass_choices、0.20→0.02 不算、unknown 不算、确认对的 input/question/model/calib 必须一致 |
| U-13 | consumer.ts | T10 规则（含收据） |
| U-14 | control.ts | tick 对过期/过截止/attempt 上限的分支 |

### 12.2 core 集成（真实 SQLite 临时文件，node:sqlite）

| ID | 用例 |
|---|---|
| D-01 | T2 重复调用返回同一 ruling；S1 后 content_state 存在（upsert） |
| D-02 | T3 两个 worker 并发只一个拿到租约；过截止 / attempt ≥ MAX 不发放；0 行回读区分 E_LEASE_HELD / E_STATE_INVALID |
| D-03 | T4 后 content_state 正确；旧 seq 写入被 WHERE 拒；复合 FK 拒绝 seq 不一致的 ruling |
| D-04 | T6 原子性 |
| D-05 | audit 触发器；哈希链 |
| D-06 | 同事件投递两次：收据 2、consumer_log 1、applied 1；旧 seq → stale |
| D-07 | 拒绝审计在 ROLLBACK 后仍存在（T15 新事务） |
| D-08 | T9：同请求标识重试返回原审次；不同内容冲突；上一审次未终态 → E_STATE_INVALID；同 request_id 换 trigger 不开新审次；两个不同请求得两个序号 |
| D-09 | content_state 待审初态 NULL/0；CHECK 约束 |
| D-10 | release → 人工 ruling 同 seq 仍 applied；**重复投递**同 event_id 的 release → 返回原结果 notified（不改状态）；**第一次送达但已过时**的 release（人工 ruling 已先到）→ stale_notification；旧 seq 的 ruling 第一次送达 → stale，重复投递 → 返回原结果；downstream_human 按审次关闭 |
| D-11 | T11 重放不重复占用；release 不计次；blocked 行不计入 usedToolSlots；T12 同 request_no 重复结算空操作；同一逻辑调用"第一次 settled + 第二次 unknown"时费用公式同时计入已知与估计 |
| D-17 | ruling 三列外键：review_id 指向审次 A、content_id/seq 指向审次 B 的行被拒；正确组合可插入 |
| D-18 | T3' 对过期租约（lease_until < now）续租失败 → E_LEASE_LOST；对已撤销代次续租失败 |
| D-12 | 两连接竞争：A 持写锁 1s，B（busy_timeout 1500）拿到；A 持 3s，B 得 SQLITE_BUSY 后有限重试成功；deferred BEGIN 在他人提交后 BUSY_SNAPSHOT（证明必须 IMMEDIATE）；记录 B 等锁期间事件循环停摆时长 |
| D-13 | ledger_seq 并发取号严格递增无重复 |
| D-14 | rollout 在 gate_run.config_sha 不符时 409 |
| D-15 | T5 旧代次 release → E_ATTEMPT_STALE；T7 条件 |
| D-16 | 守恒：卡在 received 超过 2×SCAN_MS 的内容被标出；queued 过截止被标出 |

### 12.3 harness 不变量（faux + 录制判官，不花 token；每会话独立 faux provider）

| ID | 用例 | 证明 |
|---|---|---|
| H-01 | 初审下架 → 申诉新审次放行 → 重放初审旧 outbox 事件 → effective 仍 pass | v2.3 首个验收 |
| H-02 | H-01 在 CRASH_AT=B kill → 重启 → ruling=1 | |
| H-03 | H-01 在 CRASH_AT=C kill → 重启 → finalize 读回，ruling=1，memo 补上；会话终结、submission settled | （合并原 H-23） |
| H-04 | CRASH_AT=A kill → 重启 → 续跑完成 | |
| H-05 | CRASH_AT=D → 重投 → 收据 ≥2、applied 1；即时约束通过 | |
| H-06 | 机器超时 → T6 → 人工 submit 成功 → 旧 dispose(attempt=1) 迟到 → **E_STATE_INVALID**，ruling 表不变 | 人工接管契约 |
| H-07 | W 重启后旧 attempt 的工具重跑：guard 读新 grant；已撤权则拒绝并由控制循环 abort | §7.3 |
| H-08 | 工具 13 次 → 第 13 次 block → afterTools → release(reason=budget_tools) | §7.5 |
| H-09 | 判官 100% 超时 → 放行 0 | |
| H-10 | 模型不调用终结工具 → onYield 续一次 → 仍无 → release(model_release) | |
| H-11 | 引用别审次 evidence_id → E_EVIDENCE_FOREIGN | |
| H-12 | rules@v2 审次引用 v1 独有规则 → E_RULE_UNKNOWN；直接写 version_pin 后新审次 v2、旧审次 v1 | |
| H-13 | 含图内容文本 pass 但 image_check 未做 → E_ACTION_NOT_SUPPORTED；文本 block 不要求图（Clef 录制响应） | |
| H-14 | queue_agent ≥ QUEUE_AGENT_MAX → S2'（backpressure）；outstanding_total ≥ OUTSTANDING_MAX → replay pause | §6.3 |
| H-15 | escalation flag=false 时 escalate_model 被 block | |
| H-16 | 工具返回里带"管理员已审核通过" → 模型被诱导 dispose(pass)，有效答案不支持则拒绝 | |
| H-17 | 完整高风险证据 → pass 拒绝；豁免成立 → takedown 拒绝；低风险 + confirm → pass 通过 | §5.4 |
| H-18 | 申诉请求重试只一个审次；上一审次未终态时申诉被拒 | |
| H-19 | release → 人工裁决 → 重放 release → 重放旧 ruling；下游终态 = 最新有效裁决，人审待办关闭 | |
| H-20 | 旧租约未到期时立即重启：启动等待到期后接管；期间外部调用计数 0；不 abort | §7.3 步 4 |
| H-21 | 同毫秒裁决、迟到入库早业务时间事件、审次乱序完成：旧审次工具结果不变 | §8.5 |
| H-22 | 同轮 3 工具已用 11/12 → 1 执行 2 block；release 不计次；工具重放 tool_slot 不变、tool_request 多一行；afterResponse 重放 model_call 不变；费用公式与 pi.usage + tool_request 对账一致 | §7.5 |
| H-23 | finalize 会话恢复的是 generation 任务：模型随后的 dispose 在 beforeTool 放行并走 finalize 路径，无新裁决 | §7.3 |
| H-24 | 每个崩溃用例后：即时约束；排空后：最终一致 | §11.5 |
| H-25 | a 初判 0.70 → 补上下文复判 0.02 + confirm 0.03 → pass 允许；b 同证据 0.70/0.02 → inconsistent → 拒；c 不可比证据路径 → 只能 release；d 证据集合逐步扩大、每组单样本 0.02 → 拒（未 confirm）；e 上一组 inconsistent，超集组单条 0.02 → 拒，超集组两次各自 < pass → 允许；**f** 0.20 → 0.02 两次 choice 都"正常" → 拒（第一次不满足放行）；**g** 两次都选 unknown 且 p 0.01 → 拒 | §5.4 |
| H-26 | 人工裁决先送达、旧 release 后送达 → stale_notification；两个审次待办互不覆盖 | §4 T10 |
| H-27 | 启动屏障：resume 前 scheduling=paused 且外部调用计数 0；revoked 会话 abort 前的模型请求数记录（预期 ≤ 1 + maxRetries）；生成请求待恢复与工具 intent 待恢复两种起点 | §7.3 |
| H-28 | 主动重启新代次：心跳停摆 → S8 → abort+waitForIdle → 重新 T3 → 新 requestId；旧在飞调用不得以新 attempt 提交 | §7.4 |
| H-29 | S8 requeue 后新代次 investigating，旧 attempt 的 dispose 迟到 → E_ATTEMPT_STALE | §5.2 步 4 |
| H-30 | 准入并发不超过 ADMIT_MAX | v2.3 §5.3 |
| H-31 | 提交缝隙：(a) conversation 已绑定、submit 前 kill；(b) submit 已持久化、submission_id 回写前 kill → 重启后步 8 幂等取回同一 submission，审次只有一份逻辑审核，ruling ≤ 1 | §7.3 步 8 |
| H-32 | 业务终结后的宿主收尾：dispose 成功且模型同轮还发了另一个工具 → 该工具被拒；宿主 abort 会话；多余模型请求次数记录 | §8.3 |
| H-33 | fastpath 远离边界的正常内容（p=0.02）：快判含确认答案 → T2 通过；缺确认答案的快判结果 → T2 拒绝（E_ACTION_NOT_SUPPORTED） | §5.4、§9.2 |

### 12.4 contract tests 夹具

同前：`fixtures/refs.yaml`（含 `required`），`scripts/fetch-fixtures.sh` 拉取公开数据集并校验 sha256；运行器输出 planned/executed/passed/skipped，required 缺失 = fail；自写无害夹具在 `fixtures/benign/`；两层运行。

### 12.5 真实模型 e2e（默认跳过，`RUN_REAL=1`）

| ID | 用例 | 成本【估计】 |
|---|---|---|
| E-01 | 20 条短文本走完整 C 组，终态校验 | ¥1 |
| E-02 | 注入配对：MVP 30 条冒烟；W6 安全赛道 300 条 | ¥2 / ¥20 |
| E-03 | Jev 100 条 + 校准拟合冒烟；logprob 判官 100 条；**快判含确认答案的新口径**：单次调用内两份问题 vs 分开两次调用的一致率、token 与延迟对比，决定快判确认实现方式 | ¥1 |
| E-04 | 规则 rollout 生效时延 ≤ 5 分钟 | ¥0 |

### 12.6 CI

已入库并通过（`.github/workflows/ci.yml`：node 作业 install/check/test:unit/test:harness/fetch-fixtures/contract/redact-scan；python 作业 uv sync/pytest）。`redact-scan` 是启发式提示，不是泄漏边界。

---

## 13. 部署与配置

### 13.1 开发机、13.2 进程与启动

同前（Cloud Studio 2 核 4G；`scripts/start.sh` G → W → replayer；`.env` 以 `.env.example` 为准）。运行参数：`APP_DB`、`SESSION_DB`、`ADMIT_MAX=10`、`LEASE_TTL_MS=30000`、`DEADLINE_MS_SHORT=60000`、`MAX_ATTEMPTS=3`、`SCAN_MS=2000`、`INTAKE_QUEUE_MAX_MS=60000`、`QUEUE_AGENT_MAX=50`、`QUEUE_HUMAN_MAX=500`、`OUTSTANDING_MAX=2000`、`EXPERIMENT_CASELIST`（实验模式）、`FLAG_ESCALATION=false`、`CRASH_AT`、`LOG_LEVEL`。

### 13.3 中转站 provider 与模型能力

同前；视觉能力逐个实测写入 `config/models.json`；自动放行所需 image_check 必须来自校准判官。

### 13.4 日志与脱敏

同前（pino serializer；受限存储 600；备份不出开发机）。

### 13.5 SQLite 使用规则（node:sqlite，【实测】）

- `DatabaseSync` 等锁是同步的：busy_timeout 期间整个事件循环停摆（实测等锁 1.5s 内 setTimeout 不触发）。所以 **W 的 `busy_timeout=1500`，G 的 `busy_timeout=2000`**；事务体短；D-12 记录停摆时长，心跳周期 5s 远大于等锁上限。
- **所有写事务 `BEGIN IMMEDIATE`**：deferred BEGIN 读后写在他人提交后立刻 `SQLITE_BUSY_SNAPSHOT` 且 busy handler 不生效【实测】。代码审查项：`grep -rn 'exec("BEGIN")' packages` 必须为空。
- 嵌套 BEGIN 抛错：T15 必须在 catch 里先 `ROLLBACK` 再 `BEGIN IMMEDIATE`。
- `PRAGMA busy_timeout` 不持久化，每个连接打开时设置；`foreign_keys` 在 node:sqlite 默认开启（`enableForeignKeyConstraints`），仍显式设。
- `UPDATE … RETURNING` 可用。

### 13.6 Python 写路径

Python 回放器与 synth 导入**不直接写 content/synth_event**，而是调用 `pnpm run intake-cli -- --jsonl <file>`（core 的 T1 批量版，走 ledger_seq + BEGIN IMMEDIATE），否则 snapshot_seq 边界失效。Python 对 app.db 只读。

---

## 14. 开工顺序与停止条件

| 阶段 | 做 | 通过条件 | 停止条件 |
|---|---|---|---|
| 0 骨架 | 已完成【实测 2026-10-08】 | – | – |
| 1 core 语义 | T1–T17、states、effective（confirmed(action)）、allowed、submit-check、budget（tool_request）、control.tick、outbox.dispatchOnce、consumer.apply、reconcile.instant/final（app.db 侧 1–3、5、7）、intake-cli；策略包版本含 scenes.yaml | **已完成【实测 2026-10-07】**：U-01–U-14、D-01–D-18 共 49 个用例通过（本机、开发机、CI） | 任一反例无法在 node:sqlite 语义下关闭（例如 D-12 的停摆时长使心跳不可靠）→ 停下改设计 |
| 2 Pi 最小验证 | harness.ts、startup.ts（含步 8 提交缝隙）、grants、guard、host-loop（含业务终结后 abort 收尾）、工具（dispose/release/load_rule/线程/历史/judge/confirm 录制版）、hooks、faux 驱动、W /sessions、reconcile durable 侧（4、6） | **进行中【实测 2026-10-07】**：18 个用例通过——子进程 SIGKILL：H-02（B）、H-03/H-23（C）、H-04（A）、H-31a/b（S1/S2）、H-20（等待旧租约）、H-27（resume 前外部调用 0）；进程内：H-06/H-29、H-08、H-10、H-15、H-16、H-17、H-21、H-28、H-30、H-32。实现时发现：durable 的 conversation/submission id 是数字，app.db 存为文本必须转回；faux 的响应队列每个请求消费一项，脚本化工厂要重复安装；abort 后 waitForIdle 会等在飞工具返回，宿主收尾必须在工具可返回后进行。待补：H-05（子进程 D 点）、H-24 在崩溃后自动跑、H-22 工具重放计数 | Pi 1.0.4 下任一 H 用例无法实现 → 记录原因，评估 Plan B（AgentSession + sink 幂等）或改设计，不绕过 |
| 3 真实模型（拆 5 小步，每步一个提交） | 3a Jev 接 Pi：pi-ai 内置 typesafe-system-one 注册，一次调用多问题 + 原序/打乱序两份；3b 确认方式实验：同调用两份 vs 分开两次各 50 条，比一致率与 token；3c 校准：用 3b 数据拟温度、可靠性图；3d 主模型接 Pi：qwen3.8-flash 关思考接 OpenAI 兼容 provider，1 条审次跑到 dispose，pi.usage 与记账一致；3e E-01：20 条短文本完整 agent | 3a：10 条自写句子答案入 judge_answer；3b：一张表定下快判确认方式；3c：calib 文件生成且 ECE 下降；3d：1 条终态且费用对账一致；3e：20 条全部终态、无重复裁决、成本有数 | 3a 渠道不支持多问题/两份问题 → 退回两次调用；3b 两份一致率明显低于两次调用 → 快判改两次调用；3d 中转站 usage 字段对不上 Pi 的 Usage → 先修记账；判官 abstain 率 > 30%【估计】→ 换判官 **3a 已通过【实测 2026-10-07】**：Jev 经 pi-ai 内置适配器，10 条自写句子、每次 6 个问题（3 原序 + 3 打乱），60 条答案入 judge_answer，10 对确认，平均 828ms，每次约 950 入 / 570 出 token；注入句不被带偏、引用举报句例外 applies 1.00、引流句 1.00。打乱副本与原答案几乎同值（0.50/0.53、0.69/0.71），独立性由 3b 判定。 **3b 已通过【实测 2026-10-07】**：三臂一致率 100%，|Δp| 均值 0.0017/0.0031/0.0017，同调用两份每句 950 入 token、696ms，分开两次 1251 入、1463ms；8 路并发 200 次调用 7 秒；快判定为同调用两份。 **3d 已通过【实测 2026-10-07】**：qwen3.8-flash（关思考）经 pi-ai OpenAI 兼容 provider + Jev 经内置适配器，1 条自写评论 24.7s 到 disposed(takedown, ABUSE-001)：线程 → judge（含同调用确认副本）→ load_rule → confirm → dispose，0 次拒绝；pi.usage 3,089 入 / 377 出 / 5,120 缓存读 token，费用公式 2,646 微元（¥0.0026）与 review.used_micro 一致、cost_status=settled。第一次跑暴露两个 bug（价格键、无心跳导致租约过期后循环 61 轮），已修：价格按 provider/model、judge 失败也结算、每代次模型请求上限、Worker.startLoops()。 **3e 已通过【实测 2026-10-07】**：20 条自写评论、4 路并发，98s 全部到终态：15 disposed（8 pass、4 limit MARKETING-003、3 takedown ABUSE-001）+ 5 human_queue（边界句、引用举报句、注入句之一、推荐句、抽奖句，均 evidence_gap）；重复裁决 0；即时对账 0 违例；总费 ¥0.121、每条 ¥0.006；6 条各有 1 次提交被拒后模型纠正（权限门在工作）。最终一致的 human_pending 差异是脚本未跑 dispatcher 所致，已加 drain。**3c**：校准工具（fitTemperature/ECE，U-02）已就绪；Jev 对同一输入确定性、概率多为 0/1，真正的温度拟合需要冻结的带标注开发集（W5），50 条自写句子不够做拟合，不伪造。 |
| 4 接入与界面 | G intake/预处理/快判/S1/S2/S2'；G 定时调用控制循环与 dispatcher；背压；/api/metrics 与静态页；人审页最简；/restricted 鉴权；Clef 录制版 + get_image | 回放 500 条；H-09、H-11–H-16 过；H-24 在回放后通过 | – **已通过【实测 2026-10-07】**：G+W 真实进程、Jev 快判、qwen3.8-flash 主模型，500 条自写回放 5 条/s 泊松 113s 发完、223s 排空；快判 467（382 pass / 53 limit / 32 takedown），疑似 33 → agent 8 takedown + 25 转人审（13 evidence_gap、2 budget_tools、10 timeout）；outbox 500 acked；重复裁决 0；即时与最终对账 0 违例；判官 1,230 次调用、17 次 error（1.4%）、平均 587ms；agent 33 条合计 ¥0.17。**观察**：agent 排队等待 p50 24s / p95 37s（ADMIT_MAX=6 饱和），工作 p50 25s / p95 42s，comment 场景 60s 截止过紧 → 10 条 timeout；agent 每条 6–16 次工具、6–16 次模型请求，引用举报句（例外成立）与 0.87 的辱骂句按阈值都无法自动裁决、只能转人审，这是规则阈值问题不是系统问题。待调：comment deadline 改 120s 或提高并发；agent 取证效率归评测期（W6）。 |
| 5 故障、效果、演示 | crash-matrix ≥ 20 次（演示前最小量）；synth C0–C3；版本切换与 rollout；演示 3、5、1 降速、2 简版 | 四个演示各走一遍；reconcile 即时与最终一致全绿 | – |

阶段 1–2 预计 6–8 天【估计】；超期则 10-24 录屏只演示场景 3 与 5。

---

## 15. 开工前验证清单

1. durable 骨架与启动屏障：open → inspect() 断言 paused → 分类 → resume()；faux（每会话独立 provider）10 会话 kill 10 次；观测 `conversation.abort()` 对在飞生成任务的实际效果与请求次数。
2. node:sqlite：D-12 场景，记录停摆时长。
3. 中转站：主模型 tool call 往返；qwen3.8-flash top_logprobs；各模型图片输入能力逐个实测。
4. configure() 下一请求生效。
5. createProvider 的 auth 形状与 `typesafeSystemOneApi()` 接 Jev 渠道的一次调用【待核】。
6. Clef onPayload 透传（W4 前）。
7. 数据重叠与计数；云厂商调 1 条。

---

## 附录 V 第八轮审查（开发文档 v1.3）处理记录

| 审查项 | 处理 | 落点 |
|---|---|---|
| 1.1 快判与提交层对确认不一致 | 采纳：统一口径，所有自动放行必须确认；快判在同一次调用内放原序 + 打乱序两份问题，独立性由 E-03 验证，不独立则改两次调用 | §5.4、§9.2、H-33、E-03 |
| 1.2 两次 choice 相同 ≠ 都支持放行 | 采纳：confirmed(action) 要求两次各自满足条件、确认对的 input/question/model/calib 一致；规则声明 pass_choices，unknown 不放行 | §5.4、§10、U-12、H-25f/g |
| 2 复合外键不绑定同一行 | 采纳：三列联合外键 + review 三列唯一；T4 的 content_id/seq 从 review 行派生 | §2.2、§4 T4、D-17 |
| 3.1 submit 前后缝隙 | 采纳：启动步 8 在 resume 后按固定 requestId 幂等 submit 并补绑定 | §7.3、H-31 |
| 3.2 roundHasTerminal 的 taskId 是 ToolTask；block 不等于 terminate | 采纳：删除按轮记账；终结后 beforeTool 查 app.db 拒绝；宿主在业务终结后 abort 收尾；多余请求数作观测 | §8.3、§8.4、H-32 |
| 4.1 费用重复计入 | 采纳：judge_call.cost_micro 不参与求和；唯一公式 | §7.5 |
| 4.2 已知 + 未知混合；结算幂等；费用冻结 | 采纳：tool_request 表按物理请求记账、结算幂等；公式同时计已结算与未知；used_micro 可由 T17 后续更新，裁决不变；有 unknown 不标 settled | §2.2、§4 T11'/T12/T17、§7.5、D-11 |
| 5.1 守恒 2×SCAN_MS 过严 | 采纳：守恒 / 排队超时 / 控制循环健康三项分开 | §11.5 |
| 5.2 终态审次不一定有 submission | 采纳：按 conversation_id 判断适用 | §11.5 |
| 5.3 openNodeSqliteStorage 非只读 | 采纳：改为持锁独占离线检查 | §11.5 |
| 6.1 scenes.yaml 未入版本 | 采纳：策略包版本 = rules/ + scenes.yaml 联合 sha | §2.2、§10 |
| 6.2 各组证据环境漂移 | 采纳：案例清单冻结每条内容的 snapshot_seq，实验模式 T2' 读清单 | §11.3 |
| T3'/T5 过期租约 | 采纳：加 lease_until ≥ now 与撤销标记；过期不能续 | §4、D-18 |
| D-10 重复 vs 过时 | 采纳 | §4 T10、D-10 |
| 生成墙钟上界 | 采纳：含重试等待；stream 15s | §7.1、§8.1 |
| 多选题 unknown | 采纳：pass_choices | §5.4 |
| CI passWithNoTests | 如实：骨架检查，不代表用例通过；阶段 1 起每个问题对应先失败后通过的测试 | §14 |

## 附录 W v2.3 契约覆盖表

| v2.3 契约 | 机制 | 用例 | 阶段/周次 |
|---|---|---|---|
| §4 接流量：队列、路由、并发上限、背压、限流 | intake、ADMIT_MAX、§6.3 背压 | H-14、H-30 | 阶段 4 |
| §4 可恢复、幂等（四个崩溃点；申诉新审次） | §4、§7.3、§11.5 | H-01–H-05、H-18、H-24 | 阶段 2 |
| §4 规则治理：版本化、热更新、影子、灰度、门槛、≤5 分钟 | §10 | H-12、D-14、U-11、E-04 | 阶段 5 / W7 |
| §4 三层分流可见 | /api/metrics 字段 | 演示 1 | 阶段 4 |
| §4 人在环：人审队列、回流、候选阈值门槛 | human_queue、feedback、/api/calib（候选阈值计算、最小支持数 30/10、审批状态机：**W7 实现**） | H-06、H-19；回流用例 **W7 补** | 阶段 2 / W7 |
| §4 可观测：轨迹 100%、仪表盘、审计 | durable entries + G 快判路径的 judge_call/ruling 记录即轨迹（快判无会话）；audit 哈希链；pi-telemetry 适配器 **W7** | D-05；轨迹覆盖检查 **W7** | 阶段 4 / W7 |
| §5.2 裁决 vs 流转 | §3、T10 | H-19、H-26 | 阶段 1–2 |
| §5.3 审次、代次、一审次一会话、dispose 事务 | §4、§8.2 | H-02、H-03、H-07、H-28、H-29 | 阶段 2 |
| §5.3 人工接管契约 | §5.2 步 2–4 | H-06 | 阶段 2 |
| §5.4 容量、背压、可见性、主动超时 | §6.3、§3.3 visibility、T6 | H-14、H-06 | 阶段 2/4 |
| §5.4 三项吞吐 | §11.4 | 演示 1 | 阶段 5 |
| §6.1 预处理（归一化/AC/频控/simhash） | gateway/preprocess（规格：NFKC + 全角半角 + 繁简；AC 词表 rules/wordlist；频控 account 每分钟 N；simhash 64 位汉明 ≤ 3） | U-15（**阶段 4 补**） | 阶段 4 |
| §6.2 判官适配器、校准键、温度、打乱复问 | §9 | U-02、U-08、U-10、U-12（confirmed） | 阶段 3 |
| §6.2 含图必检 | §5.4 image_check、§9.3 | H-13 | 阶段 4 |
| §6.3 影子"证据不足"；门槛绑定配置 | §10 | U-11、D-14 | 阶段 5 |
| §6.4 工具、证据账本、权限门、动作相关证据 | §5.4、§8.3、§8.5 | H-11、H-16、H-17、H-25 | 阶段 2 |
| §6.4 预算与截止 | §7.5 | H-08、H-22 | 阶段 2 |
| §6.4 load_skill / 案例库 FTS5 | **后移 W6**（规则手册按需加载由 load_rule 覆盖最小需求） | – | W6 |
| §6.5 dry-run 模式 | **后移 W7**（outbox dispatcher 的 `DRY_RUN=1` 只记录不调用消费端） | – | W7 |
| §6.6 人审页脱敏、回流 | §6.1 /restricted、feedback | – | 阶段 4 / W7 |
| §9.2 agent 赛道执行细节 | §11.2、§11.3 | 评测脚本 | W6 |
| §9.2 harness 赛道 50 次崩溃 | §11.5 | crash-matrix | W7 |
| §9.2 安全赛道 300 条配对、两个口径 | §11.4 | E-02 | W6 |
| §9.3 云厂商对照 | python/eval | – | W8 |
| §12 非功能指标 | §11.4、/api/metrics | 演示 | 阶段 5 |

## 附录 X 第七轮自审处理记录

| # | 处理 | 落点 |
|---|---|---|
| 1 faux stopReason | 采纳 | §8.6 |
| 2 judge_call 多问题 | 采纳：judge_answer 表；effective 按 judge_answer 分组；§6.5 问题键 = question_sha | §2.2、§5.4、§6.5 |
| 3 content_state 无行 | 采纳：upsert；S1/S2/S2' 统一；visibility 规则 | §3.3 |
| 4 步 6 SUM | 采纳：usedToolSlots() 一处 | §4、§5.2 |
| 5 allowed_actions 字段 | 采纳：scenes.yaml 白名单 + ruleAllowed；limit/takedown 必须 ruleIds | §5.2 步 8、§10 |
| 6 例外与快拦 | 采纳：快判一次调用含例外问题；未问例外不得快拦 | §9.3、U-01 |
| 7 单采样放行 | 采纳：evidence_set 排除 rule；pass_support 要求 confirmed；confirm 工具 | §5.4、§8.3、§9.2、H-25d/e |
| 8 finalize 被 beforeTool 挡 | 采纳：finalize 放行终结工具 | §8.4、H-23 |
| 9 terminate 条件 | 采纳：注明；终结工具单独成轮；同轮混发被 block；多一次请求计数 | §8.3、§8.4、H-22 |
| 10 inspect 看不到 settled；跨进程 | 采纳：review.submission_id；W /sessions；reconcile 两种模式 | §2.2、§6.2、§11.5 |
| 11 T9 不查终态；UNIQUE 含 trigger | 采纳 | §4 T9、§2.2、D-08、H-18 |
| 12 T5 无代次检查 | 采纳；S7 只对应 T6 | §4 T5 |
| 13 T3 条件；N 未定义 | 采纳：MAX_ATTEMPTS=3；S3'；0 行区分 | §3.2、§4 T3、§13.2 |
| 14 node:sqlite 锁 | 采纳：§13.5 使用规则；D-12 改口径 | §13.5、D-12 |
| 15 ≤1 同义反复 | 采纳：delivery_receipt | §2.2、§11.5、D-06、H-05 |
| 16 守恒缺口；failed 状态 | 采纳：updated_at 判龄；queued 判截止；删 failed | §11.5、§2.2、D-16 |
| 17 B/B+ 生命周期 | 采纳 | §11.3 |
| 18 H-08 路径 | 采纳：afterTools roundHadBlocked | §7.5、§8.4 |
| 19 image_check 身份；H-13 阶段 | 采纳：内置问题；阶段 4 加 Clef 录制版 | §2.3、§5.4、§9.1、§14 |
| 20 Jev 接入写法 | 采纳 | §9.1 |
| 21 faux 并发 | 采纳 | §8.6、§15.1 |
| 22 快判 judge_call 绑定 | 采纳 | §3.2、§4 T2/T2' |
| 23 步 4 映射；H-06 | 采纳；H-29 新增 | §5.2、H-06、H-29 |
| 24 E_LEASE_HELD | 采纳 | §6.3、§8.4、§5.5 |
| 25 撤权审次成本 | 采纳：回退口径 | §7.5、§3.2 S7 |
| 26 费用公式；used_micro 单写 | 采纳 | §7.5 |
| 27 规则/类别混用 | 采纳：covered(c)；删 image_ok | §5.4 |
| 28 阶段与崩溃次数 | 采纳 | §14、§11.5 |
| 29 背压定义 | 采纳 | §6.3、§13.2 |
| 30 ruling join | 采纳 | §8.5 |
| 31 覆盖表 | 采纳：附录 W | 附录 W |
| 32 杂项 | 【原文】标注改正；llama-cpp 描述改正；revoked 请求数标【估计】；afterResponse 失败尝试注明；E_BUDGET_COST 入表；辅助函数列表；grant 字段统一；rule_change 标识；S6 列名；Python 写路径；DDL CHECK/FK/索引；stream 20s × 2 | 对应章节 |

## 附录 Y 第六轮、第五轮处理记录

见 `docs/history/dev-doc-v1.2.md` 附录 X、Y（内容未变，不再重复）。

## 附录 Z 与 v2.3 的差异记录

| 项 | v2.3 | 本文 | 理由 |
|---|---|---|---|
| 准入并发 | ≤20 | MVP 10，8 周目标 20 | 2 核 4G【实测】 |
| 短文本机器截止 | agent p95 ≤30s（验收） | deadline 60s | 硬边界 2 倍余量 |
| review_id → conversation_id | durable commit 内 ReviewIndex | app.db 列 | G 需要可见 |
| 工具执行模式 | 未写 | sequential | 轨迹可读 |
| MVP 排期 | 14 天 | 阶段 + 停止条件 | 第五至七轮审查 |
| 费用 | 元；每审次上限 | 微元；工具次数硬限制、费用软限制 | 第六轮 |
| MVP 入口判官 | logprob 或 Laya | Jev | 实测可用 |
| 放行条件 | 必查类别覆盖 | 覆盖 + 有效答案 + 复问确认 | 第五至七轮 |
| 规则字段 | 无 allowed_actions | 场景白名单 + {pass, default_action} | 第七轮 |
| load_skill / 案例库 / dry-run | 第一版 | 后移 W6/W7 | 附录 W |
