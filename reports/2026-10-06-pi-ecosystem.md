# Pi 二开生态汇总（2026-10-06 实测）

数据来源：GitHub API（star/语言/更新日期为 2026-10-06 当天实测）、各仓库 README、pi.dev 包目录、arXiv/博客原文。标"估计"的是推算。

## 规模

| 指标 | 数值 |
|---|---|
| pi.dev 包目录 | 5,538 个包（扩展/技能/主题/模板），按月下载量排序 |
| GitHub topic `pi-package` | 1,431 仓库 |
| GitHub topic `pi-extension` | 1,414 仓库 |
| 下载量最高的包 | pi-mcp-adapter 150 万/月、billion-context 65 万/月、pi-web-access 60 万/月、pi-subagents 58 万/月 |

## A. 研究级（有论文或有实测数据，同行最在意）

| 项目 | ★ | 做了什么 | 数据 |
|---|---|---|---|
| [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi)（NVIDIA+NTU+MIT，论文 2026-09-17） | 3,349 | 只用 Pi 公开 API 写的扩展：Action Fusion、ObservationPack、Evidence-Preserving Reducer、Online Context Compact。152 个想法分 6 族，双闸门筛选（能力不出容忍带 且 效率提升） | EdgeBench 51 题：token −44.7~49.0%，成本 −1/3，分数保住 ~94%；3,000+ 次运行；只在 GPT-5.6 Sol 上搜索，论文自认有过拟合风险 |
| [itayinbarr/little-coder](https://github.com/itayinbarr/little-coder) | 2,648 | Pi + 30 个扩展 + 30 个 skill + Python 评测 harness，专为小模型调。机制：写文件守卫（拒绝覆盖已存在文件）、思考预算 2,048 token 强制截断、工作区文档注入、工具卡片注入、畸形输出修复、循环检测 | Aider Polyglot 225 题，Qwen3.5-9B 本地量化：45.6% vs Aider 基线 19.1%；写守卫在 57% 的题里触发；Rust/Go 差（编译负担） |
| [DevMortimer/pi-warden](https://github.com/DevMortimer/pi-warden) | 161 | 护栏"引导而不打断"：每次写入检查项目规则、只拦难以撤销的动作、抓"假完成"（说 done 没跑测试）、抓死循环 | 作者 16 天真实使用：1,168 会话，拦下 419 个危险动作，76% 的假 done 变成真跑测试；回放 18,075 次调用，阈值 0.9 下只拦 0.1% |
| [frontier-harness-eval/eval](https://github.com/frontier-harness-eval/eval) | 295 | 同一模型（Kimi K3）、同 30 题（21 TB + 9 DeepSWE）、9 个 harness 12 种配置 | Pi：通过率 60.0%，$2.43/过题，中位 7m33s，成本效率第 2；同一题 Claude Code 381 轮 vs Pi 90 轮；总成本差 17.5 倍 |
| [arXiv 2609.00006](https://arxiv.org/abs/2609.00006) Harness Engineering 11 系统源码研究 | – | Pi 是 11 个被解剖的 harness 之一；29 个模式、18 条设计建议、90 行最小 harness | 约 400 万行代码 |

## B. 上下文 / 压缩 / 记忆

| 项目 | ★ 或下载 | 机制 |
|---|---|---|
| [billion-context](https://github.com/ranxianglei/billion-context) | 65 万/月 | 代理层做可逆的分层压缩，模型自己决定压什么；5 倍压缩，95–97% 前缀缓存命中；4.5 个月 174,327 次调用零溢出（作者自报） |
| [fitchmultz/pi-posthorse](https://github.com/fitchmultz/pi-posthorse) | 256 | "不做摘要的上下文换窗"：旧窗口整体移出，JSONL 全量保留，靠 notes 和按窗口的 history 工具找回 |
| [k0valik/pi-blackhole](https://github.com/k0valik/pi-blackhole) | 230 | 算法式结构压缩（零模型调用）+ 观察式记忆（Observer/Reflector/Dropper 三个后台 worker）；作者明说"不省钱，只在廉价 worker 上划算" |
| [nicobailon/pi-boomerang](https://github.com/nicobailon/pi-boomerang) | 306 | 自主任务做完后把整段轮次折叠成一份交接摘要 |
| [MasuRii/pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | 279 | bash 命令改写成 rtk 等价命令 + 工具输出多级压缩 |
| [kunchenguid/compact-adviser](https://github.com/kunchenguid/compact-adviser) | 197 | 用小判官判断"现在该不该 /compact"（任务是否收口、是否在协调态），阈值随上下文占用放松 |

## C. 判断层（小模型做路由决策）

| 项目 | ★ | 机制 |
|---|---|---|
| [qybaihe/mu](https://github.com/qybaihe/mu)（built on pi，中文 README） | 399 | 每轮 38 个决策点交给小判官（留什么上下文、命令安不安全、要不要告诉别的 agent、做完没），每个裁决带概率并记账 |
| [y0usaf/pi-jev](https://github.com/y0usaf/pi-jev) | 157 | 带类型的概率判官：bash/write/edit 调用前一次请求出四个判断（约 300ms），默认影子模式 |
| [pasky/pi-omplike-advisor](https://github.com/pasky/pi-omplike-advisor) | 111 | 一个只读的第二模型每轮审主 agent 的工作并插入建议，按严重度排队投递 |

## D. 执行形态（工具面重新设计）

| 项目 | ★ 或下载 | 机制 |
|---|---|---|
| [fabric-runtime/pi-fabric](https://github.com/fabric-runtime/pi-fabric) | 283 | 只给模型一个 `fabric_exec`：在 QuickJS/Python 沙箱里用代码组合核心工具、MCP、子 agent、actor；ARC-AGI-3 25 个环境 22.4 小时全通（$1,349） |
| [shift-labs-ai/pi-rlm](https://github.com/shift-labs-ai/pi-rlm) | 85 | 单一 `execute` 工具，持久 Bun 求值器，变量跨调用存活（RLM 思路） |
| [QuintinShaw/pi-dynamic-workflows](https://github.com/QuintinShaw/pi-dynamic-workflows) | 554 | 一次请求变成一段 JS 编排脚本：code-mode 子 agent、按任务路由模型、worktree 隔离、成本记账、可续跑日志 |
| [pi-background-tasks](https://github.com/ismailsaleekh/pi-background-tasks) | 10.9 万/月 | 后台 shell 任务，`--survive-reload` 可活过 Pi 重载，fsync/rename 落盘，完成后唤醒模型下一轮（注意：和"崩溃恢复"方案撞车） |

## E. 自主实验循环

| 项目 | ★ | 机制 |
|---|---|---|
| [davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) | 8,151 | Karpathy autoresearch 搬进 Pi：试想法、测、留好的、回滚坏的，任意优化目标 |
| [greyhaven-ai/autocontext](https://github.com/greyhaven-ai/autocontext)（Python） | 1,304 | 递归自改进 harness，Pi 可作执行后端；产出 playbook、数据集、训练产物 |
| [evo-hq/evo](https://github.com/evo-hq/evo)（Python） | 1,462 | 在 autoresearch 上加树搜索和并行子 agent |

## F. 多 agent（已饱和）

nicobailon/pi-subagents 3,862★、tintinweb/pi-subagents 1,254★、mvschwarz/openrig 5,393★（Claude Code/Codex/Pi 组队）、boadij/pi-herdsman 121★、[m-sec-org/BreachWeave](https://github.com/m-sec-org/BreachWeave) 678★（国内团队，基于 pi SDK 的渗透测试 Manager/Solver/Observer 架构，有比赛成绩）。

## G. 沙箱与安全（已饱和）

earendil-works/gondolin 2,237★（官方 micro-VM，主机侧策略控网络和密钥）、carderne/pi-sandbox 260★、nolabs-ai/nono、MasuRii/pi-permission-system 170★、@gotgenes/pi-permission-system（5.8 万/月）。

## H. 发行版与产品

oh-my-pi 34,450★（Stencil Labs 的 fork，8 万行 Rust 核心、LSP/DAP）、OpenClaw（用 Pi SDK 做编码引擎）、Gentleman-Programming/gentle-shell 1,209★、vastsa/PI-Desktop 6,412★、JetBrains/thinkrail 510★、mikeyobrien/rho 371★（常驻 + 跨会话记忆）、code-yeongyu/senpi 470★、earendil-works/pi-chat。

## I. 中文生态

SaladDay/pi-from-scratch 1,265★（600 行手写 nano-pi）、cellinlab/how-pi-agent-works 932★、ZhangHanDong/pi-book 336★、antinomie-lab/pi-book 426★、xiaomoBoy/pi-bluebook 301★、ranxi2001/zero2Agent 673★（**面向大厂 Agent 研发岗求职的教程，有 Pi 专章 + 807 道面试题**）、weijiafu14/pi2dsh 212★（Pi 扩展原样跑在 DeepSeek Harness 上）。

## 判断

1. 同行会停下来看的，全是"一个机制 + 一组数字"：SoL-Pi、little-coder、pi-warden、FrontierHarness。纯功能补充（子 agent、权限、沙箱、UI、通知）数量最多、最没人看。
2. 已被做满的方向：子 agent、压缩/记忆、权限/沙箱、桌面/Web 前端。
3. 相对空的方向：判断层只有 3 个项目且都很新（9 月）；"harness 在不同模型上的稳定性/配对"只有 FrontierHarness 一个数据点；SoL-Pi 自己承认只在一个模型上搜过。
