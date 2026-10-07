# 开发文档 v1.0：pi-moderation-agent

日期：2026-10-08。基于冻结的项目文档 `docs/project-doc-v2.md` v2.3。本文把 v2.3 的约定落成：仓库结构、数据模型与 DDL、状态转换表、事务边界、提交校验、接口与错误码、租约与取消、Pi 绑定写法、评测执行协议、用例目录与 CI、部署与配置、14 天 MVP 排期。

写法约定：
- 与 v2.3 冲突时以 v2.3 为准，并在本文附录 Z 记录冲突。
- Pi 的 API 名称、签名均来自本机安装的 `@earendil-works/pi-durable@1.0.4` 与 `@earendil-works/pi-ai@1.0.4` 的 `dist/*.d.ts` 与 README（2026-10-08 在开发机 `/tmp/pi-probe` 核对）。标注【待核】的是还没在代码里验证的点。
- 数字标注：【实测】有数据；【估计】拍的；【假设计算】由公式推的。
- 一切正文（content text）在本文、代码、日志、测试断言里都用 `content_ref`（sha256）或 fixture ID 引用，不出现原文。

---

## 0. 本文回答的问题

| 问题 | 章节 |
|---|---|
| 仓库长什么样，谁负责什么 | §1 |
| app.db 有哪些表，谁写谁读 | §2 |
| 审次状态如何转换，谁有权触发 | §3 |
| 哪些写入必须在同一事务 | §4 |
| 提交裁决时检查什么、什么顺序、错在哪一步报什么码 | §5 |
| G、W、人审页、运营 CLI 之间的接口 | §6 |
| 租约、截止、撤权、abort 怎么实现 | §7 |
| Pi 的哪些 API 用在哪，怎么写 | §8 |
| 判官适配器与策略引擎 | §9 |
| 规则、校准、版本固定 | §10 |
| 评测执行协议（第四轮审查要求的三个细节） | §11 |
| 测试用例目录与 CI | §12 |
| 部署、配置、密钥、日志 | §13 |
| 14 天 MVP 排期与每日验收 | §14 |
| 开工前验证清单（带命令） | §15 |

---

## 1. 仓库结构与职责

```
pi-moderation-agent/
├── package.json              # pnpm workspace 根；脚本：check / test / g / w / replay
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── packages/
│   ├── core/                 # 无 Pi 依赖：schema DDL、状态机、校验、错误码、类型；G 与 W 共用
│   │   └── src/{db.ts, schema.sql, review.ts, states.ts, submit-check.ts, errors.ts, ids.ts, redact.ts}
│   ├── judges/               # 判官适配器：pi-ai createProvider({classifiers}) 三个 API + 校准
│   │   └── src/{adapter.ts, laya-batch.ts, openai-logprob.ts, clef-mm.ts, calib.ts, recorder.ts}
│   ├── policy/               # 规则 YAML 加载、策略引擎三态、版本固定、contract tests 运行器
│   │   └── src/{rules.ts, engine.ts, versions.ts, contract.ts}
│   ├── gateway/              # 进程 G：队列、预处理、快判、控制层（租约扫描）、HTTP（仪表盘/人审/灰度/指标）
│   │   └── src/{main.ts, intake.ts, preprocess.ts, fastpath.ts, control.ts, outbox.ts, http/*.ts}
│   ├── worker/               # 进程 W：pi-durable Harness、moderation 扩展（工具+hooks）、准入、命令轮询
│   │   └── src/{main.ts, harness.ts, extension/{tools.ts, hooks.ts, sections.ts}, admission.ts, commands.ts}
│   ├── ops/                  # pi coding-agent 扩展：/shadow /rollout /status /calib（调 G 的 HTTP）
│   └── inspect/              # 调试 CLI：脱敏打印审次、轨迹、账本（正文显示为 [TEXT len= sha=]）
├── rules/                    # 规则 YAML（git 版本化）+ mapping.yaml（云厂商标签映射）
├── calib/                    # 校准文件 calib/<judge>/<rule>@<ver>.json
├── fixtures/                 # contract tests 的样本引用（只存 fixture id → 数据集 id/行号，不存正文）
├── python/
│   ├── synth/                # 合成账号画像、线程上下文、案例族 C0–C5（规则公开）
│   ├── eval/                 # 评测：冻结切分、疑似集冻结、A/B/B+/C 运行器、配对检验、评测卡
│   └── replay/               # 回放器：泊松到达，写 app.db intake
├── test/
│   ├── unit/                 # core/policy/judges 纯函数
│   ├── harness/              # faux provider 下的不变量与崩溃用例（不花 token）
│   ├── e2e/                  # 真实模型，默认跳过，需 RUN_REAL=1
│   └── fault/                # CRASH_AT 注入脚本与断言
├── scripts/                  # 开发机脚本：启动、kill、对账、备份
├── docs/
└── .github/workflows/ci.yml
```

职责边界：
- `core` 是唯一允许写 app.db 业务表的地方；G、W、人审页、运营 CLI 全部通过 `core` 的函数写，不直接拼 SQL。这样提交校验只有一份实现（§5）。
- `worker` 独占 `session.sqlite`。durable 文档写明"一个进程拥有一个存储，没有跨进程锁"，所以 G 永远不打开 session.sqlite；G 要看 W 的状态，只能看 app.db 里 W 写的摘要或调 W 的 HTTP（§6.3）。
- `python/*` 只读 app.db（评测、对账）或只写 intake 表（回放器）。

技术栈固定：Node 22.23.3【实测，开发机】、pnpm 12.9.1【实测】、TypeScript 5.x、SQLite 用 Node 内置 `node:sqlite`（避免原生模块构建；pi-durable 的 `openNodeSqliteStorage` 同样基于 Node API）【待核：node:sqlite 在 22.23 的 WAL 与 busy_timeout 行为】、Vitest、TypeBox（pi-ai 已带）。Python 3.11.17 + uv【实测】。

---

## 2. 数据模型（app.db）

app.db 是唯一业务事实源（v2.3 §5.3）。SQLite WAL，`synchronous=NORMAL`，`busy_timeout=5000`。所有表带 `created_at`（毫秒整数，G/W 进程的墙钟）。

### 2.1 表清单与读写方

| 表 | 作用 | 写 | 读 |
|---|---|---|---|
| content | 原始内容（受限存储） | 回放器 | G 预处理、W 工具（经投影）、人审页受限视图 |
| intake | 接入队列 | 回放器、G | G |
| review | 审次记录（状态、租约、截止、版本固定） | G、W（经 core）、人审页 | 全部 |
| ruling | 已提交裁决（UNIQUE review_id） | G 快判、W dispose、人审页 | 全部 |
| content_state | 内容的当前有效裁决（派生，便于查询） | 与 ruling 同事务 | 仪表盘、工具 |
| outbox | 待投递事件 | 与 ruling / release 同事务 | dispatcher |
| outbox_consumer | 消费端幂等表（模拟端点） | dispatcher | 对账 |
| evidence | 证据文档（受限存储，全文）与投影 | W 工具 | W、人审页受限视图 |
| judge_call | 每次判官调用（原始与校准概率、模型 ID、延迟、费用） | G、W | 评测、仪表盘 |
| worker_command | G → W 的控制命令（abort） | G | W 轮询 |
| human_queue | 人审队列视图（按严重度×时效） | 与 release 同事务 | 人审页 |
| feedback | 人审标注回流 | 人审页 | 校准器 |
| audit | 追加写审计（哈希链） | 触发器 | 审计 |
| version_pin | 规则/校准/证据快照版本注册表 | G 热加载时 | W 按审次读取 |
| metrics_minute | 每分钟聚合指标 | G | 仪表盘 |

### 2.2 DDL（核心表）

