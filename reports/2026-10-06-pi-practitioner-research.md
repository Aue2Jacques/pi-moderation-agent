# Pi 二开选题调研：Pi 的现状与缺口、行业 harness 进展、招聘匹配（2026-10-06）

> **写法说明（2026-10-08 起统一）**：本文只记录做了什么、为什么这么做、测得的数字，以及考虑不够全面的地方。文中实验数字和看法均**仅供参考**（样本、设置、标注方式都有限），不作为结论；结论由审查方判断。日期按美国纽约时间（America/New_York）。

**结论**：推荐做"**执行和控制分离、崩溃后能接着跑**"的远程沙箱执行层。agent 进程被 kill、断网、重启以后，正在 Modal 沙箱里跑的命令不中断、不重复执行。重启后去沙箱里把真实结果找回来，而不是返回 `interrupted`。交付形式是 pi-durable 的一个 `ExecutionEnv` 实现，加上一个崩溃后可安全重放的 bash 工具，用 Pi 官方的 conformance 套件和故障注入实验来证明。

> 口径：我克隆了 `earendil-works/pi`（HEAD 2026-10-06，ddaa0a0）和 `harbor-framework/harbor`（2026-10-05）直接读源码；issue 和 discussion 用 `gh` 拉取；其他产品看的是 GitHub release 或官方 changelog。标"未核实"的是只看到搜索摘要、没打开原文；标"估计"的是推算。

---

## 1. Pi 是什么，怎么二开，现在的问题

### 1.1 包和接口（源码 v1.0.4，2026-10-05）

| 包 | 实际能力边界 | 依据 |
|---|---|---|
| pi-agent-core | `new Agent({...})` 做循环，管道是 `transformContext → convertToLlm → LLM`。钩子有 `beforeToolCall`、`afterToolCall`、`prepareRequest`、`finishTurn`，支持 `steer()` 和 `followUp()` 两种排队方式 | `packages/agent/README.md` |
| pi-coding-agent SDK | `createAgentSession()`、`SessionManager`（可放内存）、`AgentSessionRuntime`（new / switch / fork / importFromJsonl） | `docs/sdk.md` |
| Extension API | `pi.on`、`registerTool`、`registerCommand`、`registerProvider`、`registerMcpServer`、`registerVirtualModel`、`appendEntry`、`setActiveTools`。工具有 5 种 exposure：direct、model-only、codemode、deferred、hidden | `docs/extensions.md` |
| 事件（types.ts 里 40 个） | `resources_discover`、`project_trust`、`session_start`/`shutdown`/`tree`/`compact`/`compact_failed`/`info_changed`、`session_before_switch`/`fork`/`compact`/`tree`、`input`、`before_agent_start`、`agent_start`/`end`/`before_settle`/`settled`、`turn_start`/`end`、`message_start`/`update`/`end`、`context`、`context_with_system`、`before_provider_headers`/`request`、`after_provider_response`、`provider_stream_event`、`tool_call`、`tool_execution_start`/`update`/`end`、`tool_result`、`user_bash`、`model_select`、`thinking_level_select`、`mcp_servers_change`、`cache_warming_decision`、`ui_prompt_start`/`end` | `src/core/extensions/types.ts` |
| Skills 与 Prompt templates | Skills 遵循 agentskills.io 规范：`SKILL.md` 加 scripts、references，按需加载。模板是 `~/.pi/agent/prompts/*.md`，会变成 `/` 命令 | `docs/skills.md`、`docs/prompt-templates.md` |
| 会话文件 | JSONL 格式，v3 版本，用 id/parentId 组成树，路径是 `~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl` | `docs/session-format.md` |
| pi-durable | 标注 **Experimental，API 会无预告变化**。先持久化再显示，进程死了能续跑（存 SQLite），支持子 agent、child task、task graph、hooks（beforeRequest、afterResponse、onYield、afterTools、beforeTool、afterTool）。工具要声明 `replay:"safe"` 才会在崩溃后重跑，否则模型拿到 `interrupted` | `packages/durable/README.md` |
| pi-env | 通过 SSH 在远端起一个 Rust daemon。**连接断开 30 秒后，daemon 会杀掉它启动的所有进程** | `packages/env/docs/protocol.md` 的 Liveness 一节 |
| pi-telemetry | 只有 span 契约、内存实现和 conformance 测试，**没有 exporter** | telemetry README |
| evals | 不是通用评测框架，只比较"有文档"和"没文档"时 agent 表现的提升（docs lift） | `packages/evals/README.md` |
| mcp | 独立的 MCP client，支持 stdio 和 streamable HTTP、OAuth（RFC 9207、CIMD）、项目级覆盖。0.99.0 起内置 | `docs/mcp.md`、CHANGELOG |
| codemode | 模型写 JS，在 QuickJS 沙箱里并行调用其他工具，只有输出进上下文 | `docs/codemode.md` |
| chord | 和 Pi 无关的应用组合运行时，提供 facet、service、replicated state、RPC | chord README |
| server/client/protocol | 实验性的远程会话。worker 正在"从已删除的 AgentHarness 迁到 pi-durable" | `src/experimental/services/README.md` |

