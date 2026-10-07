# 第七轮：自审（三个子 agent 分角度 + 本人复核），基于 e0ea08c 的开发文档 v1.2（2026-10-08）

方法：三个独立子 agent 分别审 (A) Pi 1.0.4 接口用法（对照 d.ts/README/同版本源码）、(B) 数据模型与事务（在本机用 sqlite3 与 node:sqlite 实跑反例）、(C) 评测协议、测试覆盖、审查闭环。本人对高/中严重度条目逐条复核来源后汇总。标【实测】的是子 agent 实际运行得到的结果。

## 必须修（会导致功能不成立或测试无法通过）

| # | 位置 | 问题 | 证据 | 修法 |
|---|---|---|---|---|
| 1 | §8.6 | faux 脚本的工具调用缺 `{stopReason:"toolUse"}`，durable 会把它当最终答案，工具一次不跑，H-01–H-28 全部失效 | pi-ai README 1456–1461 原例带 stopReason；durable generation 只在 toolUse 时开工具轮 | 所有含工具调用的脚本回复加 stopReason |
| 2 | §5.4 / §2.2 | judge_call 只有一个 question_sha，但一次判官调用含多个问题（快判一次问全部类别 + 例外）；effective() 按单问题 sha 分组，快判结果永远不进 trusted，fastpath 步 11 必拒；choice 列也不存在 | DDL 无 answers/choice 列；§6.5 响应 answers 多值 | 新增 judge_answer(judge_call_id, rule_id, question_sha, choice, raw/calibrated_probs)；effective 在 judge_answer 上分组 |
| 3 | §3.3 / S1 | content_state 只写 UPDATE，快判直接裁决（S1）前没有行，UPDATE 0 行；§11.5 最终一致对这类内容必失败【实测 changes=0】 | S2 才创建初态行 | 改 upsert：INSERT … ON CONFLICT DO UPDATE … WHERE excluded.seq > effective_seq；S5/S9 同时按场景写 visibility |
| 4 | §5.2 步 6 vs T11 | 步 6 的 SUM 没有 `status≠'blocked'`，H-08/H-22 之后 dispose 被 E_BUDGET_EXCEEDED 拒，与 §7.5 "dispose/release 仍放行"冲突【实测 SUM=14】 | 两处 SQL 不同 | 抽成 core.usedToolSlots()，两处同一条 |
| 5 | §5.2 步 8 | 规则 YAML 没有 allowed_actions 字段；ruleIds=[] 时步 8–10 空真，人工零证据 takedown 可带空 rule_ids 通过，但 feedback.rule_id NOT NULL 无法回流 | v2.3 §6.3 字段表 | scenes.yaml 定义场景级动作白名单；规则级 allowed = {pass} ∪ {default_action}；limit/takedown 要求 ruleIds 非空（human 也要求） |
| 6 | §5.4 vs §9.3 | block_support 要求全部例外 not_applies；带例外的规则若快判没问例外问题 → unknown → S1 的 T2 在步 11 被拒 | | 规定快判一次调用包含适用规则的全部问题 + 例外问题（Jev 支持多问题，实测）；没问例外的规则不得快拦 |
| 7 | §5.4 effective | "唯一极大证据集替代"给了无限次单采样放行机会：每加一条证据（含 load_rule）就是新的单样本；上一组 inconsistent 也会被超集单条抹掉【实测案例 4、5】 | effective.py 推演 | evidence_set 只计 content-bearing 证据（排除 kind=rule）；pass_support 要求有效组经 shuffle 复问确认（≥2 条一致）；翻到放行侧必复问 |
| 8 | §7.3 表 vs §8.4 | beforeTool 对 finalize 模式也 block，finalize 会话恢复的是 generation 任务时，模型新发的 dispose 到不了工具体，只能靠 onYield 结束，多花请求 | tool.d.ts：block 在 call 阶段结算 | beforeTool 对 finalize 放行 TERMINAL_TOOLS |
| 9 | §8.3 | control.terminate 只在"该轮每个结果都要求"时结束 run；模型同轮发 dispose + 另一工具时会再请求一次模型 | durable README 168 原句 | 注明条件；beforeTool 对"同轮已含终结工具的其他调用"block |
| 10 | §11.5 第 4、6 条 | inspect() 只列未结 submission，看不到 settled；且 reconcile.ts 是独立进程，W 独占 session.sqlite，无法跨进程 inspect | harness/types.d.ts 434–435、508 | review 加 submission_id 列，用 harness.submission(id).status()；对账分两种模式：W 活着走 W HTTP（返回按会话的任务/submission 清单），W 死时只读打开 session.sqlite 并注明是唯一允许的跨进程读 |
| 11 | §4 T9 / S10 | T9 没检查上一审次是否终态，同一内容可并行开 appeal#2、appeal#3【实测】；UNIQUE 含 trigger，同 request_id 换 trigger 再开一审次 | | T9 要求最新审次 ∈ {disposed, human_disposed} 否则 E_STATE_INVALID；UNIQUE 改 (content_id, trigger_request_id) |
| 12 | §4 T5 | release 没有代次/租约检查，旧代次的 release 能把已 S8 requeue 的审次送人审 | S6 前置"持有当前代次"无对应 WHERE | actor=agent 时 WHERE lease_owner=? AND attempt=?；S7 只对应 T6 |
| 13 | §4 T3 | WHERE 缺 deadline_at > now 与 attempt < N；N 全文未定义（review 表只有 attempt 列）；0 行时不区分 human_queue | | T3 加两条件；MAX_ATTEMPTS 入 §13.2；0 行回读 state 区分 E_LEASE_HELD / E_STATE_INVALID；§3.2 补 S3'（过期自取） |
| 14 | §2 / §13 | node:sqlite 同步 API 下 busy_timeout 等锁会冻结整个事件循环：实测 1.5s 等锁期间 setTimeout 不触发；按 5000ms 配置 W 的心跳、轮询、hooks 最长停摆 5s | nodechk.mjs【实测】 | W 的 busy_timeout ≤ 1–2s；所有写事务 BEGIN IMMEDIATE（deferred 会 BUSY_SNAPSHOT 且 busy handler 不生效【实测】）列为代码审查项；T15 必须 ROLLBACK 后再 BEGIN；busy_timeout 每连接设置 |
| 15 | §11.5 第 1 条 | "ruling ≤1、consumer_log ≤1"是主键同义反复，证明不了"50 次崩溃重复 0" | 主键永远 ≤1 | 消费端加投递收据表（每次收到都 INSERT）；不变量改为"收据 ≥1 且 applied/notified 恰 1"；D-06/H-05 断言收据 ≥2 |
| 16 | §11.5 第 3 条 | 守恒检查发现不了卡在 received 的内容（"等待中"无定义）【实测返回空】；queued 过 deadline 不被标；failed 状态无转换到达 | | 用 updated_at 与 2×扫描周期判龄；queued 加 deadline 判龄；删 failed 或定义 intake_failed 审计 |

