# Pi × 判断层（Jev 及开源替代）调研（2026-10-06 实测）

> **写法说明（2026-10-08 起统一）**：本文只记录做了什么、为什么这么做、测得的数字，以及考虑不够全面的地方。文中实验数字和看法均**仅供参考**（样本、设置、标注方式都有限），不作为结论；结论由审查方判断。日期按美国纽约时间（America/New_York）。

## 背景
- TypeSafe Jev 于 2026-09-15 发布：决策专用模型，输入 JSON 状态 + 带类型的问题（choice / score / noul 即 yes-no），一次前向输出每个选项的概率，不生成文字。需要申请权限。
- 发布一周内约 30 个开源复刻；到 9-22 GitHub 上有 2,170 个公开 Jev 项目（arXiv 2609.30216《Jev in the Wild》）。
- Pi 0.99.0（9-29）起**内置分类器模型类型**：`ctx.modelRegistry.classify()`、codemode 里 `models.classify()`；内置 Jev（typesafe / openrouter / cloudflare / vercel / opencode-zen 的 `jev-1.13-free`）、Cloudflare Clef；llama.cpp 路由器上任何聊天模型都可当分类器（读下一个 token 的标签概率，`temperature` 软化），llama.cpp ≥0.6.0 原生支持决策模型 `/v1/systemone`（Julia-1、Laya、Kev、lev、OpenJev）。示例 `examples/extensions/jev-router.ts` 用 Jev 判断任务复杂度来路由虚拟模型。

## Pi 上的判断层项目（全部 9-16 以后创建）

| 项目 | ★ / 下载 | 决策点 | 判官 | 数据 |
|---|---|---|---|---|
| qybaihe/mu | 399 | 每轮 38 个决策点（输入分类、skill/工具披露、工具输出逐块准入、遗忘/压缩、记忆、工具风险/审批/注入、偏航/回退/完成判断、子 agent 路由等），全部记账 | Jev 或本地 Laya 322M | 目标感知裁剪：调过的目标省 40.2% 上下文、72 行必需信息零丢失；留出目标 46.4%、零丢失；完美判官上限 52.5%/46.5% |
| DevMortimer/pi-warden（+ pi-typesafe 1 万/月） | 161 / 9.4k 月 | 每次写入对项目规则、只拦难撤销动作、假 done、死循环 | Jev | 1,168 会话、419 次拦截、76% 假 done 变真测试；回放 18,075 次调用 |
| kunchenguid/compact-adviser | 197 | 该不该现在 /compact（单元是否收口、是否协调态） | Jev | 阈值随上下文占用从 0.90 放松到 0.50 |
| y0usaf/pi-jev | 157 | bash/write/edit 调用前的门 + 输出判官 + 模型可自问 | Jev | 四个判断一次请求约 300ms；默认影子模式 |
| jomatsu/pi-jev-auto-mode | 30 | 语义自动审批，判不了就拒 | Jev | – |
| harshwasan/pi-jev-sentinel | 12 | 工具调用/输出/回复：注入、审批、密钥、任务钉住 | Jev | – |
| HyunjunJeon/pi-quiet-ask | 12 | "安静决策层" | Jev | – |
| goodruizhan/pi-jev-control | 1 | 路由、门控、失败分类、重试、上下文过滤、skill 选择、压缩时机、评审门 | Jev | – |
| weiping/jev-pi | 1 | 权限门（硬规则在代码、模糊判断给 Jev）、输出阶梯、条件上下文、agent 路由 | Jev | – |
| pi.dev 其他：jev-use 5.1k/月、@pi-unipi/watchdog 4k/月（长工具调用看门狗）、pi-jev-guard 3.7k/月、pi-verdict 3.6k/月、@cr1ms0n/pi-subagent（Jev 路由子 agent） | | | Jev | – |

**共同点**：全部依赖 Jev 云端；没有一个用 Pi 内置的 llama.cpp 分类器或 API logprob 判官；除 mu 和 pi-warden 外都没有数字；没有人在真实任务上量过"加判官 vs 不加"的通过率/成本差，也没人比过"开源判官 vs Jev 在 harness 里"的差别。

