# 内容审核相关开源项目盘点（2026-10-07，GitHub 星数当天实测）

## A. 完整审核平台 / 人审工作台
| 项目 | ★ | 说明 |
|---|---|---|
| bluesky-social/ozone | 542 | Bluesky 生产在用的审核工作台：举报分诊、升级、下架/封禁、打标签、申诉邮件模板、队列、快捷键；自动标注器（labeler，如 skywatch automod）以独立服务接入；TS，MIT/Apache 双许可；可自托管 |
| toolgood/ToolGood.TextFilter | 127 | C# 内容审核系统源码，已停更 |
| shug2k/content-review-tool | 8 | 队列 + 审核对象 + UI 的最小审核工具 |
| yuanyuekejiJN/LLM-Algorithm-Safety-Monitoring-Platform | 12 | 大模型备案场景的合规审查平台（敏感词库 + 云审核 + 日志） |

## B. 机审组件
| 项目 | ★ | 说明 |
|---|---|---|
| houbb/sensitive-word | 6,060 | Java DFA 敏感词，标签分级 |
| toolgood/ToolGood.Words | 5,191 | 敏感词 + 繁简/全半角/拼音/模糊 |
| NVIDIA/NeMo-Guardrails | 7,250 | 可编程护栏框架（Colang） |
| meta-llama/PurpleLlama | 4,422 | Llama Guard 等安全工具 |
| KOKOSde/localmod | 138 | 离线自托管审核 API（文本 + 图） |

## C. 开源护栏/审核模型
### 固定分类体系
| 模型 | 大小 | 模态 | 语言 | 许可 | 备注 |
|---|---|---|---|---|---|
| Qwen3Guard-Gen / -Stream | 0.6B/4B/8B | 文本 | 119 种 | Apache-2.0 | 三档 safe/controversial/unsafe；Stream 版 token 级实时；119 万标注样本（2025-09） |
| Llama Guard 4 | 12B | 文本 + 多图 | 多语 | Llama 许可 | S1–S14 固定分类 |
| ShieldGemma 2 | 4B | 图 | – | Gemma 许可 | 色情/暴力/危险三类 |
| Nemotron Safety Guard v3 | 8B | 文本 | 12 种 | – | 50 万样本 |
| SafeWatch | 8B | 视频 | – | – | – |
### 规则当输入（policy-as-input，2025-09 → 2026-09 新品类）
| 模型 | 大小 | 模态 | 备注 |
|---|---|---|---|
| gpt-oss-safeguard | 20B / 120B | 文本 | OpenAI，Apache-2.0，推理模型，策略在推理时给，输出结论 + 推理 |
| DynaGuard | 1.7B–8B（Qwen3） | 文本 | ICLR 2026；DynaBench 4 万条策略；快速模式 + 思维链模式 |
| AdaGuard | 0.6B/4B/8B | 文本 | 2026-09-28；每次 1–100 条规则；AdaptiveSafety 89.3%、DynaBench 71.8%（4B） |
| SingGuard（蚂蚁 inclusionAI） | – | 文本/图/视频/对话 | 2026；SingGuard-Bench 5.6 万例、80+ 风险类型；**中文团队、多模态、规则当输入** |
| SafeGuard-VL | – | 图 | 2026，规则当输入 |
### 决策模型（System One）路线
| 项目 | 说明 |
|---|---|
| Laya 审核预设、Clef、OneJev | 见判官报告 |
| OpenDecisions/OpenDecisions | 一个服务端同时提供 Decisions API 和 /v1/systemone，跑 OneJev 0.8B–27B（文本/图/视频），llama.cpp CPU 可用，可回退到 Jev；Apache-2.0 |
| fffffiii/jev-policylite | Qwen3.5-0.8B 多模态审核：共享编码器 + 违规头/属性头/策略头（block/review/allow），冻结主干只对策略头做 DPO 吸收人工纠正；校准后 93.5% 准确率、FPR 6.2%，3090 上 18.9 图/秒；MIT |

## D. agent 形态的审核项目（和我们最接近）
| 项目 | ★ | 说明 |
|---|---|---|
| zengzifan1/multi-agent-moderation | 81 | 中文；质量 agent（相似度/重复）+ 合规 agent（规则匹配 + 语义判别 + 证据引用）+ 复核 agent（复核载荷与修改建议）；输出 允许/拒绝/人工复核，带规则版本号、知识库版本号、触发规则计数；YAML 配置；可选 LangGraph；MIT；5 次提交，无评测数字 |
| hirogoing/PolySafe | 27 | 中文；VLM（豆包）理解 → FAISS 检索策略 → 阈值处置（≥0.8 拦、≤0.3 过、其余复核）→ 人审回流；策略改动自动重建索引；FastAPI + React；Apache-2.0；无评测数字 |
| waterfall132/DeepSeek_Bilibili_LiveManager | 10 | B 站直播弹幕实时抓取 + DeepSeek 审核 |
| brainstormity/Jev-Moderation-Bot、frolleks/soter、ban4life、jev-comment-triage | 3–46 | Jev 驱动的 Discord / WhatsApp / WordPress 审核机器人 |

## E. 中文审核评测与对比实验
| 资源 | 说明 |
|---|---|
| ChineseHarm-Bench（浙大 + 腾讯，zjunlp） | 6,000 条真实中文样本、6 类，**附人工标注的知识规则库**，用规则增强让小模型追平大模型 |
| COLD / ToxiCN / ToxiCN_MM / zh-decision-bench | 见前报告 |
| KsanaDock/verdict-lab | **已经在做我们计划的判官对比**：Jev vs Qwen3Guard-Gen-4B vs Llama Guard 4 vs DeepSeek，在 ChineseHarm-Bench + COLD + Aegis 共 1.3 万条；指标是每千条成本、自动化覆盖率 vs 人审率、p50/p95/p99、规则变更下的质量；M1 已跑完，结果在 HF，原始数据私有 |
| Alexander-Ollman/laya-ft | Jev vs 微调 Laya：67,890 次决策 27 组；审核微调后有害检出 F1 83.7% 但无害误报 47.2%，"只微调不够上线" |
| ant-research/awesome-mllm-guardrails | 蚂蚁维护的护栏/基准/攻击清单，2026 条目多 |

## 结论
1. **没有一个开源项目把四样东西合在一起**：规则当输入的快判层（判官或 policy-as-input 护栏）、agent 认知审核层（证据链、复核路由）、中文多模态、规则变更评测。零件都有，组合没有。
2. 最该站在肩膀上的：verdict-lab（判官对比的方法和数据选择）、ChineseHarm-Bench（带规则库的中文数据）、multi-agent-moderation 和 PolySafe（agent 层的现成结构，可以直接对照着做得更好）、Ozone（人审工作台，不用自己写）。
3. 最该警惕的：policy-as-input 护栏模型是 2025-09 到 2026-09 的热点品类（OpenAI、ICLR、蚂蚁都有），"规则是输入不是权重"不再是新观点，新东西只能是"在 Pi 的 agent 里怎么用它、怎么量"。
4. 中文 agent 审核项目只有 81★ 和 27★，说明这块还没人做出代表作，也说明关注度有限。