```sql
PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;

CREATE TABLE content (
  content_id   TEXT PRIMARY KEY,          -- 数据集来源 id，如 "coldv1:12345"
  scene        TEXT NOT NULL,             -- comment | danmaku | nickname | post | image
  text_sha     TEXT,                      -- sha256(normalized text)
  text         TEXT,                      -- 受限：只有 content 表存正文
  image_refs   TEXT,                      -- JSON ["blob:sha256:..."]
  account_id   TEXT,                      -- 合成账号
  thread_id    TEXT,                      -- 合成线程
  created_at   INTEGER NOT NULL
);

CREATE TABLE intake (
  content_id   TEXT PRIMARY KEY REFERENCES content(content_id),
  prio         INTEGER NOT NULL DEFAULT 5,
  status       TEXT NOT NULL,             -- received | preprocessed | judged | failed
  lease_owner  TEXT, lease_until INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX intake_status ON intake(status, prio, created_at);

CREATE TABLE review (
  review_id        TEXT PRIMARY KEY,      -- "<content_id>#<trigger>#<seq>"
  content_id       TEXT NOT NULL REFERENCES content(content_id),
  seq              INTEGER NOT NULL,      -- 同一内容内递增；裁决序号也用它
  trigger          TEXT NOT NULL,         -- fast | suspicious | appeal | recheck | rule_change
  state            TEXT NOT NULL,         -- 见 §3
  attempt          INTEGER NOT NULL DEFAULT 0,   -- 执行代次；每次取租约 +1
  lease_owner      TEXT,                  -- W 实例 id，撤销时置 NULL
  lease_until      INTEGER,               -- 租约到期（W 心跳续约）
  revoked_attempt  INTEGER,               -- 控制层撤权时记下被撤的代次（S7）；此后该代次永久失效
  deadline_at      INTEGER,               -- 机器审核截止（绝对时间）；人审不受此约束
  budget_tools     INTEGER NOT NULL DEFAULT 12,
  budget_cost_usd  REAL    NOT NULL DEFAULT 0.05,
  used_tools       INTEGER NOT NULL DEFAULT 0,
  used_cost_usd    REAL    NOT NULL DEFAULT 0,
  rules_ver        TEXT NOT NULL,         -- rules@<sha>
  calib_ver        TEXT NOT NULL,         -- calib@<sha>
  evidence_ver     TEXT NOT NULL,         -- 证据快照版本
  judge_model      TEXT NOT NULL,         -- 入口判官模型 id
  agent_model      TEXT,                  -- 主模型 id（W 填）
  conversation_id  TEXT,                  -- durable 会话 id（W 填；一审次一会话）
  release_reason   TEXT,                  -- timeout | budget | evidence_gap | judge_down | model_release | backpressure
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(content_id, seq)
);
CREATE INDEX review_state ON review(state, deadline_at);
CREATE INDEX review_content ON review(content_id, seq DESC);

CREATE TABLE ruling (
  review_id    TEXT PRIMARY KEY REFERENCES review(review_id),   -- 一审次最多一条裁决
  content_id   TEXT NOT NULL,
  seq          INTEGER NOT NULL,          -- = review.seq
  action       TEXT NOT NULL,             -- pass | limit | takedown
  actor        TEXT NOT NULL,             -- fastpath | agent | human
  attempt      INTEGER,                   -- 机器裁决时 = 提交时持有的代次；人工为 NULL
  evidence_ids TEXT NOT NULL,             -- JSON，必须全部属于本审次
  rule_ids     TEXT NOT NULL,             -- JSON
  judge_call_ids TEXT NOT NULL,           -- JSON
  rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL, evidence_ver TEXT NOT NULL,
  model_id     TEXT,
  reason       TEXT,                      -- 结构化理由（受限：可能复述正文，不进仪表盘）
  created_at   INTEGER NOT NULL,
  UNIQUE(content_id, seq)
);

CREATE TABLE content_state (
  content_id   TEXT PRIMARY KEY,
  effective_action TEXT NOT NULL,         -- 当前有效裁决 = 序号最大的已提交裁决
  effective_seq    INTEGER NOT NULL,
  visibility   TEXT NOT NULL,             -- visible | self_only | hidden（按场景策略）
  updated_at   INTEGER NOT NULL
);

CREATE TABLE outbox (
  event_id     TEXT PRIMARY KEY,          -- "<review_id>#<kind>"（幂等键）
  review_id    TEXT NOT NULL, content_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind         TEXT NOT NULL,             -- ruling | release
  payload      TEXT NOT NULL,             -- JSON（脱敏）
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | acked | dead
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(status, next_at);

CREATE TABLE outbox_consumer (                  -- 模拟外部端点的幂等表
  event_id   TEXT PRIMARY KEY,
  content_id TEXT NOT NULL, seq INTEGER NOT NULL, action TEXT,
  applied    INTEGER NOT NULL,            -- 1 应用；0 因序号更旧被忽略
  created_at INTEGER NOT NULL
);

CREATE TABLE evidence (
  evidence_id  TEXT PRIMARY KEY,          -- "<review_id>#e<n>"
  review_id    TEXT NOT NULL REFERENCES review(review_id),
  attempt      INTEGER NOT NULL,          -- 产生它的执行代次
  kind         TEXT NOT NULL,             -- account_history | thread_context | image_check | similar | rule | judge
  source_ref   TEXT NOT NULL,             -- 来源引用（数据集 id、规则 id、judge_call_id）
  body_sha     TEXT NOT NULL,
  body         TEXT NOT NULL,             -- 受限：全文
  projection   TEXT NOT NULL,             -- 模型看到的投影 JSON {evidence_id, summary, untrusted:true}
  created_at   INTEGER NOT NULL
);

CREATE TABLE judge_call (
  judge_call_id TEXT PRIMARY KEY,
  review_id TEXT, content_id TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL, api TEXT NOT NULL,
  rule_ids TEXT NOT NULL, rules_ver TEXT NOT NULL, calib_ver TEXT NOT NULL,
  status TEXT NOT NULL,                   -- ok | timeout | error | abstain
  raw_probs TEXT, calibrated_probs TEXT, temperature REAL,
  shuffle_seed INTEGER, consistency_ok INTEGER,   -- 打乱复问是否一致
  latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE worker_command (
  command_id TEXT PRIMARY KEY, review_id TEXT NOT NULL,
  kind TEXT NOT NULL,                     -- abort
  attempt INTEGER NOT NULL,               -- 要停的代次
  status TEXT NOT NULL DEFAULT 'pending', -- pending | done | ignored
  created_at INTEGER NOT NULL, done_at INTEGER
);

CREATE TABLE human_queue (
  review_id TEXT PRIMARY KEY REFERENCES review(review_id),
  severity INTEGER NOT NULL, due_at INTEGER NOT NULL,
  reason TEXT NOT NULL, claimed_by TEXT, claimed_at INTEGER,
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
  payload TEXT NOT NULL,                  -- 脱敏 JSON
  prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'audit is append-only'); END;

CREATE TABLE version_pin (
  kind TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL,
  loaded_at INTEGER NOT NULL, rollout_pct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, version)
);
```

要点：
- `ruling.review_id` 是主键，这是"一审次最多一条裁决"的数据库级保证；`UNIQUE(content_id, seq)` 保证同一内容的裁决序号不重复。
- 当前有效裁决不存在 review 表上，而是 `content_state`，由 §4 的 T4/T7 事务同步更新，更新条件是 `new.seq > content_state.effective_seq`。迟到的旧事件永远写不进去。
- `audit` 的哈希链：`hash = sha256(prev_hash + kind + ref_id + actor + payload + created_at)`，由 `core/db.ts` 的 `appendAudit()` 在同一事务里算；启动时 `scripts/verify-audit.ts` 全表校验。

### 2.3 ID 规则

| ID | 格式 | 例子 |
|---|---|---|
| content_id | `<dataset>:<row>` | `coldv1:12345` |
| review_id | `<content_id>#<trigger>#<seq>` | `coldv1:12345#appeal#2` |
| evidence_id | `<review_id>#e<n>` | `coldv1:12345#suspicious#1#e3` |
| outbox event_id | `<review_id>#<kind>` | `coldv1:12345#suspicious#1#ruling` |
| durable requestId | `= review_id` | |
| judge_call_id | UUIDv7 | |
| W 实例 id | `w-<hostname>-<pid>-<start_ms>` | |