## 应修（一致性与可执行性）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 17 | §11.3 | B/B+ 绕过审次生命周期，没有 snapshot_seq、没有 review/ruling 行，指标与"固定取证"边界都算不出 | 写明 B/B+ 不走 T3–T4，用 C 组审次的 snapshot_seq 或冻结时统一取号；三态→指标映射；时延不与 A/C 横比 |
| 18 | H-08 | 期望 release(reason=budget_tools)，正文没有这条触发路径 | afterTools：本轮存在 blocked 行且未终结 → hostLoop release(budget_tools) |
| 19 | §5.4 / H-13 / §14 | image_check 在 effective() 里没有身份（不是规则）；H-13 在阶段 4 但 get_image/clef-mm 不在任何阶段 | image_check 定义为内置 question（固定 question_sha）；阶段 4 加 Clef 录制版 |
| 20 | §9.1 | Jev 接入写法不完整：createProvider 需要 classifiers 里注册 typesafe-system-one 的实现，且模型条目缺必填 name | 补条目与 `typesafeSystemOneApi()` |
| 21 | §8.6 / §15.1 | 一个 faux provider 驱动 10 个并发会话不确定（README 1507/1515） | 每会话一个 provider id，或 harness 测试 ADMIT_MAX=1 |
| 22 | §3.2 S1/S2/S2' | 快判 judge_call 先于 review 行写入，review_id 为空，步 10/trusted 排除它 | T2/T2' 同事务 UPDATE judge_call SET review_id |
| 23 | §5.2 步 4 / H-06 | 两个错误码对四个条件无映射；H-06 按步 2 顺序必是 E_STATE_INVALID，断言应收紧 | owner≠ 或过期 → E_LEASE_LOST；attempt≠ 或 revoked → E_ATTEMPT_STALE；新增"S8 后旧 attempt → E_ATTEMPT_STALE"用例 |
| 24 | §6.3 / §8.4 | E_LEASE_HELD 三处语义不一致；beforeTool 无 grant 返回"被他人持有" | 无 grant 一律 E_LEASE_LOST；§6.3 该句改写 |
| 25 | §11.4 成本 | S7/S11 撤权审次 used_micro 永远 NULL | 回退口径：Σ model_call + judge_call + tool_slot，标 estimated |
| 26 | §7.5 公式 | 漏 settled_micro 与在飞 reserved；used_micro 三处写入 | 公式改 pi.usage.models + Σ settled + Σ reserved(reserved\|unknown)；只留一处写 |
| 27 | §5.4 第二步 | 规则与类别混用；image_ok 与 required 重复 | covered(c) = ∀ r∈rules(c): pass_support(r)；删 image_ok |
| 28 | §14 | reconcile.ts 不在任何阶段；H-24 是阶段 2 条件；崩溃次数三处数字（≥50/≥20/10）不一致；阶段 1 停止条件是通过条件子集 | 阶段 1 加 reconcile 1–3、5；阶段 2 加 4、6；注明 ≥20 是演示前最小量、≥50 是 W7 量；停止条件改为"反例无法在 node:sqlite 语义下关闭" |
| 29 | H-14 | "总未完成量"无定义无阈值 | §6.3 定义 = intake 非 judged + review 非终态；三个阈值环境变量 |
| 30 | §8.5 | ruling 无 event_time/account_id，账号历史查询需 join content | 写清 join |
| 31 | 覆盖表 | v2.3 的回流候选阈值、轨迹 100%、≤5 分钟生效、仪表盘分流、三项吞吐、dry-run、load_skill、安全赛道 300 条、K 数值、人审排序、预处理规格等在开发文档无机制或无用例 | 加"契约 → 机制 → 用例 → 阶段/周次"覆盖表，后移项显式标 W4–W8 |
| 32 | 杂项 | 【原文】标注位置错 4 处（paused、不重跑 beforeTool、单会话 requestId、onPayload）；llama-cpp-classify 描述与源不符；revoked 会话"≤1 次请求"无依据应标【估计】；afterResponse 可能收到失败响应；E_BUDGET_COST 不在错误码表；core.hasTerminal/unknownReserved/readRuling/bindConversation 不在函数表；grant 字段 §7.3 与 §8.3 不一致；rule_change 的 trigger_request_id 未定义；S6 列名 release_reason；python 回放器直接写 content 必须走 ledger_seq + BEGIN IMMEDIATE；DDL 缺 CHECK/FK/索引（ruling→review 的 (content_id,seq) FK【实测可插不一致行】、review(state,lease_until)、judge_call(review_id)、evidence(review_id)、content(thread_id,event_time) 等）；stream.timeoutMs=60s × 重试 2 次 = 单次生成最长 180s 远超 60s 截止 | 逐条改 |

