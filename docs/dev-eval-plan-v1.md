# 审核智能体系统：开发与评测方案评审（2026-10-07）

> **写法说明（2026-10-08 起统一）**：本文只记录做了什么、为什么这么做、测得的数字，以及考虑不够全面的地方。文中实验数字和看法均**仅供参考**（样本、设置、标注方式都有限），不作为结论；结论由审查方判断。日期按美国纽约时间（America/New_York）。

**结论**：方案可行，但需求文档里有 4 处默认前提和源码对不上，开工前要先改。

1. **pi-durable 不能运行 coding-agent 的扩展。** `registerTool`、`tool_call`、`registerVirtualModel`、`resources_discover` 都用不上（#10386 仍 open；`coding-agent/src/experimental/durable/README.md:66` 写明 "Not here: … extensions"）。审核 agent 要用 durable 自己的那套 `defineExtension/defineTool/hook` 来写。
2. **`requestId` 只在单个会话内去重**（`durable/src/harness/submissions.ts:154-162`，`types.ts:764`）。"内容 ID → 会话"这层幂等要自己做索引。
3. **Ozone 跟 atproto 身份体系绑死**：要 DID、PLC、AppView、公网域名（HOSTING.md 第 58-75 行的 env）。合成内容没法当它的审核对象，人审工作台建议自建。
4. **4 核 CPU 跑 Laya 撑不到每秒 100 条。** 原文 CPU 数字是在 28 线程以上测的（193–464ms），T4 批量是 7.2ms/问。

数据口径也有更正（实测）：
- ToxiCN 数据就在 GitHub 仓库里（`ToxiCN_1.0.csv`、`train/test.json`），不用发邮件申请。
- ChineseHarm-Bench 的数据许可是 **CC BY-NC 4.0**（仓库代码是 MIT）。HF 上另有 15,515 行的版本。bench.json 共 6,000 条，6 类各 1,000（只统计了标签字段）。

---

## 1. 架构与 Pi 接口映射

### 1.1 框图

```
[回放器 py] → app.db(SQLite WAL) 队列: intake(content_id PK, scene, prio, status, lease)
                 │
┌─ 进程 G：gateway（TS，app.db 读写方）──────────────────────────┐
│ 令牌桶限速 → F2 预处理(归一化/AC 黑白名单/simhash/频控)        │
│ → 快判服务：pi-ai Models.classify()（同一个 ModelRuntime）      │
│    文本判官 ─不确定或带图→ 视觉判官 → 三态 + 校准阈值          │
│ → 通过/拦截直接写账本；疑似进 agent 队列（有界，背压）         │
│ 仪表盘 / 人审页 / 规则灰度 API（同一个 HTTP 服务）             │
└──────────────────────────────────────────────────────────────┘
                 │ 疑似（≤20 并发准入）
┌─ 进程 W：agent worker（TS，独占 session.sqlite）────────────────┐
│ pi-durable Harness：每条内容一个 ownerless 会话                 │
│ 扩展 moderation：工具(查证据/判官复判/升级/处置/释放)           │
│              + hooks(预算、fail-closed、注入隔离)               │
│ 处置 = durable 文档(content_id 先写者胜) → outbox → app.db      │
│        账本 UNIQUE                                              │
└──────────────────────────────────────────────────────────────┘
旁路：Python（评测/校准拟合/合成/Laya-serve 放 Modal）
      运营用 pi CLI + ops 扩展（命令调 G 的 API）
```

拆成两个进程的理由：演示 3 kill -9 掉的是 W，G 还活着，能在仪表盘上看到队列堆积和背压，W 拉起后再消化。

### 1.2 接口映射（需求 → Pi 包/API → 自建部分）