review_id 可读、可从 content_id 推导序号，outbox 幂等键直接复用 review_id，三者一致，便于对账。

---

## 3. 审次状态机（状态转换表）

### 3.1 状态

```
queued          已创建，等待 W 准入
investigating   W 持有租约，正在调查（attempt ≥ 1）
disposed        已提交裁决（ruling 存在），终态
human_queue     已释放给人审（待人审），机器代次永久失效
human_disposed  人工提交裁决（ruling 存在，actor=human），终态
failed          重试次数耗尽且无法释放（只在 release 本身写失败时出现；控制层会重试到成功）
```

快判直接通过/拦截的审次（trigger=fast）一步到 `disposed`，不经过 queued。

### 3.2 转换表

| # | 从 | 到 | 触发者 | 前置条件 | 同事务写入 |
|---|---|---|---|---|---|
| S1 | – | disposed | G 快判 | 策略引擎给出 pass/block | review + ruling(actor=fastpath) + content_state + outbox(ruling) |
| S2 | – | queued | G 快判 | 策略引擎给出 suspicious 且 agent 队列未满 | review(state=queued, deadline_at, 版本固定) |
| S2' | – | human_queue | G 快判 | suspicious 但 agent 队列满（背压） | review(release_reason=backpressure) + human_queue + outbox(release) |
| S3 | queued | investigating | W 准入 | 未过 deadline；无活租约或租约已过期 | review(attempt+1, lease_owner, lease_until) |
| S4 | investigating | investigating | W 心跳 | 持有当前代次 | review(lease_until) |
| S5 | investigating | disposed | W dispose 工具 | §5 全部校验通过 | ruling(actor=agent, attempt) + content_state(若 seq 更大) + outbox(ruling) + review(state) |
| S6 | investigating | human_queue | W release 工具 | 持有当前代次 | review(state, release_reason, lease_owner=NULL) + human_queue + outbox(release) |
| S7 | investigating | human_queue | G 控制层 | deadline_at 已过，或租约过期且 attempts ≥ N，或预算超限 | review(撤租约: lease_owner=NULL, attempt 不变但标记 revoked_attempt=attempt, state) + human_queue + outbox(release) + worker_command(abort, attempt) |
| S8 | investigating | queued | G 控制层 | 租约过期（W 死）且 attempts < N 且未过 deadline | review(lease_owner=NULL, state=queued) |
| S9 | human_queue | human_disposed | 人审页 | 审次在 human_queue 且无 ruling | ruling(actor=human, attempt=NULL) + content_state(若 seq 更大) + outbox(ruling) + review(state) |
| S10 | disposed / human_disposed | （新审次 queued） | 申诉 / 重审 / 规则变更 | 内容存在；新 seq = max(seq)+1 | 新 review 行（trigger=appeal 等），不改旧行 |
| S11 | queued | human_queue | G 控制层 | 在 queued 里等到过 deadline | 同 S7 但无 abort 命令 |

不允许的转换（提交层拒绝并写审计）：
- `disposed → *`、`human_disposed → *`：终态只能通过 S10 新建审次纠正。
- `human_queue → investigating`：转人工后机器代次永久失效（v2.3 人工接管契约）。
- 任何携带 `attempt < review.attempt` 或 `lease_owner ≠ 当前` 的机器写入。

### 3.3 内容的有效处置（派生规则）

```
effective(content) = ruling with max(seq) among committed rulings of content
```
`content_state` 是这条规则的物化；任何写 ruling 的事务都执行：
```sql
INSERT INTO content_state(content_id, effective_action, effective_seq, visibility, updated_at)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(content_id) DO UPDATE SET
  effective_action=excluded.effective_action, effective_seq=excluded.effective_seq,
  visibility=excluded.visibility, updated_at=excluded.updated_at
WHERE excluded.effective_seq > content_state.effective_seq;
```
release 不碰 content_state（流转不是裁决）。待审可见性由 G 在 S2 时按场景策略写 `visibility`（MVP：一律 `hidden`）。

---

## 4. 事务边界

每个编号对应 `packages/core/src/review.ts` 里的一个函数；函数内部是一个 `BEGIN IMMEDIATE … COMMIT`。函数外不允许再包事务。

| # | 函数 | 写入 | 幂等性 |
|---|---|---|---|
| T1 | `intakeInsert(content)` | content + intake | content_id 主键冲突则忽略（回放器重放安全） |
| T2 | `fastDispose(contentId, decision)` | S1 的全部写入 | review_id 冲突 → 读回已有 ruling 返回 |
| T2' | `createSuspiciousReview(contentId, pins)` | S2 或 S2' | 同上 |
| T3 | `acquireLease(reviewId, workerId, ttlMs)` | S3 | 条件更新：`WHERE state='queued' OR (state='investigating' AND lease_until < now)`；返回新 attempt 或 `E_LEASE_HELD` |
| T3' | `renewLease(reviewId, workerId, attempt, ttlMs)` | S4 | `WHERE lease_owner=? AND attempt=?`；0 行 → `E_LEASE_LOST` |
| T4 | `submitRuling(input)` | S5 或 S9 | ruling 主键冲突 → 读回已有裁决返回 `{duplicate:true}`；其余校验见 §5 |
| T5 | `releaseToHuman(reviewId, actor, attempt?, reason)` | S6 / S7 / S11 | 已在 human_queue → 返回 `{duplicate:true}`；已 disposed → `E_STATE_INVALID` |
| T6 | `revokeAndRelease(reviewId, reason)` | S7：撤租约 + 释放 + abort 命令 | 同 T5；写 worker_command 时 command_id = `<review_id>#abort#<attempt>` 去重 |
| T7 | `requeue(reviewId)` | S8 | 条件更新 |
| T8 | `outboxMark(eventId, status, nextAt)` | outbox 状态 | 条件更新 |
| T9 | `createFollowupReview(contentId, trigger)` | S10 | `UNIQUE(content_id, seq)`；并发申诉只会有一个赢 |
| T10 | `consumerApply(event)` | outbox_consumer | event_id 主键；`applied = (seq > 已应用最大 seq)` |

durable 侧的写入（memo、工具结果）不在上述事务内，顺序固定为：**先 app.db 事务，后 durable memo**。崩溃在两者之间：重跑 `dispose`（replay:"safe"）→ T4 发现 ruling 已存在 → 读回 → memo。不会出现第二条裁决。

反方向（先 memo 后 app.db）被禁止，因为 memo 成功而 app.db 未写时，恢复后工具不再执行，裁决永远丢失。代码审查时的检查点：`grep -n "memo(" packages/worker/src` 的每一处之前必须有 core 的事务调用。

---

## 5. 提交校验（submitRuling 的检查顺序与错误码）

输入：
```ts
type SubmitRulingInput = {
  reviewId: string;
  actor: "fastpath" | "agent" | "human";
  attempt?: number;              // actor=agent 必填；human 不填
  workerId?: string;             // actor=agent 必填
  action: "pass" | "limit" | "takedown";
  evidenceIds: string[];
  ruleIds: string[];
  judgeCallIds: string[];
  pins: { rulesVer: string; calibVer: string; evidenceVer: string };
  modelId?: string;
  reason: string;                // 受限字段
  humanAuth?: { reviewerId: string; token: string };   // actor=human 必填
};
```

检查顺序（在 T4 事务内，逐条，首个失败即回滚并返回错误码；每次拒绝写一条 audit）：