**官方推荐的二开路径**：写 extension，用 package 通过 npm 或 git 分发，不要 fork。CONTRIBUTING 写的是 "pi's core is minimal… If your feature does not belong in the core, it should be an extension"。新人提的 issue 和 PR 会被自动关闭，维护者回复 `lgtmi` 或 `lgtm` 之后才放行。仓库里有 80 个示例 extension，其中包括 subagent、plan-mode、sandbox、gondolin、git-checkpoint。npm 上带 `pi-package` 关键词的包有 **11,351 个**（2026-10-06 查询）。

### 1.2 9–10 月的方向（来自 CHANGELOG）

- 0.86.0（9-19）：prompt cache 保温（按成本决定）、按模型设置压缩预算、`/bug` 命令。
- 0.87.0（9-21）：新增 `ContextEditEntry`，可以改上下文而不重写历史；新增 `agent_before_settle` 这类可操作的边界。
- 0.99.0（9-29）：**内置 codemode 和 MCP**、virtual models、classifier 模型。
- 1.0.0（10-01）：默认全屏、codemode 的 token 少约 40%、MCP OAuth 加固。1.0.1–1.0.4 加了工具通配符、`--no-mcp`、项目级 MCP 覆盖。
- 另一条线是 pi-durable 加 server/client/env 的分布式化（全部 experimental），目前 durable 相关的 open issue 大多是 10 月新开的。

方向判断：核心在做"上下文和缓存的精细控制"和"工具编排（codemode/MCP）"；底层在为"可恢复、可远程"的 durable 运行时铺路。

### 1.3 用户在抱怨和要什么（2026-06 以后，按标题检索）

| 主题 | 代表 issue | 维护者态度 |
|---|---|---|
| 压缩 | 标题含 compaction 的有 156 条，例如 #8061（预算忽略了 maxTokens） | 持续在修 |
| 子 agent | 35 条。#7808 要一等公民的 spawn API，以 not planned 关闭；#10315、#10347 是 1.0.0 删掉 `./node` 导出后 pi-subagents 坏了；#8746 子 agent 导致 OOM 到 20GB | 交给社区包，核心不做 |
| 权限 | #8802 要 Codex 风格的权限档位，以 not planned 关闭 | README 写"没有内置权限系统，请容器化" |
| 回滚文件 | #5522 | badlogic（2026-06-09）："There are extensions for this… depends on your local setup" |
| worktree | #8272，以 not planned 关闭 | 交给包 |
| 中断后工具调用悬空 | #9986（Esc 中止后留下没有结果的工具调用）、#9124（dispose 后留下悬空调用）、#7053（并行批里一个卡住，其他已完成的结果也丢了），**都还 open** | 未处理 |
| durable 的空白 | #10386（durable 跑不了 coding-agent 的 extension，被**重新打开**）、#10549（没有挂钟时间戳）、#10411（等待环会死锁）、#10325 | 维护者自己也在开 #10395、#10455 |