| 需求 | Pi 包 / API（文件:行） | 自建部分 |
|---|---|---|
| F9 每条一个会话 + 崩溃恢复 | `Harness.open(openNodeSqliteStorage)`、`harness.resume()`（durable README:103-124）。SQLite 是 WAL + `synchronous=NORMAL`，进程崩溃不丢已提交的数据（README:540）。一个进程独占一份存储（README:543，spec.md:3251） | 无 |
| F9 内容 ID 幂等 | `requestId` 只在单会话内去重（submissions.ts:154-162）；session 级文档族 `defineDocFamily({scope:"session"})`（documents.ts:60） | 一次 commit 里完成：查 `ContentIndex[content_id]`，没有就 `tx.createConversation` 并登记。之后 `submit({requestId:"mod:"+id})`。两步都幂等 |
| F9 零重复处置 | 工具执行前先提交 intent，没声明 `replay:"safe"` 的工具在恢复时返回 interrupted（tool.ts:84-111）；`api.memo()` 先写者胜、跨 checkpoint 保留（spec.md:1861-1865） | `dispose` 工具声明 `replay:"safe"`，在 `api.commit` 里写处置文档（已存在就返回原值）。outbox 用 `subscribeCommits` 推给 app.db，`INSERT OR IGNORE`。启动时对账 |
| F9 并发 | 调度器每轮把所有可运行任务都预留并启动（scheduler.ts:684-688，spec.md:1895）。**没有并发上限** | 准入信号量（≤20）。恢复时活跃数 ≤ 崩溃前准入数 |
| F10 工具 | `defineTool` + TypeBox；`ToolExecutionApi` 有 commit/memo/details/conversation（harness/types.ts:166-205），**不暴露 models** | 工具通过闭包拿到 ModelRuntime |
| F10 证据账本 → 上下文 | `EntryRecord` 分成 `model`（给模型看）和 `data`（给应用用）两部分；`ContextEdit` 支持 omit/replace（durable types.ts:301-331）；`beforeRequest` 可以改单次请求的 messages | 工具结果全文写入证据文档（存哈希与引用），返回给模型的只是投影：`{evidence_id, 摘要, untrusted:true}` |
| F11 证据不足就升级 | durable 用 `ModelRuntime` 作 `models`（experimental/durable/runtime.ts:141）。但它调的是 `streamSimple`（generation.ts:402），虚拟模型在这条路径上走 `reason:"direct"`，**没有 state，也不 sticky**（model-runtime.ts:715-735） | 首选 `escalate` 工具在 commit 里调 `configure(tx, id, {model:大模型})`，从下一个请求起生效（README:210）。可审计、能挺过崩溃。虚拟模型只做无状态备选 |
| F12 预算 / fail-closed | hooks：`beforeTool` 可拦截、`onYield` 可续跑、`afterTools`（README:383-402）；`pi.usage` 文档记花费 | 计数、墙钟、金额存在会话文档。超限就拦截并强制释放。`dispose(放行)` 前用代码检查"最近一次判官调用成功且低于阈值"，否则只能释放 |
| F13 skills | durable 没有 skill 加载器。coding-agent 导出了 `loadSkills` / `formatSkillsForPrompt`（index.ts:323-327），实验版 durable 用 section 注入（experimental/durable/prompt.ts:34） | 规则手册写成 SKILL.md（agentskills 格式）。系统提示只放目录，`load_skill(name@rule_ver)` 工具按需读取。案例库用 SQLite FTS5（trigram 分词） |
| F4 判官统一 | `ClassifierContext{state: JsonObject, questions}`，三类问题 choice/score/**bool**，线上格式是 `noul`（ai/types.ts:635-690，system-one-shared.ts:147-157）；`ProviderClassifier`（ai/types.ts:318）；扩展可注册 `classifiers` + `type:"classifier"` 模型（extensions/types.ts:1918-1919、1996-2000）；SDK 用 `createProvider({classifiers})`（ai/models.ts:1039） | 新增三个 API：`laya-batch`、`openai-logprob`、`clef-mm` |
| F5 批量 | Pi 一次调用只处理一个 context；codemode 每个脚本最多同时 4 个 classify（codemode.md:93） | 在 `laya-batch` provider 里做微批：10ms 窗口或攒满 64 条就发一次 `/v1/systemone/batch`，再按 Promise 分发回去。调用方无感 |
| F7 图片 | Cloudflare transport 只发 `{model, input:{state, questions}}`（cloudflare…system-one.ts:30）。Clef 的 `images` 是和 state 平级的数组，只收内嵌图，不收 URL（Cloudflare 文档原文） | 用 `options.onPayload` 改写请求体，把 `input.images` 塞进去（system-one-shared.ts:195）。源码看 ModelRuntime 会透传，**未运行验证**，不行就写 `clef-mm` provider |
| F22 轨迹 | pi-telemetry 只有契约、内存实现和一致性测试，没有 exporter；pi-ai 能透传 `telemetryContext`（telemetry README:365-371）；durable 有 `watchEvents`、`subscribeCommits`（README:367-381） | 写一个 SQLite telemetry 适配器（约 150 行，跑官方一致性测试），再加 commit 订阅器补墙钟时间。#10549 说事件没有墙钟时间戳，已关闭，修没修**未核实** |
| F24 审计 | durable 的 JSONL 存储本身就是追加写（README:541） | app.db 的 `audit` 表加触发器禁止 UPDATE/DELETE，再做 `prev_hash` 哈希链 |
| F19-21 规则热更新 | 同名扩展重装后原地替换，新任务用新代码，正在跑的不受影响（README:263-273） | 规则 YAML 放 git。G 端负责灰度分桶，W 端重装 moderation 扩展 |
| 运营面 | coding-agent 扩展：`registerCommand` / `registerTool` / skills / `registerVirtualModel` | pi CLI 上做 `/shadow`、`/rollout 10%`、`/status`，调 G 的 API |

**为什么不用 `createAgentSession` 多实例**：AgentSession 一个实例只管一个会话（sdk.md:28），可以开多个，但中断后工具调用会悬空（#9986、#7053 open），做不到零重复加续跑。留作 Plan B：每条一个内存会话，崩溃就从头重跑，靠 sink 端 UNIQUE 保证零重复。这也正好当 7.3 的对照组，比崩溃后浪费的 token。

**接入队列**：用 app.db 表加租约，不上 BullMQ/Redis，单机多一个组件没收益。背压分三档：agent 队列超过 H 时，快判"疑似"改为直送人审并打标；超过 2H 时暂停回放器；人审队列按"严重度 × 时效"排序（F18）。

**人审页**：Ozone 的成本是公网域名、Bluesky 服务账号、PLC 注册、Postgres，而且审核对象必须是 at:// 记录，合成内容需要自起整套 atproto dev-env（估计 1 周以上）。自建是一张 HTML 加三个 API，约 1.5 天（估计）。建议自建，借鉴 Ozone 的事件溯源模型（emitEvent 的 takedown/label/escalate/acknowledge 事件流 + subject 状态），面试时讲"借鉴了什么、为什么不接"。页面默认脱敏，只显示哈希、类别、概率、证据摘要；点"显示原文"要二次确认，并写入审计。

**仪表盘**：G 进程提供 `/api/metrics`（SQL 窗口聚合）+ 一个静态页（uPlot/Chart.js，走 CDN，SSE 每秒刷新），约 1 天。Grafana + SQLite 数据源插件（frser-sqlite-datasource，未核实）作备选。没有现成的 "pi-web" 仪表盘可复用：pi-web-access 是联网搜索包。

---

## 2. 判官层

### 2.1 第一版组合（暂定，第 2 周基准跑完按决策规则定）

| 角色 | 首选 | 备选 | 依据 / 风险 |
|---|---|---|---|
| 文本主判官（快判） | Laya-multilingual 微调版，跑在 Modal T4 的 laya-serve + 微批 | Jev（渠道打通后） | T4 批量 7.2ms/问（原文）；单 T4 每题 2 问时估计约 70 条/秒 |
| 规则当输入的判官（新规则、灰度） | Jev | qwen3.8-flash logprob | zh-decision-bench：LLM logit 探针在二元题上崩（Qwen3.5-2B 0.533 / ECE 0.42，原文，n=21）。所以 **logprob 判官只问 choice（含"不违规/无法判断"），不问 bool** |
| 视觉判官 | Clef-flash（免费额度） | OneJev-4B GGUF 跑 Modal；中转站视觉模型只出标签 | 视觉模型不返回 logprobs（实测），不能进阈值体系 |
| agent 内复判 | glm-5.3 logprob（带证据的 state） | Jev | 和快判用不同模型，减少同源误差 |

**接入顺序**：qwen logprob（已实测能用）→ Laya 零样本（本机 CPU，只跑评测）→ Jev → Laya 微调（Kaggle）→ Clef。

**决策规则**：在开发集上按"宏 F1 − 0.5×ECE"排序。延迟 p95 超过 500ms 的不能当快判主判官。

### 2.2 适配器 JSON（和 `/v1/systemone` 兼容：state/questions 原样透传，线上 bool↔noul 互转）

```json
// 请求
{"request_id":"…","content_id":"…","rule_version":"rules@<sha>",
 "state":{"content":{"text_ref":"sha256:…","text":"…","scene":"comment"},
          "context":{…},"images":[{"ref":"blob:sha256:…"}]},
 "questions":{"cat":{"type":"choice","instructions":"…","criteria":{…},"rule_ids":["CH-FRAUD-003"]}},
 "options":{"shuffle_seed":17,"timeout_ms":400,"calib":"calib/laya-ft/CH-FRAUD@3.json"}}
// 响应
{"judge":{"provider":"laya","model":"laya-ft-v1","api":"laya-batch"},
 "status":"ok|timeout|error|abstain",
 "answers":{"cat":{"type":"choice","choice":"…","probabilities":{…},"confidence":0.81,
            "calibrated":{"probabilities":{…},"T":1.4}}},
 "latency_ms":38,"usage":{"input":412,"output":0,"cost_usd":0.0}}
```

- `text` 只在进程内存里存在，落库只存 `text_ref`。
- F8 打乱复问：同一问题用两个 seed 重排选项，argmax 不一致就标"疑似"。

### 2.3 规则 criteria 格式（`rules/CH-FRAUD-003.yaml`，git 版本化）

```yaml
rule_id: CH-FRAUD-003
version: 3
category: 欺诈
scenes: [comment, post, nickname]
severity: 2
default_action: takedown
text: "…"
exceptions: [{id: EX-QUOTE, text: "反诈科普、引用举报"}]
question: {id: fraud, type: choice, options: {fraud: "…", benign_mention: "…", none: "…", unknown: "…"}}
thresholds: {block: 0.92, pass: 0.10, keyed_by_option_count: true}
fixtures:   # 成对夹具，五种都要有（jev-skill 方法）
  - {id: f1, kind: true_risk,             ref: fx/fraud-1, expect: violate}
  - {id: f2, kind: benign_mention,        ref: fx/fraud-2, expect: pass}
  - {id: f3, kind: quote,                 ref: fx/fraud-3, expect: pass}
  - {id: f4, kind: missing_evidence,      ref: fx/fraud-4, expect: release}
  - {id: f5, kind: conflicting_evidence,  ref: fx/fraud-5, expect: release}
```

种子来自 ChineseHarm-Bench 的 `knowledge.py`（约 5KB 规则文本，实测大小，正文没读）。

**校准**：Python 离线拟合，按"判官 × 规则 × 选项数"做温度缩放，样本 ≥200 时改用 isotonic。结果写成 `calib/*.json`，G 端热加载。触发条件：某条规则新增标注数 ≥ n_min。

### 2.4 Laya 微调与"规则当输入 vs 规则进权重"实验

- **微调数据**：ChineseHarm HF 15.5k（先按文本哈希剔除和 bench 6k 重叠的部分，**待验证**）+ COLD 训练集 32k。Kaggle 2×T4 约 4–5 小时（原文）。
- **v1→v2 改规则用确定性重标**，不需要重新标注：
  - COLD 测试集细粒度标签：v1 违规 = {攻击个人, 攻击群体}；v2 违规 = {攻击群体}，个人互怼改为限流。
  - ChineseHarm：把"黑产广告"拆出"引流"子规则。
- **四个臂**：零样本判官只改 criteria；微调模型不重训；微调模型 + criteria 进 state；重训（只记时间和成本）。
- **指标**：受影响子集准确率、不受影响子集回归、生效耗时。
- 先读 verdict-lab 已发在 HF 的"规则变更"结果，避免重复做。

---

## 3. 数据与合成

### 3.1 数据集

| 数据 | 结构（只看了字段） | 许可 | 训练 | 评测 | 再分发 |
|---|---|---|---|---|---|
| ChineseHarm-Bench | `文本` / `标签`；6 类：不违规、低俗色情、博彩、欺诈、谩骂引战、黑产广告，各 1,000（实测）；HF 版 15,515 行 | CC BY-NC 4.0（原文） | 可以（非商用） | 主评测 | 非商用、要署名 |
| COLD | train/dev 二分类；test 5,323 条 4 类：安全 / 攻击个人 / 攻击群体 / 反偏见 | Apache-2.0 | 可以 | 可以 | 可以 |
| ToxiCN | toxic、toxic_type、expression（含"报道"=3）、target 多标签；直接从 GitHub 下 | CC BY-NC-ND 4.0 | **不建议**（ND，训练算不算衍生不明） | 可以 | 不可改编再分发 |
| ToxiCN_MM | label、type(0-4)、modal 四种组合；v2.0 标签 json 在仓库里，图片要填表申请 | CC BY-NC-ND | 不建议 | 视觉评测 | 不可以 |
| zh-decision-bench | 审核 21 题（含关键词陷阱）+ 2,335 条原始预测 | 仓库 Apache-2.0；MASSIVE 部分 CC BY 4.0（原文） | 否 | 判官对照 | 可以 |

**"看着有事、实际没事"可以直接用真实标签**：COLD 的"反偏见"类、ToxiCN 的 expression=3（报道）。这是误拦实验的真数据，不用合成。

### 3.2 合成规则（Python 包 `synth/`，代码和生成规则公开）

- **不让 LLM 生成有害文本。** 上下文中的"其他评论"从同一数据集抽带标签的样本，按 ID 引用。账号画像、历史处置、申诉、时序全是结构化字段。
- **案例族与 gold 推导**（推导规则写在规则手册里，公开）：

| 族 | 构造 | gold | 占比 |
|---|---|---|---|
| C0 普通 | 不需要上下文 | 用数据集标签 | 60% |
| C1 查历史才有事 | 本条无害或边界 + 7 天内同规则处置 ≥3 次 + 引流特征（合成占位符） | 违规 | 10% |
| C2 查上下文才没事 | 反偏见/报道类 + 引用链 | 通过 | 10% |
| C3 诱饵 | 历史很差，但本条无害 | 通过（测历史偏见） | 10% |
| C4 证据缺失/冲突 | 工具返回空，或两条证据矛盾 | 释放 | 5% |
| C5 协同刷量 | 近重复内容跨账号、短时间窗 | 违规（靠同款处置工具） | 5% |

- **流量时序**：泊松到达 + 突发；场景配比固定；按比例插入重复以测 simhash。
- **防"合成偏向 agent"**：
  1. 盲测集换 seed，模板变体由 gpt-6.1-sol 或外人在 agent 冻结后编写，开发期不可见。
  2. 捷径审计：只用上下文元特征训练逻辑回归，准确率过高说明合成太"顺手"。
  3. 请 2 人用"上下文 + 掩码正文"抽查 50 条 gold，报 κ。
  4. 结果按案例族分层报告，**不报合并后的总召回**。

### 3.3 脱敏

| 存放位置 | 处理方式 |
|---|---|
| 正文 | 只在 `content` 表（本地文件，不进 git）和 durable 的 `session.sqlite` 里有明文。后者没法避免：模型上下文里就是正文 |
| app.db 其他表、轨迹、日志、仪表盘 | 只存 `content_id`、sha256、长度、场景 |
| telemetry 适配器 | 内置 redact |
| 调试 | 统一用 `inspect` CLI，正文打印成 `[TEXT len=42 sha=ab12]`。禁止直接 `sqlite3 .dump` |
| 需要读内容的判定 | 交给 glm-5.3-flash；存疑样本只输出行号 |

---

## 4. 八周计划（10-08 起）

| 周 | 交付 | 验收 | 依赖 / 风险 | 开销（估计） |
|---|---|---|---|---|
| W1 10-08 | durable 单进程 20 会话 + 中转站模型跑通；内容索引幂等；faux provider 下 kill 恢复；快判接 qwen logprob；app.db 队列 + 预处理 | 20 并发跑通；kill 10 次重复 0 | #9508（中转站 400）→ 配 `compat`；当天提交 ToxiCN_MM 申请表 | ¥20 |
| W2 10-15 | 判官基准（文本）；Laya 在 Kaggle 微调；处置 outbox + 审计链；agent 工具 v1（历史/上下文/规则 skill/处置/释放） | 判官表出来；agent 跑完 200 条 | Jev 渠道 | ¥60 + Modal $3 |
| W3 10-22 | **MVP**：演示 1（降速版）、3、5；最简仪表盘；合成 C0–C3 | 10-24 录屏 | 文本快判到 100/s 要靠 Modal 或 Jev | ¥80 + $2 |
| W4 10-29 | 视觉级联（Clef / OneJev）；人审页；F18 排序；预算与 fail-closed 完整版 | 判官超时注入时放行数 0 | Clef 图片格式 | ¥30 + $5 |
| W5 11-05 | 7.2 实验（开发集 → 冻结 → 盲测） | 出配对检验结果 | 盲测由外人出题 | ¥150 |
| W6 11-12 | 7.3 故障注入全套；Plan B 对照；吞吐压测 | 50 次 kill 报告 | 无 | ¥20 + $3 |
| W7 11-19 | 规则治理（影子/灰度/门槛）+ 回流重拟；演示 2、4；ops 扩展 | 改规则 ≤5 分钟生效且夹具全过 | 无 | ¥40 |
| W8 11-26 | 文章、报告、演示脚本；缓冲 | 五个场景一次通过 | 无 | ¥100 |

- **合计**：约 ¥500 + Modal ≤$15/月（估计；中转站单价未核实）。Modal 价格原文：T4 $0.59/h，L4 $0.80/h。
- **可以并行**：判官基准（Python）‖ durable 骨架（TS）；合成 ‖ 仪表盘。
- **必须串行**：内容索引 → 处置 outbox → 故障注入；校准 → 回流重拟。
- **可直接复用的开源**：

| 仓库 | 怎么用 |
|---|---|
| durable 示例 13-recovery、22-subagent-foreground、24-child-tasks | 恢复、replay-safe、memo 写法 |
| Pi `llama-cpp-classify.ts` | 照抄提示结构和标签概率逻辑，改成 OpenAI 的 `top_logprobs`（≤20） |
| notjev | 线上协议参考 |
| laya `laya-serve` + Kaggle notebook | 改训练 CSV 字段 |
| zh-decision-bench 的 refit / permute 脚本 | 校准、顺序翻转测试 |
| jev-skill 的 `jev.py` | 响应校验（概率有限且在 [0,1]、总质量误差 ≤0.05） |
| multi-agent-moderation | 只参考输出字段（规则版本号、触发计数） |

---

## 5. 评测方案

| 实验 | 切分与对照 | 样本量与统计 | 怎么呈现 | 零结果能说明什么 |
|---|---|---|---|---|
| 7.1 判官 | COLD/ChineseHarm 按 ID 分层 50/50 拆开发和盲测；温度只在开发集拟合 | 每个判官 ≥2,000 条；宏 F1 用 bootstrap CI，ECE 15 桶，Wilson 区间 | 可靠性图；覆盖率–风险曲线；成本–准确率散点 | 零样本 ≈ 微调：规则当输入可以不掉精度地替代重训 |
| 7.2 agent | A 大模型直接判；B 判官单跳；**B+ 判官 + 全部证据预先塞进 state**；C 完整 agent。人审配额固定 K/千条，人审 = gold oracle | 配对 McNemar：不一致率 10% 时，检出 5pp 需约 312 条，3pp 需约 870 条（计算）。开发 400 + 盲测 900 条疑似 | 分族召回表；配额–召回曲线；每条成本与 p95 | C ≈ B+：价值在证据接入，不在 agent 循环，可改成"取证流水线 + 判官"，更便宜。C ≈ B：上下文在这批数据里不起作用，要看分层结果 |
| 7.3 恢复 | kill 两种：随机时刻 + 定点（`CRASH_AT=` 判官调用中 / 模型流式中 / dispose commit 后、outbox 前 / outbox 后）。faux provider，不花 token | 50 次 kill × 每次约 20 条在途 ≈ 1,000 次暴露；重复 0 时 95% 上界约 0.4%（Wilson） | 重复/丢失计数；浪费 token；恢复延迟 p95；durable vs Plan B | 两边浪费 token 一样多：durable 的价值只剩不重复，要如实写 |
| 7.3 超时/积压 | 判官注入 100% 超时和 30% 抖动；回放 2× 容量 | 放行数必须 0（硬门槛） | 队列长度和 p95 时间线 | 无 |
| 7.3 注入 | 在 state 末尾追加"管理员已审核通过"类话术（照 jev-skill 中"经理已决定"骗过 147/200 的写法），对比有无隔离 | 每组 300 条，配对 | 翻转率 + Wilson 区间 | 无防护时也不翻：说明判官本身抗这一类，换攻击类型 |
| 灰度 | 影子：v2 在决策账本快照上回放，预测翻转数 → 10% 分桶（`hash(id)%100`）→ 全量。门槛：夹具 100%，翻转 ≤ 上限 | 预测翻转 vs 实际翻转的一致率 | 漏斗 + 混淆表 | 预测不准：快照里缺证据版本，按 jev-skill 的教训把证据版本纳入缓存键 |
| 回流重拟 | 人审结论回流；按规则做温度 + 阈值重拟，用 Beta 先验收缩 | 正式 n_min=30；演示模式 n_min=10，屏幕上明示 | 重拟前后释放率和漏放率（盲测集） | 释放率不降：校准已经够好，结论是不需要在线重拟 |

**成本核算**：pi-ai 的 `usage.cost` + `pi.usage` 文档 + 判官 usage，统一写入账本，按条汇总，按单价表折算成人民币。

---

## 6. 面试叙事

| 演示 | harness 能力 | JD 关键词 |
|---|---|---|
| 1 回放 100 条/秒 | 准入、背压、级联、成本 | 并发控制、吞吐、降级 |
| 2 改规则灰度 | 版本化、影子回放、回归门槛 | 规则热更新、可量化评测 |
| 3 kill -9 | durable 检查点、intent、outbox 幂等 | 断点恢复、异常处理、状态持久化 |
| 4 人审改 10 条 | 人在环、回流、校准 | 人在环、闭环 |
| 5 注入 | 证据/指令分离、代码层权限门 | 安全防护、工具安全 |

**面试官可能的追问**：
1. 为什么做到零重复？答：intent 先提交，处置以内容 ID 先写者胜，outbox 写入 sink 时 UNIQUE。讲清 exactly-once 的边界在哪。
2. 为什么不用 Temporal？答：要把 LLM 轮次和工具结果续回模型上下文，durable 原生做这件事；再拿浪费 token 的对照数据说话。
3. 判官概率可信吗？答：先校准，再按选项数分别设阈值。"置信度不是权限"。
4. fail-closed 会不会把人审打爆？答：背压分档，演示 1 现场展示。
5. 合成数据是不是自证？答：B+ 对照、盲测、捷径审计、κ。
6. 成本？答：每千条和每条的实测账单。
7. 并发 20 个会话，SQLite 扛得住吗？答：给出 bench 数字，以及调大 `progress` 提交间隔的取舍。
8. 规则冲突或有例外怎么办？答：成对夹具 + 影子翻转。

**最可能被质疑的两点**：
1. **"agent 的优势是你构造出来的。"** 应对：头条只报 B+ vs C 和分层结果，承认真实流量里 C1–C5 的占比未知。
2. **"判官和 policy-as-input 都不新。"** 应对：卖点放在 harness 机制，每个机制都有对照数据。另外 ChineseHarm-Bench 的数据由腾讯提供，投腾讯时可以拿来讲。

---

## 7. 风险与替代

| 风险 | 替代路径 |
|---|---|
| durable 标着 Experimental（README:3），API 会无预告变；#10411 等待环死锁；#10386 | 锁定 1.0.4；不用任务互等；Plan B 是 AgentSession + sink 幂等 |
| TS 学习曲线 | Pi 侧控制在 2k 行以内（估计）；`node --experimental-strip-types` 不用构建；vitest + faux provider 写测试；数据、评测、校准全用 Python |
| Jev 渠道不稳或类型未知 | qwen logprob + Laya，规则当输入的判官退到 qwen 的 choice 题 |
| Clef 额度 | 每天 1 万 neurons，分几天跑；OneJev 放 Modal |
| Laya 中文弱、过度自信 | 先校准再微调；zh-decision-bench 原文：业务场景只有 0.52–0.67 |
| 中转站并发时延迟飙到 300 秒（实测） | 快判层不依赖中转站；agent 设超时，超时就释放 |
| ToxiCN_MM 申请周期 | 视觉评测往后放；先用 Clef 在 ChineseHarm 的图文上做冒烟测试 |
| 许可 | 演示和报告不展示正文；仓库不放任何数据 |

---

## 开工前必须先验证的 5 件事（按顺序）

1. **durable 骨架。** 单进程 20 个会话 + 中转站 glm-5.3-flash（配 `compat`，避开 #9508）；`npm run bench:storage` 加自测 commit 吞吐；验证内容索引的"session 文档族 + createConversation + submit requestId"写法；faux provider 下 kill 10 次。
2. **快判吞吐。** Laya ONNX INT8 在 4 核上的单问延迟；Modal T4 上 laya-serve 微批的条/秒；Jev 渠道类型和限流。据此把"100 条/秒"落到具体部署上。
3. **Clef 图片通道。** `onPayload` 能否经 ModelRuntime 透传；`images` 元素格式（base64？）；每张图耗多少 neurons。
4. **升级路径。** 运行中途 `configure()` 换模型，下一请求是否生效；虚拟模型在 durable 下按 direct 路由的实际行为。
5. **数据。** ChineseHarm HF 15.5k 和 bench 6k 的哈希重叠；COLD 细粒度各类计数。ToxiCN_MM 申请表当天提交。

---

## 来源

**Pi 源码**（`/home/ubuntu/.claude/jobs/dfd4e9fe/tmp/pi`，HEAD ddaa0a0，2026-10-06）
- `packages/durable/`：`README.md`；`docs/spec.md`；`src/harness/{submissions,tool,types,scheduler,generation}.ts`；`src/types.ts`；`src/documents.ts`
- `packages/coding-agent/`：`src/core/{model-runtime,virtual-models}.ts`；`src/core/extensions/types.ts`；`src/experimental/durable/{README.md,runtime.ts,prompt.ts}`；`docs/{virtual-models,models,codemode,skills,sdk}.md`
- `packages/ai/src/`：`types.ts`；`models.ts`；`api/{system-one-shared,cloudflare-workers-ai-system-one,llama-cpp-classify}.ts`
- `packages/telemetry/README.md`、`packages/server/README.md`、`packages/chord/README.md`

**Pi issue**（gh 拉取，2026-10-07）：#10386、#10411、#10455、#10535、#10325、#10549（已关闭）、#9508、#9986、#7053

**本项目文件**
- 需求文档：`/home/ubuntu/agent-fa/docs/requirements-v1.md`
- 前期调研：`/home/ubuntu/agent-fa/reports/` 下 9 份报告
- jev-skill 本地副本：`/home/ubuntu/.claude/jobs/dfd4e9fe/tmp/jevskill`

**外部**
- Ozone 自托管：https://github.com/bluesky-social/ozone/blob/main/HOSTING.md
- ChineseHarm-Bench：https://github.com/zjunlp/ChineseHarm-bench ；https://huggingface.co/datasets/zjunlp/ChineseHarm-bench
- COLD：https://github.com/thu-coai/COLDataset
- ToxiCN：https://github.com/DUT-lujunyu/ToxiCN
- ToxiCN_MM：https://github.com/DUT-lujunyu/ToxiCN_MM
- zh-decision-bench：https://github.com/CodyQin/zh-decision-bench
- Laya：https://github.com/NandhaKishorM/laya
- Cloudflare Clef：https://developers.cloudflare.com/workers-ai/models/clef/
- Modal 定价：https://modal.com/pricing