| 步 | 检查 | 错误码 | 说明 |
|---|---|---|---|
| 1 | review 存在 | E_REVIEW_NOT_FOUND | |
| 2 | ruling 不存在 | （非错误）返回已有裁决 `duplicate:true` | 幂等 |
| 3 | 状态允许：agent 需 `investigating`；human 需 `human_queue`；fastpath 需新建 | E_STATE_INVALID | human_queue 上的机器提交在这里被拒 |
| 4 | 身份：agent 需 `lease_owner = workerId AND attempt = review.attempt AND lease_until ≥ now`；human 需 humanAuth 通过独立校验（§6.4） | E_LEASE_LOST / E_ATTEMPT_STALE / E_HUMAN_AUTH | 机器截止只约束机器：human 不检查 deadline_at |
| 5 | 截止：agent 需 `now < deadline_at` | E_DEADLINE_PASSED | |
| 6 | 预算：agent 需 `used_tools ≤ budget_tools AND used_cost_usd ≤ budget_cost_usd` | E_BUDGET_EXCEEDED | 超限的正确路径是 release，不是裁决 |
| 7 | 版本：`pins` 与 review 行三个版本完全相等 | E_VERSION_MISMATCH | 防止模型挑规则版本 |
| 8 | 规则存在于 pins.rulesVer 的规则集，且 scene 适用，且 action 在该规则 `allowed_actions` 内 | E_RULE_UNKNOWN / E_ACTION_NOT_ALLOWED | 模型不能凭空引用规则 |
| 9 | 证据归属：每个 evidence_id 的 `review_id = reviewId`；agent 另要求 `evidence.attempt ≤ review.attempt`（旧代次证据可用，别的审次不可用） | E_EVIDENCE_FOREIGN | 借用别的审次的低分在此被拒 |
| 10 | 判官调用归属：每个 judge_call_id 的 review_id = reviewId 且 rules_ver/calib_ver 等于 pins | E_JUDGE_FOREIGN | |
| 11 | 动作相关证据条件（下表） | E_EVIDENCE_INCOMPLETE | v2.3 §6.4 的表 |
| 12 | 写入：ruling + content_state(条件) + outbox + review.state + audit | – | |

动作相关证据条件（步 11）的代码化定义：

```ts
// required(scene, rulesVer) = 该场景必查类别集合 ∪ (含图 ? {image_check} : ∅)
pass:     covered(evidenceIds) ⊇ required  &&  noOpenGap(evidenceIds)
          // noOpenGap: 没有 kind=judge 且 status=abstain/timeout 的必查项未被后续同类成功调用覆盖
limit|takedown:
          exists judge evidence e with e.rule_id ∈ ruleIds && calibrated_prob ≥ rule.threshold.block
          && exceptionsChecked(ruleIds, evidenceIds)     // 该规则声明的例外各有一条核验证据（判官问题或工具）
          && !pendingDecisive(evidenceIds)               // 没有"可能改变该裁决"的必要证据处于 abstain/timeout
          // 文本已明确命中拦截规则时，其他类别不要求覆盖（允许提前结束）
human:    不检查步 5、6、11；检查步 7–10（人工裁决也要版本一致、证据归属本审次，但可以零证据：evidenceIds 允许为空）
fastpath: 步 11 按 pass/block 同上，但证据只来自 judge_call（无工具）
```

人工零证据的理由：人工纠错不能被要求必须服从机器证据，但必须留下"用的是哪版规则"。

错误码全表（`packages/core/src/errors.ts`，HTTP 映射给 §6）：

| 码 | HTTP | 含义 |
|---|---|---|
| E_REVIEW_NOT_FOUND | 404 | 审次不存在 |
| E_STATE_INVALID | 409 | 当前状态不允许该操作 |
| E_LEASE_HELD | 409 | 租约被他人持有 |
| E_LEASE_LOST | 409 | 租约不属于调用方或已过期 |
| E_ATTEMPT_STALE | 409 | 执行代次已失效 |
| E_DEADLINE_PASSED | 409 | 机器截止已过 |
| E_BUDGET_EXCEEDED | 409 | 预算超限 |
| E_VERSION_MISMATCH | 409 | 规则/校准/证据版本与审次不一致 |
| E_RULE_UNKNOWN | 422 | 规则不存在或不适用场景 |
| E_ACTION_NOT_ALLOWED | 422 | 动作不在规则/场景白名单 |
| E_EVIDENCE_FOREIGN | 422 | 证据不属于本审次 |
| E_JUDGE_FOREIGN | 422 | 判官结果不属于本审次或版本不符 |
| E_EVIDENCE_INCOMPLETE | 422 | 动作所需证据条件未满足 |
| E_HUMAN_AUTH | 401 | 人工授权无效 |
| E_JUDGE_UNAVAILABLE | 503 | 判官不可用（fail-closed：不自动放行） |
| E_BACKPRESSURE | 429 | 队列满 |

工具层（§8.3）把这些错误码原样返回给模型作为 `isError: true` 的结果，并附一句固定提示（例如 E_EVIDENCE_INCOMPLETE 附缺少的类别列表）。模型可以据此补证据或 release；模型不能绕过。

---

## 6. 接口

### 6.1 G 的 HTTP（内网，127.0.0.1:8080）

| 方法 路径 | 用途 | 请求 | 响应 |
|---|---|---|---|
| GET /api/health | 存活 | – | {ok, version, queues} |
| GET /api/metrics | 仪表盘（SSE 每秒） | – | metrics_minute 最新 + 实时队列长度 |
| GET /api/reviews?state=&limit= | 审次列表（脱敏） | – | [{review_id, content_sha, scene, state, attempt, deadline_at, …}] |
| GET /api/reviews/:id | 审次详情（脱敏） | – | review + ruling(去 reason) + evidence 投影列表 |
| GET /api/reviews/:id/restricted | 受限视图 | header X-Reviewer, X-Confirm: yes | 含 evidence.body、ruling.reason；写 audit |
| POST /api/human/claim | 领取人审任务 | {reviewer_id} | human_queue 顶部一条 |
| POST /api/human/submit | 人工裁决 | SubmitRulingInput(actor=human) | ruling 或错误码 |
| POST /api/appeals | 申诉 | {content_id, reason_code} | 新 review_id |
| POST /api/rules/shadow | 影子回放 | {rule_id, version} | {flips, insufficient, total, report_path} |
| POST /api/rules/rollout | 灰度 | {rule_id, version, pct} | version_pin |
| GET /api/calib | 校准面板 | – | per rule: current / candidate / support / status |
| POST /api/calib/approve | 批准候选阈值 | {rule_id, candidate_id} | version_pin |
| POST /api/replay/pause, /resume | 背压控制回放器 | – | – |

所有响应默认脱敏：没有 text、body、reason 字段；只有 `/restricted` 返回它们。

### 6.2 W 的 HTTP（127.0.0.1:8081，只给 G 与 inspect 用）

| 方法 路径 | 用途 |
|---|---|
| GET /health | {worker_id, inflight, admitted, harness: inspect() 摘要} |
| POST /abort | {review_id, attempt} → 立即执行一次命令轮询（加速 S7 的 best-effort abort）；返回 {result: "aborted" \| "not_running" \| "stale"} |
| GET /trace/:review_id | 该审次的轨迹（脱敏）：durable `entries()` 投影 |

G 调 W 的 /abort 失败（连接拒绝、超时）不影响 S7 事务，因为 S7 已经提交。命令同时写在 `worker_command` 表，W 启动与每 500ms 轮询兜底。

### 6.3 G ↔ W 通过 app.db 的约定

- 准入：W 自己从 review 表取 `state='queued'` 的审次（T3），不需要 G 推送。G 的作用是写 queued 和看总量。
- 并发上限：W 本地信号量 `ADMIT_MAX`（MVP 10，2 核 4G 机器【估计】；项目文档的 20 是 8 周目标）。
- W 每 5 秒心跳一次 T3'（续约 TTL 30 秒）。
- G 控制层每 2 秒扫描：`deadline_at < now AND state IN ('queued','investigating')` → T6/S11；`lease_until < now AND state='investigating'` → attempts < N ? T7 : T6。
- W 每 500ms 轮询 `worker_command` 的 pending；对每条：若本地有该 review_id 且 attempt 相等的活会话 → `conversation.abort(ctx)`，命令标 done；否则标 ignored。

### 6.4 人工授权（独立路径）

MVP：`HUMAN_REVIEW_TOKEN` 环境变量 + reviewer_id 列表（`config/reviewers.json`）。校验在 core 的 `verifyHumanAuth()`，与租约无关。token 泄露风险在内网演示可接受，文档写明。

### 6.5 判官适配器接口