讨论区里，第三方项目 pi-durabletask-mcp（#10447，10-04）明说："Interrupted tools may have unknown outcomes; their side effects aren't blindly replayed"。也就是说，**被中断的工具结果未知**这个问题社区承认存在，但还没人解决。

### 1.4 和 OpenClaw 的关系

OpenClaw 通过 Pi 的 SDK 把 Pi 当编码引擎，自己加上消息集成和个人助理层；Pi 的 README 也把 OpenClaw 列为真实集成案例。2026-04-08 Earendil 收购了 Pi，Zechner 成为股东，同时 Earendil 发布了云端 agent 平台 Lefos（[implicator.ai](https://www.implicator.ai/pi-is-not-a-claude-code-rival-it-is-a-harness-rebellion/)、[aiwiki](https://aiwiki.ai/wiki/pi_agent/raw)，**未打开原文核实**）。

---

## 2. 2026 年 9–10 月 harness 行业的真实进展

图例：● 表示 9-01 到 10-06 之间有相关发布；○ 表示已有这个能力但本期没有新发布；– 表示本期 changelog 里没看到（**不代表没有**）。

| 能力 | Claude Code | Codex CLI | Cursor | Hermes | Gemini CLI | Kimi Code | Factory | Antigravity | **Pi** |
|---|---|---|---|---|---|---|---|---|---|
| 子 agent / 并行 | ● Workflow 并发上限可配；teammates `agent.spawn`（2.1.289，10-03） | ● 子 agent 的环境和失败回传（0.160，10-01） | ● Projects coordinator 委派（9-10） | ● 运行中的子 agent 可以 steer（v0.21，8-31） | – | ● Tower 多 agent（9-04） | ● 子 agent 可停止（9-22） | – | 核心没有；durable 里有，但 experimental |
| 后台或长任务挺过重启 | ● 后台会话能挺过升级和低内存（2.1.290） | ● daemon；goal 在 daemon 重启后恢复（0.155，9-17）；重连不重复发送（0.160） | ● 云端跑，"合上电脑也不停" | ● cron 带记忆 | – | ● Remote Control 正式版（9-09） | ○ | ● 托管沙箱 agent | **主 CLI 没有**；durable 是实验性的；pi-env 断线就杀进程 |
| 权限、自动审批、沙箱 | ● auto mode，加上按命令放行的 `allowed_domains` | ● Guardian 自动审查；网络限制覆盖重定向（0.157） | ● Security Review | ● 写指令文件需要审批 | ● 沙箱隔离（0.60）；trust 失败即关闭（0.59） | ● Auto 模式危险命令拦截（9-02） | ● Droid Shield | ● 隔离 VM | **没有**（README 原文） |
| 云端或远程执行 | ● Remote、self-hosted runner | ● exec-server WebSocket 认证（0.158） | ● | ○ | – | ● | ○ | ● | 只有 SSH 方式的 pi-env，且是实验性 |
| 上下文压缩 | ● 按模型的 autocompact（2.1.288） | ○ | – | – | – | ● | ● `/compress`、`/handoff`（9-26） | ● 缓存 | ● 按模型预算、缓存保温 |
| worktree 并行 | ○ `/batch` | ● 默认开启（0.156，9-22） | – | – | – | – | – | – | 没有（#8272），靠包 |
| 计划模式 | ○ | ● resume 时恢复 Plan 模式（0.156） | ● coordinator 规划 | – | – | – | ● spec | ● | 没有（README 原文），只有示例 |
| fork、回滚 | ○ `/rewind` | ● fork（0.157） | – | – | ● 历史回滚（0.58） | – | ● fork（9-19） | – | 有会话树，**没有文件回滚** |
| MCP / ACP | ● MCP 2026-07-28 版的 URL elicitation | ● OAuth client secret（0.158） | – | ● MCP 指挥台 | ● OAuth SSRF 修复 | ● 插件市场 | ○ | – | ● 内置 MCP（0.99）；ACP 只有第三方 |
| 成本与组织管控 | ● 美元额度、缓存未命中原因、managed settings、gateway | ● `/usage` 看板 | ● Teams 版功能 | – | – | – | ● 组织级 skill 策略 | – | 有缓存保温；成本计算有 bug（#9980 open） |
| 扩展自身的评测 | ● `claude plugin eval` | – | – | – | – | – | – | – | 只有文档提升评测 |

OpenCode 本期主要是修复：ACP 会话恢复（1.18.31）和会话身份 header（1.18.34），没有放进表里。kimi-cli 在 9-21 归档，用户被迁到 Kimi Code。

- **已经是标配的**（至少 5 家本期有动作）：子 agent 并行、后台和长任务挺过重启、自动审批加沙箱、远程或云端执行、压缩。
- **分化点**：组织管控和 gateway（Claude Code 一家独大）、agent 之间直接对话（Hermes 的 bot-to-bot）、coordinator 加订阅触发（Cursor）、codemode（Pi 和 Codex）。

---

## 3. Pi 的缺口（按同行在意程度排序）

| # | 缺口 | 证据 | 一人两月、只用 API 能做吗 | 怎么证明做好了 | 风险 |
|---|---|---|---|---|---|
| **1** | **控制面和执行面生命周期绑在一起**：worker 崩溃或断网时，远程命令被杀，或者结果"未知" | pi-env 断开 30 秒就杀进程；durable 里不能安全重放的工具被打断后返回 `interrupted`；#9986、#9124、#7053 都还 open；#10447 承认"结果未知"。对手方面，Claude Code、Codex、Cursor 本期都在发"挺过重启"的能力 | **能**。实现一个 `ExecutionEnv`，再加一个可重放工具，代码量约 2–3k 行（估计） | 官方 `registerEnvConformance()` 套件全过；加上故障注入实验（见第 5 节） | durable 的 API 还会变；Earendil 的 Lefos 可能自己做云端执行 |
| 2 | durable 跑不了 extension（#10386） | issue 被重新打开；experimental 版 durable 的 README 里 extension 列在 "Not here" 下面 | 难。要和 AgentSession 的全部语义对齐，而维护者正在这块活跃开发 | 拿现有示例 extension 在 durable 上跑通 | 很容易和官方撞车，被他们的实现覆盖 |
| 3 | 权限和自动审批 | README 明说没有；#8802 被关 | 能 | 需要自建攻击集，看拦截率和误报率 | 包已经很多（如 @gotgenes/pi-permission-system），维护者立场是"去容器化"，同质化 |
| 4 | 一等公民的子 agent | #7808 被关 | 能 | 并发、取消语义测试 | 生态已经饱和（pi-subagents、@tintinweb/pi-subagents），durable 里也已经有 |
| 5 | 文件级回滚 | #5522 | 很容易 | 回滚一致性测试 | 小，已经有 pi-rewind |
| 6 | 跨会话记忆 | 只有包 | 能 | 很难给出可信指标 | 同质化 |
| 7 | OTel 导出 | telemetry 包没有 exporter；讨论 #10498 有人问 | 能 | 生成 span 树 | 属于基础设施，不符合你"不做纯基础设施"的要求；Langfuse 和 LangSmith 已有现成包 |

---

## 4. 和招聘方的匹配

**JD 和面经里反复出现的点**（"2026 秋招"在 JD 上标的是 2027 届）：

| 能力点 | 出处 |
|---|---|
| 任务编排、状态持久化、**断点恢复**、人在环 | 掘金 Harness 工程师综述（2026-08-03）；腾讯混元 "AI Agent Harness Engineer"（转引自掘金 07-28 观察帖） |
| 沙箱设计、权限校验、工具安全 | 同上；字节面经问过"工具调用安全（Key 泄露）"（kamacoder，2026-05-06） |
| 多 Agent 通信链路、**异常处理、超时、重试、降级** | 字节四面面经 |
| 多 Agent 并发的性能问题、怎么控并发；"怎么理解 Harness" | 小红书一面（牛客，2026-08-12） |
| 上下文管理、记忆、MCP、Skills、A2A；**可量化的评测体系** | 腾讯 2027 校招 Agent 开发（wondercv，截止 10-26） |
| 全链路评估和可观测、安全防护 | 拼多多 2027 校招（搜索摘要，**未核实**） |
| KV Cache、Tool Use、MCP、Memory | DeepSeek Agent Harness 研发（V2EX，05-20） |

**缺口 1 和上表的对应**：它直接对上"断点恢复、异常处理、超时重试、沙箱、可量化评测"五项。面试时能讲的内容：

- at-least-once 和 exactly-once 的边界在哪里；
- 用幂等键（durable 的 taskId）把一次工具调用变成"执行一次、可以观察多次"；
- lease 和心跳的设计，以及为什么 pi-env 选择断线就杀进程（为了不留孤儿进程），你又是怎么用沙箱 TTL 加 GC 来换这个取舍；
- 和 Claude Code 后台会话、Codex daemon 的对比。

**可能被质疑的点和应对**：

| 质疑 | 应对 |
|---|---|
| "这不就是 nohup 吗？" | 难点在三处：中止语义必须照样能杀进程；输出窗口和溢写行为要和官方实现一致（conformance 套件管这个）；重启后对账 |
| "Temporal 早就有了。" | 难点在 agent 特有的部分：结果要回填进模型上下文，还要处理并行工具批 |
| "沙箱外的副作用呢？" | 老实回答：做不到恰好一次，这类情况降级为 `interrupted`，并把它写进实验结果 |

---

## 5. 当时推荐的方案（仅供参考）
**做什么**：做一个 package，名字可以叫 `pi-env-modal`，包含两部分。

1. **`ModalExecutionEnv`**：实现 durable 的 `ExecutionEnv` 接口（FileSystem 加 Shell）。命令在 Modal 沙箱里以 detached 方式运行，pid、输出和退出码写进沙箱里的日志目录。Modal JS SDK 0.11.0（2026-09-29）里有 `Sandbox.fromId()`，worker 重启后可以重新连上同一个沙箱，这一点我已在它的 d.ts 里确认。
2. **可对账的 `bash` 工具**：声明为 `replay:"safe"`，用 taskId 当幂等键。崩溃后重放时，先查沙箱里的日志：命令还在跑就接上，跑完了就直接取结果，从来没启动过才真正执行。

接到 experimental 版 durable 编码 agent 的 `env` 工厂上；可选再参照 gondolin 示例给主 CLI 做一个 extension。

**第一个两周里程碑**：

| 时间 | 内容 |
|---|---|
| D1–3 | 跑通 experimental 版 durable agent；Modal 技术验证（从镜像建沙箱、exec、`fromId` 重连） |
| D4–8 | `ModalExecutionEnv` 通过 `registerEnvConformance()`，报告通过数 X/Y |
| D9–12 | 日志式 detached exec 加对账版 bash 工具 |
| D13–14 | 故障注入 v0：用 pi-ai 的 faux provider 让模型行为确定、不花 token；3 个场景各在 20 个随机时间点 kill；录一段演示：`make` 跑到一半 `kill -9` worker，再 `--continue`，结果正常回来，账本计数是 1 |

验收标准：conformance 全过；"长命令被打断"和"非幂等命令被打断"两个场景下，重复执行 0 次、`interrupted` 0 次。对照组用 durable 自带的 Node 或 Remote 执行环境，记录它们的这两项数字。

**完整评测**：

- **自建故障注入集，约 30 个场景，每个 20 次，共 600 次试验，使用 faux provider**。场景包括：长命令、非幂等写（账本文件或 git commit）、3–5 个命令的并行批（对应 #7053）、断网 10/45/120 秒（跨过 pi-env 的 30 秒阈值）、用户 Esc 中止（必须真的杀掉）、沙箱本身死掉（应该诚实降级）。
  - 指标：重复执行次数、未知结果数、浪费的计算秒数、恢复延迟 p50/p95、残留进程和沙箱数。
  - 成本：Modal 约 50 沙箱小时，约 $3–10（估计）。
- **TB 子集端到端**：挑 15 个含长时间构建的任务；三种条件（无故障、故障加基线、故障加本方案）各跑 3 次，共 135 次，模型用 GLM Flash。**不报通过率**，只报故障导致的分歧率、重复执行次数、墙钟和 token 的额外开销。
  - 成本：token 约 135–400M，按中转价约 ¥100–800（估计）；Modal 约 $10–30（估计）。
  - 注意：本地 Harbor 的 registry.json（2026-10-05）只列了 terminal-bench 2.0、Pro 和 sample，**TB 4.0 未核实**。另外 Harbor 的 Pi 适配是把 Pi 装进任务容器里跑，而本方案要求 agent 在沙箱外，所以要自己写 runner：从任务镜像起 Modal 沙箱，最后在沙箱里跑任务自带的 verifier，约 3–4 天（估计）。

**后续六周**：W3–4 做并行批、中止语义和孤儿 GC；W5–6 跑 TB 实验，并做主 CLI 的 extension；W7–8 写技术文章，带着数据开一个高质量 issue 争取拿到 `lgtm`，然后发布到 npm。

**最大的风险**：

1. **pi-durable 标着 experimental，API 会无预告变化**。应对：锁定 1.0.4 版本，适配层尽量薄。
2. Earendil 自己有 Lefos 云平台，**官方可能做出同类功能**。应对：就算撞车，你的 conformance 结果和故障数据仍然能拿来讲。
3. 节奏：腾讯 10-26 截止，**第一个里程碑必须在 10 月下旬前能演示**。

### 来源（访问日期都是 2026-10-06）

- Pi 源码和文档：[github.com/earendil-works/pi](https://github.com/earendil-works/pi)，HEAD ddaa0a0；本地克隆在 `/home/ubuntu/.claude/jobs/dfd4e9fe/tmp/pi`
- Pi 的 issue 和讨论：[#5522](https://github.com/earendil-works/pi/issues/5522)、[#7808](https://github.com/earendil-works/pi/issues/7808)、[#8802](https://github.com/earendil-works/pi/issues/8802)、[#8272](https://github.com/earendil-works/pi/issues/8272)、[#9986](https://github.com/earendil-works/pi/issues/9986)、[#9124](https://github.com/earendil-works/pi/issues/9124)、[#7053](https://github.com/earendil-works/pi/issues/7053)、[#10386](https://github.com/earendil-works/pi/issues/10386)、[#10315](https://github.com/earendil-works/pi/issues/10315)、[讨论 #10447](https://github.com/earendil-works/pi/discussions/10447)；RFC 列表见 [rfc.earendil.com](https://rfc.earendil.com/keyword/pi/)
- 其他产品：[Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)、[Codex releases](https://github.com/openai/codex/releases)、[OpenCode releases](https://github.com/anomalyco/opencode/releases)、[Hermes releases](https://github.com/NousResearch/hermes-agent/releases)、[Gemini CLI changelog](https://geminicli.com/docs/changelogs/)、[Kimi Code changelog](https://www.kimi.com/code/docs/en/kimi-code-cli/changelog)、[Cursor changelog](https://cursor.com/changelog)、[Factory（releasebot 汇总，二手来源）](https://releasebot.io/updates/factory-ai)、[Antigravity 09-2026](https://ai.google.dev/gemini-api/docs/models/antigravity-preview-09-2026)、[Harbor](https://github.com/harbor-framework/harbor)
- 招聘和面经：[掘金 08-03](https://juejin.cn/post/7669429987830611978)、[掘金 07-28](https://juejin.cn/post/7667140623372255242)、[腾讯 2027](https://www.wondercv.com/xiaozhao/tencent-2027-campus-ai-roles-13375-0c31fc/)、[DeepSeek](https://www.v2ex.com/t/1214141)、[字节面经](https://notes.kamacoder.com/interview/llm/20260506bytedance.html)、[小红书面经](https://www.nowcoder.com/discuss/919617105761165312)、[字节 2027（CSDN）](https://agent.csdn.net/6a84637a662f9a54cb9e459a.html)