## 核对无误（三方都确认）
启动调度清单与 inspect 只读；工具恢复不重跑 beforeTool、callId 稳定；memo first-writer-wins 用法；HookApi 成员与 hooks 签名；UsageDoc 经 snapshot 可读（【待核】可关闭）；configure/createConversation/submit/terminate/abort/waitForIdle 签名；typesafe URL 拼接；ClassifierContext/Result 字段；as-of 边界三种情形【实测】；T2' snapshot_seq 只读足够；T10 四条规则【实测】；T11/H-22/H-08 算术【实测】；ruling UNIQUE + 条件更新【实测】；T9 三分支【实测】；H-17/H-25 声明的用例【实测】；人工零证据路径；§3.2↔§4 对应（除 S7/S3'）；用例编号连续；参数数字全文一致。

## 结论
v1.2 的方向与主要机制成立，但有 16 处会让实现或测试直接不成立的问题（其中 7 处由实际跑反例证实），集中在：判官结果的表结构与 effective 规则（#2、#5、#6、#7）、几个事务的 WHERE 条件（#11、#12、#13）、content_state 写法（#3）、faux 与 finalize 的 Pi 细节（#1、#8、#9、#10）、node:sqlite 的锁行为（#14）、对账的证明力（#15、#16）。应修成 v1.3 再开阶段 1。