即 v2.3 §6.2 的请求/响应 JSON。TypeScript 类型放 `packages/judges/src/adapter.ts`，内部映射到 pi-ai 的 `ClassifierContext { state, questions }` 与 `ClassifierResult { answers, stopReason, usage }`。注意 pi-ai 的 `classify()` 对 provider 错误不抛异常而是返回 `stopReason: "error"`【原文，pi-ai README】，适配器把它转成 `status: "error"`。

---

## 7. 租约、截止、撤权、取消

### 7.1 时间线

```
G 创建审次：deadline_at = now + D(scene)      MVP: 短文本 D=60s（验收口径 30s 之内完成，给 2 倍余量）
W 准入：   attempt=1, lease_until = now + 30s；每 5s 续约
W 调查：   每次工具调用前 beforeTool 检查：租约仍持有、未过 deadline、预算未超；否则 block
到期：     G 扫描到 deadline_at < now → T6（原子：撤租约 + human_queue + outbox + worker_command）
          → 尽力 POST W /abort → W 调 conversation.abort()
迟到：     W 的 dispose 带 attempt=1 到达 → T4 步 4 发现 lease_owner=NULL → E_LEASE_LOST → 工具返回错误 → 
          hooks 看到 state 已不是 investigating → 返回 control.terminate → 会话结束
人工：     人审页 submit(actor=human) → T4 跳过步 4(机器部分)/5/6 → human_disposed
```

### 7.2 为什么 abort 只是尽力

durable 的 `Conversation.abort()` 会"撤回排队输入、标记并发信号每个活任务、等到空闲"【原文，types.d.ts】；但 W 可能已死、或 abort 返回前模型请求已在飞。所以 S7 的正确性不依赖 abort：**真正的门是 T4 的步 3–5**。abort 只省钱（少一次模型调用）和让仪表盘干净。

### 7.3 W 重启后的行为

1. `Harness.open(openNodeSqliteStorage("session.sqlite"))`，`registry.install(Moderation)`，`harness.resume()`。
2. durable 自动续跑未完成的生成/工具任务（replay-safe 工具重跑，其余得到 interrupted）。
3. **在续跑之前**，W 对本地所有 `investigating` 且 `lease_owner` 是旧实例 id 的审次重新 T3（新 attempt）。若 T3 失败（已被 G 撤权或已 disposed），W 立即 `conversation.abort()` 该会话。
4. 续跑中被 durable 重跑的 dispose 不能使用崩溃前的 attempt。固定做法：工具参数里**没有 attempt**；执行体从 W 进程内存的 `leases: Map<review_id, attempt>` 读当前代次，这张表在步 3 重建。memo 里只记"已提交的 ruling 摘要"，不记 attempt，因为 memo 是崩溃前的旧值。这样：步 3 取到新租约 → 重跑的 dispose 以新代次提交，通过；步 3 失败（已撤权）→ 表里没有该审次 → dispose 返回 E_LEASE_LOST，会话自停。

这一条是最容易写错的地方，列入 §12 的用例 H-07。

### 7.4 预算

- 工具次数：`beforeTool` 里 `used_tools+1 > budget_tools` → block，并由 `afterTools` 触发 release（S6）。
- 费用：每次 judge/模型调用后累加到 review.used_cost_usd（T3' 顺带写）；`beforeRequest` 不能阻止生成（没有 block 返回），所以费用超限的处理是 `afterResponse` 里标记，下一次 `beforeTool` block + release。
- durable 自带 `pi.usage` 文档按会话累计模型用量，可作对账来源，但预算判断用 app.db 的值（跨重启、跨代次一致）。

---

## 8. Pi 绑定写法

### 8.1 Harness 打开（packages/worker/src/harness.ts）

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const ctx = BACKGROUND_CONTEXT;
const models = createModels();
models.setProvider(relayProvider());           // 中转站 OpenAI 兼容 provider，见 §13.3
const registry = createRegistry();
registry.install(Moderation);                  // 扩展：工具 + hooks + sections
const harness = await Harness.open(await openNodeSqliteStorage(SESSION_DB), {
  models, registry,
  settings: { stream: { timeoutMs: 60_000 }, retry: { maxRetries: 2 }, toolExecution: "sequential",
              compaction: { enabled: false } },
  onReport: (e) => log.warn({ err: redact(e) }, "extension failure"),
}, ctx);
harness.resume();
```

`toolExecution: "sequential"`：审核工具之间有因果（先查线程再判），并行没有收益，顺序执行使轨迹可读、预算计数确定。`compaction.enabled=false`：单审次上下文很短，不需要压缩，且避免 summary 复述正文。

### 8.2 一审次一会话（review_id → conversation_id）

durable 的 `requestId` 去重只在单会话内【原文，README "Persist and Resume"】，所以需要自建索引。两个候选：
- （选用）app.db 的 `review.conversation_id` 列。流程：W 准入拿到租约后，若 `conversation_id` 为空 → `harness.createConversation({ownership:{kind:"ownerless"}, agent:{model, instructions, tools}}, ctx)` → 写回 app.db（T3 的后续小事务 `bindConversation(reviewId, convId)`，条件 `conversation_id IS NULL`）。崩溃在创建会话与写回之间：重启后发现 conversation_id 仍空 → 再建一个会话，旧会话成为孤儿（无任务，无成本）。孤儿会话由 `scripts/gc-sessions.ts` 清理。
- （备选，待核）durable 的 session 级文档族 `defineDocFamily` 以 review_id 为 key 存 conversationId，与 `createConversation` 在同一 commit，天然原子。但索引在 session.sqlite 里，G 看不到。若验证清单 1 证明可行，MVP 后切换。

然后 `conv.submit({type:"input", content: initialPrompt(reviewId), requestId: reviewId, whenBusy:"reject"}, ctx)`。重复 submit 同 requestId 返回同一 submission【原文】。

### 8.3 工具定义（packages/worker/src/extension/tools.ts）

通用骨架：

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
    const memoed = await api.memo<RulingSummary>("ruling", ctx);
    if (memoed) return done(memoed);                              // 已提交过：直接返回
    const review = reviewOf(api.conversationId);                 // W 内存表 conversation_id → {review_id, attempt}
    const r = core.submitRuling({ reviewId: review.reviewId, actor: "agent", attempt: review.attempt,
      workerId: WORKER_ID, action: args.action, evidenceIds: args.evidence_ids, ruleIds: args.rule_ids,
      judgeCallIds: judgeCallsOf(review.reviewId), pins: review.pins, modelId: review.modelId, reason: args.reason });
    if (!r.ok) return { isError: true, content: text(`${r.code}: ${r.hint}`), details: { code: r.code } };
    await api.memo("ruling", summarize(r.ruling), ctx);          // app.db 之后才 memo
    return { content: text(`disposed ${r.ruling.action}`), details: summarize(r.ruling), control: { terminate: true } };
  },
});
```

要点：
- `replay:"safe"`：崩溃后 durable 重跑；重跑首先看 memo，再看 app.db 幂等返回。两层都幂等。
- `control: { terminate: true }`：durable 在一轮所有结果都要求 terminate 时结束 run，不再请求模型【原文，README "Tools"】。dispose/release 成功后不需要模型再说话。
- `reviewOf()` 是 W 内存映射，重启后由 §7.3 步 3 重建（从 app.db 查 `conversation_id` 列）。
- 工具返回的 `details` 是脱敏结构，进 durable 的 `pi.tool-result` 条目；`reason` 只进 app.db 的受限字段。

其余工具同骨架，差异：

| 工具 | 执行体 | 写 evidence | 副作用 |
|---|---|---|---|
| get_account_history | 读 synth 的账号历史（只含审次时间之前的事件） | 是 | 无 |
| get_thread_context | 读前后 N 条（content 表，按 thread_id） | 是（投影只含 content_sha、长度、类别线索） | 无 |
| get_image | 取图 → Clef 适配器 → judge_call | 是 | 调外部判官（幂等：同 review_id + image sha 复用 judge_call） |
| find_similar_dispositions | simhash 近邻 + 它们的 effective_action | 是 | 无 |
| load_rule | 返回规则正文与例外（按 review.rules_ver） | 是（kind=rule） | 无 |
| judge | 判官复判（带证据投影）→ judge_call | 是（kind=judge） | 调判官 |
| escalate_model | `api.commit(tx => configure(tx, api.conversationId, { model: STRONG }))`；写 review.agent_model | 否 | 下一请求生效【原文】；主比较中由 hooks block |
| release | T5；memo；terminate | 否 | 释放 |