## 开源替代（按你的条件：只有 API + 4 核开发机）

### 路线 A：走 API，用 logprob 读标签概率（notjev 方法）
- [9pings/notjev](https://github.com/9pings/notjev)（Apache-2.0）：选项标成 A/B/C，要求单 token 输出并开 `logprobs`，只保留字母质量后归一化；提供 `/v1/systemone` Jev 线协议；置信度 = 1 − H(p)/ln K。局限：最多 26 选项，K≥10 准确率明显下降。
- **中转站实测（2026-10-06）**：`qwen3.8-flash` 和 `glm-5.3` 返回 top-5 logprobs（例：Yes −0.0 / No −11.1；Yes −0.007 / No −5.02）；`deepseek-v4.1-flash` 和 `gpt-6.1-sol` 不返回 logprobs；`glm-5.3-flash` 这次调用返回非 JSON（待复查）。
- Pi 的 `llama-cpp-classify` 做法完全相同（状态放两遍、单 token 标签、读概率、temperature 软化）；扩展可注册自带 `classify` 实现的分类器模型条目（CHANGELOG 0.99.0）。

### 路线 B：本地 CPU 小模型，走 llama.cpp `/v1/systemone`（Pi 原生识别）
| 模型 | 大小 | 说明 |
|---|---|---|
| Laya | 0.4B（322M–421M） | 非自回归一次前向，多语言；mu 的本地判官；"简单谓词可靠，元判断弱" |
| Julia-1 | 0.1B | ggml-org 集合里最小 |
| jevos（feder-cr/jev，1.2k★，MIT） | 1B MiniCPM5，619MB GGUF | CPU 28–130ms；6 个分类任务 37–95% vs Jev 59–100%；缺失事实检测 AUROC 0.94 vs Jev 0.46 |
| Kev（Jared Palmer，Apache-2.0） | 0.8B/4B/9B，Qwen3.5 + LoRA + 指针头 | 362 题准确率与 Jev 差 2 个百分点内（93.9–98.3%），校准更差（0.125 vs 0.027），延迟 220ms vs 275ms，输入上限 384 token |
| JevK5（140★，Apache-2.0） | 2B/4B/9B | JevBench 62.04 |
| 其他 | lev 4B、Nimble 9B、Tev1 0.8B/4B（"$17 训练"）、Winnow（Gemma 4）、Strands Decider 2B（AWS）、GLiNER2.5-Decide（DeBERTa） | Ollama v0.35 原生支持决策模型 |

### 路线 C：免费托管
- OpenCode Zen `jev-1.13-free`（限时），Pi 内置提供商 `opencode`。

### 评测与校准
- JevBench（534 条决策，四轴几何平均）：Imajev-4B 67.4 > Plumb-4B 65.8 > decider-4b 64.1 > **Jev 1.13 63.3** > JevK5 62.0。
- open-alternative-jev（65★）：Qwen 27B 单前向 73.7%、ECE 0.020 vs Jev 72.7%、ECE 0.144（LocalLLaMA/typed-decisions 400 例）。
- JevAdvBench（arXiv 2609.31142）：812 题 + 9,744 攻击，追加一句观点就有 12.1% 翻转率。
- 目录：[awesome-decision-models](https://github.com/AnotiaWang/awesome-decision-models) 615★、[awesome-jev](https://github.com/yibie/awesome-jev) 2.2k★、jevoss / openkev（测任何说 Jev 协议的模型）。

## 当时的看法（仅供参考）
1. 判断层是 Pi 生态里最新、最空的一块：所有项目不到三周，全部绑 Jev 云端，几乎没有数字。
2. 不用 Jev 完全可行：Pi 原生支持 llama.cpp 决策模型；中转站上 qwen3.8-flash / glm-5.3 有 logprobs，可照 notjev 做 API 判官；开源 4B 级模型在 JevBench 上已经不输 Jev。
3. 没人回答的问题：在同一模型同一批任务上，加判断层（谁来判、判哪几个点、阈值多少）对通过率、成本、危险动作各有多大影响；开源判官替换 Jev 掉多少。这正是"机制 + 双闸门"形态。