### 8.4 hooks（packages/worker/src/extension/hooks.ts）

```ts
hook(ToolTask, {
  beforeTool: async (call, api, ctx) => {
    const review = reviewOf(api.conversationId);
    const st = core.leaseStatus(review.reviewId, WORKER_ID, review.attempt);   // 一次 SELECT
    if (!st.held)            return { block: `E_LEASE_LOST: 本审次已被撤权，停止调查` };
    if (st.deadlinePassed)   return { block: `E_DEADLINE_PASSED` };
    if (st.toolsExhausted && call.name !== "release" && call.name !== "dispose")
                             return { block: `E_BUDGET_EXCEEDED: 只能 release 或 dispose` };
    if (call.name === "escalate_model" && !FLAGS.escalation) return { block: "escalation disabled in this run" };
    if (!ALLOWED_TOOLS.has(call.name)) return { block: "tool not allowed" };
    return undefined;
  },
}),
hook(GenerationTask, {
  afterTools: async (_assistant, _results, api, ctx) => {
    const review = reviewOf(api.conversationId);
    core.bumpUsedTools(review.reviewId, review.attempt, _results.length);     // T3' 变体
    if (core.leaseStatus(...).revoked) await abortSelf(api.conversationId);   // 撤权后自停
  },
  onYield: async (answer, api, ctx) => {
    // 模型没有调用 dispose/release 就结束了：强制一次
    const review = reviewOf(api.conversationId);
    if (!core.hasTerminal(review.reviewId)) return { continue: "你必须调用 dispose 或 release 结束本审次。" };
    return undefined;
  },
}),
```

`onYield` 的 continue 最多一次（计数在 memo），第二次仍无终结则 W 调 T5 release（reason=model_release）。

### 8.5 系统提示（sections）

- `section("role")`：角色与规则目录（规则 ID + 一句话，按 review.rules_ver 渲染，内容稳定利于缓存）。
- `section("review")`：本审次结构化信息：review_id、scene、content_sha、内容投影（见下）、预算剩余。内容正文只出现在这里一次，作为 `untrusted` 标记的数据块。
- `instructions`（configure 时写）：固定的审核流程指令。

内容正文进入模型上下文是无法避免的（模型要判断），这不违反"正文不进日志"：durable 的 session.sqlite 属于受限存储（v2.3 §6.1）。

### 8.6 faux provider（harness 测试）

`fauxProvider()` 提供脚本化回复：`faux.setResponses([fauxAssistantMessage([fauxToolCall("get_thread_context", {...})]), …])`【原文，pi-ai README】。测试里用它驱动确定的工具序列，并在 CRASH_AT 点 `process.kill(process.pid, "SIGKILL")`。判官用 `recorder.ts` 录制的响应回放。

---

## 9. 判官适配器与策略引擎

### 9.1 三个 classifier API（pi-ai createProvider）

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
- `openai-logprob`：照 pi-ai 的 `llama-cpp-classify` 的提示构造，改为 OpenAI 兼容的 `logprobs: true, top_logprobs: 20, max_tokens: 1`；只支持 choice；选项标签用单字母。中转站 qwen3.8-flash、glm-5.3 返回 top_logprobs【实测，上一台开发机】；视觉模型不返回【实测】。
- `clef-mm`：Cloudflare Workers AI 的 System One transport 只发 state/questions【原文，pi-ai 源码】；图片先试 `onPayload` 透传 `images`（验证清单 3），不行则绕过 pi-ai 直接调 Cloudflare REST，但仍返回 `ClassifierResult` 形状。

### 9.2 校准（calib.ts）

- 温度缩放：`p_i = softmax(log p_i / T)`，T 在开发集上最小化 NLL 拟合；文件 `calib/<judge>/<rule>@<ver>.json = {T, n, ece_before, ece_after, fitted_at, bucket:{judge, rules_ver, scene, n_options}}`。
- 桶键 = 判官模型 id × 规则版本 × 场景 × 选项数；任一变化 → 校准文件缺失 → 适配器返回 `calibrated: null`，策略引擎对无校准的概率**只允许 suspicious**，不允许 pass/block（fail-closed）。
- isotonic 在桶样本 ≥ 1,000 时才启用，否则只画可靠性图。
- 对抗一致性：同一问题用 `shuffle_seed` 打乱选项复问一次（MVP 只对落在 suspicious 边界 ±0.05 的样本复问，省一半成本【估计】）；argmax 不一致 → suspicious。

### 9.3 策略引擎（engine.ts）

输入：校准后概率 + scene + rules_ver；输出三态与命中规则。规则 YAML 的 `thresholds.block / pass` 按 `keyed_by_option_count` 查表。引擎是纯函数，100% 单测覆盖。判官 `status != ok` → 输出 `suspicious`（judge_down 时 G 直接 S2'，reason=judge_down，绝不 pass）。

含图路由（G 侧）：`images.length > 0` 时，pass 必须等图片检查完成；文本 block 可直接 block；图片检查 abstain/timeout → suspicious。

---

## 10. 规则、校准、版本固定

- 规则集版本 `rules@<sha>` = `rules/` 目录内容的 git tree sha（`git rev-parse HEAD:rules`）。G 启动与 `/api/rules/rollout` 时加载到内存，并登记 version_pin。
- 校准集版本 `calib@<sha>` 同理。
- 证据快照版本 `evidence@<ver>` = synth 数据生成批次号 + content 表快照 id。
- 审次创建（S2）时三者写入 review 行；W 的所有工具按 review 行的版本读取规则与校准（`policy.rulesAt(ver)` 从内存缓存或 git 读历史版本）。
- 灰度：`hash(content_id) % 100 < rollout_pct` 的**新审次**用新版本；已有审次不变。
- 影子回放：对账本里最近 N 条审次，用新规则在已有 `judge_call` 与 `evidence` 上重算三态；需要新证据的样本标 `insufficient`。输出 `{flips, insufficient, total}` 与按类别分层表。
- 发布门槛四项（v2.3 §6.3）由 `scripts/release-gate.ts` 一次跑完，输出通过/不通过与原因；`/api/rules/rollout` 在 pct>0 时要求最近一次 gate 通过的记录。
- 工具代码变更：换 W 的版本号（`WORKER_VERSION`），新审次才用；不热重装扩展。

---

## 11. 评测执行协议

### 11.1 数据冻结（python/eval/freeze.py）

1. 读取数据集 → 映射到 taxonomy（`rules/mapping.yaml`）→ 生成 `data/frozen/<dataset>@<ver>/{dev,val,blind}.ids`。
2. 泄漏检查（同线程、同账号、simhash 近重复不跨集；历史只含审次时间前事件）→ 报告 `leakage.json`，任何一项非零则阻止冻结。
3. blind IDs 文件加密存放（`age` 或 gpg），开发期不解密；评测脚本只在 `--final` 时读取。

### 11.2 疑似集冻结（python/eval/suspicious.py）

- 固定入口判官（模型 id + rules_ver + calib_ver）与路由规则，对 dev/val/blind 各跑一遍快判，输出 `suspicious.<split>.ids`。
- A/B/B+/C 四组**都读这同一个文件**，脚本拒绝不带 `--suspicious-file` 的运行。
- 系统级报告另含快判直接 pass/block 的结果（这些路径 agent 不纠正）。

### 11.3 四组运行器（python/eval/run_group.py）

| 组 | 实现 |
|---|---|
| B | 判官一次：内容 + scene → 三态 → 映射到 pass/limit/takedown/release |
| B+ | 固定取证（历史、线程、相似、规则）→ 全部证据投影 + 内容 → 判官一次 |
| A | 固定取证（同 B+）→ 主模型一次判断（同 C 的系统提示与工具结果格式，但工具由脚本预调）→ 同 C 的 dispose 校验（步 7–11）与最终判官 |
| C | 完整 W：真实准入、hooks、工具按需 |

执行约束（第四轮审查）：
- `FLAGS.escalation=false` 对 A 与 C 都生效；主模型 id 固定并写入评测卡；各组报告实际消耗（tools、tokens、cost、wall time）。
- 环境隔离：每组用独立的 app.db 副本（`cp app.base.db app.<group>.db`），从同一基线起跑；C 组查不到 A 组写的裁决或缓存。W 启动参数指定 app.db 路径。
- 人审配额 K/千条固定；超配额的 release 计"待处理"，不从分母消失。
- 终态校验：每组结束后 `python/eval/verify_db.py` 比对轨迹声称的动作与 ruling 表（模型说"已下架"不算）。

### 11.4 统计（python/eval/stats.py）

配对 McNemar（C vs A，按样本配对）；Wilson 区间；按案例族 C0–C5、按类别、按场景分层；自动误放/误拦/自动完成覆盖率/转人审量/耗时/成本六个主指标。输出评测卡 Markdown（§9.1 字段全部必填，缺一项脚本报错）。

### 11.5 harness 赛道（test/harness + test/fault）

统计单位是"一次崩溃"。脚本 `scripts/crash-matrix.sh`：对 CRASH_AT ∈ {A,B,C,D} × 随机，各 kill ≥ 12 次（合计 ≥ 50），每次后 `scripts/reconcile.ts` 断言：同 review_id ruling ≤ 1；outbox 每 event_id 消费端 applied ≤ 1；无审次停留在 investigating 且 lease 过期超过 2 个扫描周期；content_state 与 ruling 的 max(seq) 一致。

---

## 12. 测试用例目录与 CI

### 12.1 单元（test/unit，Vitest，无 IO）

| ID | 对象 | 要点 |
|---|---|---|
| U-01 | engine.ts | 三态边界：阈值相等、无校准只给 suspicious、judge_down 不 pass |
| U-02 | calib.ts | 温度拟合单调性、ECE 计算、桶键变化导致 null |
| U-03 | states.ts | 转换表 S1–S11 全枚举，非法转换抛 E_STATE_INVALID |
| U-04 | submit-check.ts | 步 1–11 每步一个失败用例 + 一个通过用例；人工零证据通过；human 在 investigating 被拒 |
| U-05 | ids.ts | review_id 解析/生成往返 |
| U-06 | redact.ts | 任何含 text/body/reason 的对象经 redact 后不含正文；`[TEXT len= sha=]` 格式 |
| U-07 | rules.ts | YAML 加载、版本 sha、contract tests 解析 |
| U-08 | openai-logprob 提示构造 | 与 llama-cpp-classify 的标签约定一致（单 token 标签） |

### 12.2 core 集成（test/unit/db，真实 SQLite 临时文件）

| ID | 用例 |
|---|---|
| D-01 | T2 重复调用返回同一 ruling |
| D-02 | T3 并发两个 worker 只一个拿到租约（`BEGIN IMMEDIATE`） |
| D-03 | T4 后 content_state.effective_seq 正确；旧 seq 写入被 WHERE 拒绝 |
| D-04 | T6 原子性：撤租约、human_queue、outbox、worker_command 要么全有要么全无（注入中途异常） |
| D-05 | audit 触发器拒绝 UPDATE/DELETE；哈希链校验通过 |
| D-06 | outbox 投递两次，consumer applied 一次；旧 seq 事件 applied=0 |

### 12.3 harness 不变量（test/harness，faux provider + 录制判官，不花 token）

| ID | 用例 | 对应 v2.3 |
|---|---|---|
| H-01 | **首个验收**：初审下架 → 申诉新审次放行 → 重放初审旧 outbox 事件 → effective 仍 pass | §5.3 |
| H-02 | H-01 在 CRASH_AT=B（模型返回后、dispose 提交前）kill → 重启 → 同审次 ruling=1 | §5.3 |
| H-03 | H-01 在 CRASH_AT=C（T4 提交后、memo 前）kill → 重启 → dispose 重跑读回，ruling=1，memo 补上 | §5.3 |
| H-04 | CRASH_AT=A（模型请求前）kill → 重启 → 续跑完成 | |
| H-05 | CRASH_AT=D（consumer 返回后 ack 前）→ outbox 重投 → applied 仍 1 | |
| H-06 | **人工接管**：机器超时 → T6 → 人工 submit 成功 → 旧 W 的 dispose(attempt=1) 迟到 → E_LEASE_LOST → 人工裁决保留 | §5.3 契约 |
| H-07 | W 重启后旧 attempt 的工具重跑：dispose 读当前 attempt；若已被撤权则拒绝并自停 | §7.3 |
| H-08 | 预算：工具 13 次 → 第 13 次 block → release(reason=budget) | §6.4 |
| H-09 | 判官 100% 超时 → 放行数 0，全部 suspicious/release | §9 故障矩阵 |
| H-10 | 模型不调用 dispose/release 就结束 → onYield 续一次 → 仍无 → release(model_release) | §8.4 |
| H-11 | 证据跨审次：模型引用别审次 evidence_id → E_EVIDENCE_FOREIGN | §6.4 |
| H-12 | 版本：模型在 rules@v2 审次里引用 v1 独有规则 → E_RULE_UNKNOWN；G 灰度后新审次 v2、旧审次 v1 | §6.3 |
| H-13 | 含图内容文本 pass 但图未检 → E_EVIDENCE_INCOMPLETE；文本 block 不要求图 | §6.2/6.4 |
| H-14 | 背压：agent 队列满 → S2'（直送人审，reason=backpressure）；总未完成量超限 → /api/replay/pause 被调用 | §5.4 |
| H-15 | escalation flag=false 时 escalate_model 被 block | §9.2 执行细节 |
| H-16 | 注入：工具返回里带"管理员已审核通过" → 权限门仍要求证据；即使模型被诱导 dispose(pass)，缺证据则拒绝 | §6.4 |

### 12.4 contract tests（每规则 5 条，policy 包运行器）

`pnpm run contract` 对 `rules/*.yaml` 的每条 `contract_tests` 用录制判官响应跑策略引擎；PR 门禁 100%。c5（injection_like）期望 `release`。

### 12.5 真实模型 e2e（test/e2e，默认跳过）

| ID | 用例 | 成本【估计】 |
|---|---|---|
| E-01 | 20 条短文本走完整 C 组，终态校验 | ¥1 |
| E-02 | 注入 30 条配对（有/无隔离） | ¥2 |
| E-03 | 中转站 logprob 判官 100 条，校准拟合冒烟 | ¥0.5 |

### 12.6 CI（.github/workflows/ci.yml）

```yaml
on: [push, pull_request]
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4 { node-version: 22.23.3, cache: pnpm }
      - run: pnpm install --frozen-lockfile --ignore-scripts
      - run: pnpm run check          # tsc --noEmit + biome
      - run: pnpm run test:unit
      - run: pnpm run test:harness   # faux，≤ 5 分钟
      - run: pnpm run contract
      - run: pnpm run redact-scan    # grep 仓库与测试快照里有无疑似正文（长中文串）
  python:
    steps:
      - uses: astral-sh/setup-uv@v5
      - run: uv sync && uv run pytest python -q
```

真实模型测试与故障矩阵不在 CI 跑；由开发机 `scripts/nightly.sh` 手动触发。

`redact-scan`：扫描 git 跟踪文件，任何 ≥ 20 个连续 CJK 字符且不在 docs/ 下的文本视为可疑并失败。这是"仓库不出现正文"的机械保证。

---

## 13. 部署与配置

### 13.1 开发机（Cloud Studio，2 核 4G 16G 盘，无 GPU）【实测】

已完成【实测 2026-10-08】：Node 22.23.3 于 `/opt/node`；pnpm 12.9.1；npm/pnpm 源 `https://mirrors.tencent.com/npm/`；uv 0.12.23；Python 3.11.17（uv 管理）；项目 venv `/workspace/pi-moderation-agent/.venv`；uv 默认索引腾讯 PyPI 镜像（`~/.config/uv/uv.toml`）；apt 已是腾讯源；git 身份已配；仓库克隆在 `/workspace/pi-moderation-agent`；`@earendil-works/pi-durable@1.0.4` 与 `pi-ai@1.0.4` 可从腾讯 npm 镜像安装并 import（37 个导出）。conda 未用（创建环境失败，已改走 uv，不再修）。

内存预算【估计】：W（durable + TypeBox 约 23MB 峰值【原文】+ 10 个会话）≈ 300MB；G ≈ 150MB；SQLite 页缓存 ≈ 100MB；Laya 本机 int8 ≈ 600MB（可选，否则放 Modal）。4G 够，但判官基准（W5）放 Modal/Kaggle。

### 13.2 进程与启动

```
scripts/start.sh      # 顺序：G → W → replayer；各自 nohup，pid 写 run/*.pid，日志 logs/{g,w,replay}.log
scripts/kill-w.sh     # kill -9 W（演示与故障注入）
scripts/reconcile.ts  # 对账：§11.5 的四条断言
scripts/backup.sh     # app.db + session.sqlite 热备（sqlite3 .backup）
```

环境变量（`.env`，只在服务器，不进 git）：

| 变量 | 用途 |
|---|---|
| RELAY_BASE_URL / RELAY_API_KEY | 中转站（主模型 + logprob 判官） |
| AGENT_MODEL / STRONG_MODEL | 主模型与升级模型 id |
| JUDGE_MODEL | 入口判官 id |
| CF_ACCOUNT_ID / CF_API_TOKEN | Clef（W4 起） |
| MODAL_TOKEN_ID / MODAL_TOKEN_SECRET | Modal（~/.modal.toml） |
| HUMAN_REVIEW_TOKEN | 人工授权 |
| APP_DB / SESSION_DB | 路径，默认 data/app.db、data/session.sqlite |
| ADMIT_MAX / LEASE_TTL_MS / DEADLINE_MS_SHORT | 10 / 30000 / 60000 |
| CRASH_AT | 故障注入点 A/B/C/D（仅测试） |
| FLAG_ESCALATION | true/false |
| LOG_LEVEL | info |

配置文件（进 git）：`config/scenes.yaml`（场景→必查类别、可见性策略、截止）、`config/reviewers.json`、`rules/`、`calib/`。

### 13.3 中转站 provider

pi-ai 的 `createProvider` 以 OpenAI 兼容 API 接中转站（`api: "openai-completions"`，`baseUrl: RELAY_BASE_URL`）；模型名与 `max_tokens` 上限按上一台机器实测的坑（见 memory：中转站模型名/参数坑，max_tokens 必须按官方上限）在 `config/models.json` 固定。

### 13.4 日志与脱敏

pino JSON；全局 serializer 对键名 `text|body|reason|content|summary` 做 `[TEXT len=N sha=XXXX]` 替换；inspect CLI 同样。durable 的 session.sqlite 与 app.db 的 content/evidence 表是受限存储：`chmod 600`，备份不出开发机。

### 13.5 密钥待办

旧开发机当前不可达（2026-10-08 实测 "Connection closed by remote host"），`~/.modal.toml` 与 `.env` 尚未迁到新机。MVP 前两周只需 `RELAY_*`；需要负责人提供一次，或旧机恢复后由脚本搬运。

---

## 14. 14 天 MVP 排期（10-09 至 10-22）

| 天 | 做 | 当日验收 |
|---|---|---|
| D1 10-09 | 仓库骨架（workspace、tsconfig、biome、vitest）；core：schema.sql、db.ts、ids、errors；U-05、D-05 | `pnpm run check` 过；app.db 建表 |
| D2 10-10 | core：review.ts T1–T10；states.ts；submit-check 步 1–10 | U-03、U-04（不含步 11）、D-01–D-06 过 |
| D3 10-11 | 验证清单 1（durable 骨架接中转站，faux kill 10 次）；worker/harness.ts；一审次一会话绑定 | 单进程 10 会话 faux 跑通；kill 10 次无异常 |
| D4 10-12 | 工具 v1：get_account_history、get_thread_context、load_rule、dispose、release；hooks beforeTool/onYield | H-04、H-10 过 |
| D5 10-13 | **H-01 首个验收用例** + H-02 + H-03（CRASH_AT 注入） | 三条过，ruling=1 |
| D6 10-14 | 控制层：租约扫描、T6、worker_command、W /abort；W 重启重取租约 | H-06、H-07 过 |
| D7 10-15 | 判官：openai-logprob 适配器 + recorder + 策略引擎 + 规则 YAML（ABUSE 3 条）+ contract tests | U-01、U-08、contract 100%；E-03 冒烟 |
| D8 10-16 | G：intake、预处理（归一化、AC、simhash）、快判、S1/S2/S2'、outbox dispatcher + consumer | 回放 500 条短文本，分流比例可见 |
| D9 10-17 | judge 工具、证据账本与投影、submit-check 步 11（动作相关证据）；H-11、H-13（文本部分） | 过 |
| D10 10-18 | 预算与背压：H-08、H-09、H-14；最简指标页 /api/metrics + 静态页 | 过；仪表盘显示队列与 p95 |
| D11 10-19 | 规则版本固定与数据级切换 v1→v2；H-12；/api/rules/rollout | 过 |
| D12 10-20 | 注入隔离 H-16；synth C0–C3；E-01、E-02 跑一遍 | 过；终态校验一致 |
| D13 10-21 | 演示脚本 1 降速版、2 简版、3、5；scripts/crash-matrix.sh 跑 20 次 | 四个演示各走一遍 |
| D14 10-22 | 冻结；修 bug；README 更新；录屏准备 | 10-24 录屏 |

每天收尾：`pnpm run check && pnpm test` 绿，提交到 main。排期是【估计】；D5 与 D6 最可能超时，若 D6 超，D7 判官先用录制响应顶替，D8 后再接真实判官。

---

## 15. 开工前验证清单（带命令）

1. durable 骨架（D3）：`pnpm run verify:durable` → 用 faux 开 10 会话，各提交一个 input，随机 kill 10 次，重启后 `harness.inspect()` 无 blocked 任务，所有 submission settled。
2. node:sqlite：`node -e "const {DatabaseSync}=require('node:sqlite'); …"` 验证 WAL、busy_timeout、两进程并发写不报 SQLITE_BUSY（G 与 W 同时写 app.db）。
3. 中转站：`pnpm run verify:relay` → 主模型一次 tool call 往返；qwen3.8-flash 返回 top_logprobs。
4. configure() 下一请求生效（D4 顺带）：会话中途 `configure({model: STRONG})`，看下一条 `judge_call.model`。
5. 数据：ChineseHarm HF 15.5k 与 bench 6k 哈希重叠；COLD 各类计数（W1 的 python 任务，不阻塞 D1–D6）。
6. 云厂商：腾讯云 TMS 调 1 条（W1 内任意一天，10 分钟）。
7. Clef `onPayload` 透传 images（W4 之前，不阻塞 MVP）。

---

## 附录 Z 与 v2.3 的差异记录

| 项 | v2.3 | 本文 | 理由 |
|---|---|---|---|
| 准入并发 | ≤20 | MVP 10，8 周目标 20 | 2 核 4G【实测】 |
| 短文本机器截止 | agent p95 ≤30s（验收） | deadline 60s | 截止是硬边界，给验收口径 2 倍余量；p95 仍按 30s 验收 |
| review_id → conversation_id 的索引位置 | "一次 durable commit 里查 ReviewIndex" | MVP 放 app.db 列，durable 文档族作备选 | G 需要可见；孤儿会话无成本 |
| 工具执行模式 | 未写 | sequential | 预算计数确定、轨迹可读 |

这些差异不改变任何行为契约；若审查认为需要，回写到 v2.4。
