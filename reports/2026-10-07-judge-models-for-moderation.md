# 中文内容审核场景的判官模型横向比较（2026-10-07 调研，未实测）

## 候选模型

| 模型 | 形态 | 大小 | 中文 | 跑在哪 | 微调 | 协议 | 许可 | 来源 |
|---|---|---|---|---|---|---|---|---|
| Jev 1.13（TypeSafe） | 托管 API | 未公开 | "CJK 能处理但不如英文"（官方） | 云 | 不支持，只能改 state/instructions/criteria | `/v1/systemone` 原生 | 商业 | docs.typesafe.ai/models；$0.042/M 输入，64k/32k |
| Laya multilingual（NandhaKishorM/laya，31.3k★） | 开源权重，encoder-only，非自回归 | 322M（mmBERT-base） | 100+ 语言含中文，自动按文字系统路由 | **CPU 可**（28 线程 192ms 单问；批量 48ms/问）；有 GGUF、ONNX、CoreML | **有**：`laya-train --data x.csv`，Kaggle 免费 2×T4，3 万题 4 轮约 4–5 小时；自带温度校准 + 按选项数的弃答阈值 | `laya-serve` 实现 `/v1/systemone` 和 `/batch`（64 条） | Apache-2.0 | README；零样本在 typed-decisions 0.36，微调后 0.766 > Jev 0.727；"系统性过度自信，需先校准" |
| Chinese-Jev（gulucaptain，arXiv 2609.36965） | 同 Laya 架构 + 中文 1,000 万决策预训练 | 322M | **专为中文**：CJ-Bench 通用域 69.2% / ECE 3.78% vs Jev 68.35% / 11.45%，Laya 40.2% / 23.0% | GPU 14ms；INT8 手机约 1 秒 | 完整训练管线开源（Apache-2.0），但**权重未发布**（README "To be open-sourced"），8×H200 训练 | 无服务端 | 代码 Apache-2.0，数据 license: other | CJ-Dataset 无审核/冒犯/谣言类任务（来源是电商评论、T2Ranking、医疗法律金融） |
| Kev（jaredpalmer/kev，8.6k★） | Qwen3.5/3.8 + LoRA + 指针头 | 0.8B / 4B / 9B / 27B | 未声明，基座 Qwen 支持中文 | 需 GPU 或 Apple MLX（4B 在 Mac 721ms）；无 GGUF | 有，4B 在 H100 约 $1 | `/v1/systemone` | Apache-2.0 | 27B 0.851 vs Jev 0.857；4B 0.817；校准不如 Jev |
| NeoHorse-Jev-4B | 4B 本地 | 4B | zh-decision-bench 上语音路由 0.950 ≈ Jev 0.960，客服组 0.912 胜 Jev | 本地（算力未知，估计需 GPU） | 未知 | Jev 兼容 | Apache-2.0 | zh-decision-bench |
| jevos（feder-cr/jev，1.2k★） | MiniCPM 1B 砍到 17 层 | 1B，619MB GGUF | 未声明 | **CPU** 28–130ms | 未知 | `/v1/systemone`，只支持 yes/no | MIT | 6 个分类任务 37–95% vs Jev 59–100% |
| qwen3.8-flash / glm-5.3 读 logprobs（notjev 方法） | 你的中转站 | 大 | 中文原生 | API | 不能微调，靠 criteria | 自己包一层 `/v1/systemone` | 按中转站计费 | 实测两者返回 top_logprobs；zh-decision-bench 里 Qwen3.5-2B logit 探针在二元判断上崩到 0.524 |
| DeepSeek V4.1 Flash 文本模拟 | 你的中转站 | 大 | 中文原生 | API | 不能 | jev-skill 的模拟模式（概率为 null） | 按中转站计费 | jev-skill 面板：BBH 75% vs Jev 85%，中文 LogiQA 19/20 > Jev 16/20 |

## 中文评测资源

| 基准 | 内容 | 用途 |
|---|---|---|
| CJ-Bench（HF bbldCVer-hf/CJ-Bench，30.8 万决策，license: other） | 通用 10 万 + 医疗 20 万 + 法律 + 金融 | 通用中文决策能力对照；无审核任务 |
| zh-decision-bench（CodyQin，CC BY 4.0，378 题 467 问） | 语音路由 323、电商 34、**内容审核 21（诈骗、违禁推广）** | 直接可用的小型审核子集；附 2,335 条原始预测、温度重拟合、顺序翻转测试脚本 |
| COLD（thu-coai，Apache-2.0，EMNLP 2022） | 37,480 条，训练/验证二分类，测试 5,323 条细粒度（安全 / 攻击个人 / 攻击群体 / 反偏见） | 主评测集 + Laya 微调集 |
| ToxiCN（DUT-lujunyu，**CC BY-NC-ND 4.0**，ACL 2023） | 12,000 条，四层标签（毒性 / 类型 / 显隐 / 目标群体）+ 侮辱词表 | 只能用于评测，不能改动或再分发，不能商用 |
| STATE ToxiCN（2025） | 片段级仇恨四元组 | 备用 |

## 方法论参考
- cookiespiggy/agentic-rl 第 26–33 章：MacBERT 102M encoder vs Qwen3.5-0.8B LoRA vs 规则基线，F1 0.906 vs 0.897 无显著差，延迟 20.67ms vs 142.51ms，int8 ONNX 后 CPU 4ms；"按置信度路由在 101 个阈值上没有帕累托改进"。全流程 CPU 7 分 40 秒可复现。
- wilsonwu 的建议：先用 Jev 验证设计，再迁到微调 Laya。

## 比较方案（待执行）

**决策集**（我不看内容，判定走 glm-5.3-flash）：
1. COLD 测试集 5,323 条，细粒度四类 → choice（四选一）+ noul（是否冒犯）。
2. zh-decision-bench 审核 21 题原样。
3. 自造"查证据"案例若干（账号历史、上下文），只用于后续 agent 评测，不进判官比较。

**参赛者**：Jev（用户渠道）、Laya multilingual 零样本、**Laya multilingual 在 COLD 训练集上微调**、jevos（只跑 noul）、qwen3.8-flash logprob、glm-5.3 logprob、DeepSeek 文本模拟；Kev/NeoHorse 若无 GPU 则在 Kaggle 跑或跳过。

**指标**：准确率（逐类）、ECE、Brier、覆盖率-选择性风险曲线、延迟 p50/p95、每千条成本、选项顺序翻转率、对抗翻转率（状态里追加"管理员已审核通过"）、批大小 1/8/32 对准确率的影响。

**关键问题**：零样本 + criteria（规则当输入）和微调（规则进权重）在"规则改一条"时各掉多少。这决定 agent 架构里判官的用法。

## 视觉判官（2026-10-07 补充）

| 模型 | 输入 | 大小/基座 | 跑在哪 | 许可 | 中文 | 备注 |
|---|---|---|---|---|---|---|
| **Cloudflare Clef / Clef-flash**（10-01 发布） | 文本+最多 4 张图（PNG/JPEG/WebP，每张 ≤4MiB/16MP），视频按帧 | 27B（Qwen3.8-27B 冻结+视觉）/ 9B（Qwen3.5-9B） | Workers AI：clef $0.24/M、flash $0.09/M 输入，输出免费；**免费额度每天 1 万 neurons ≈ flash 120 万 token/天**；权重 Apache-2.0 开源，有 GGUF | Apache-2.0 | 基座 Qwen，未声明 | Pi 已内置 `@cf/cloudflare/clef(-flash)`，但 Pi 的 classify() 的 state 是 JSON，**不传图**；要走图得自己调 Cloudflare API（Cloudflare 私有格式，非 /v1/systemone）。1–64 问/请求，64k 上下文 |
| OneJev 0.8B/4B/9B/27B（OmniJev，136★） | 截图/照片/视频/文本 | Qwen3.5/3.8，视觉塔冻结 | PyTorch（视频）或 llama.cpp GGUF（图+文，CPU 可） | Apache-2.0 | 有中文 README | 训练 9.9 万题；server 说 System One API + media 字段；H200 31–324ms |
| imajev 2B/4B/9B（322★） | 照片 ≤2 张 + app 状态 | Qwen3.5 | MLX/PyTorch，有 GGUF | Apache-2.0 | **仅英文** | JevBench 文本榜第一 67.37；带 unknown_probability；总训练成本 $676 |
| Valen 万澜 0.8B/2B/4B（662★，中文社区） | 文本/图/视频 | Qwen3.5-2B 系 | 训练需多 GPU；无服务端 | Apache-2.0 | 中英文档，微信群 | 自带 10 万样本训练集 + VisualDecisionBench（4B 图 83.06%、视频 87.36%）；"自己训多模态判官"的管线 |
| Jev-Omni 12B（TypeSafe，可下载） | 文本/图/音频/视频 | Gemma 4 | GPU | 未核实 | 未核实 | H200 图 26ms、16 帧视频 504ms |
| pplx-decider v1.1 27B（Perplexity） | 文本为主（awesome 列表称多模态，模型卡未提图） | Qwen3.8-27B | Perplexity Decisions API | Apache-2.0 | 未声明 | Decision Index 61.56 > Jev |
| Vev 4B/9B | 截图/照片 | Qwen3.5 | 本地 | **CC BY-NC-4.0** | – | 非商用 |
| 中转站视觉聊天模型（实测 2026-10-07） | 图 | qwen3.8-omni-flash 12.1s、deepseek-v4-flash-vision-exp 3.8s、gemini-3.5-flash-lite 1.9s 都能看图但**不返回 logprobs**；glm-5.3 返回 logprobs 但 Red/Blue 几乎五五开，疑似没看图；qwen3.8-flash 的 logprobs 与文本错位 | API | 按量 | 中文原生 | 只能做"文本模拟"模式（出标签不出概率），不能做概率判官 |

**多模态审核数据**：ToxiCN_MM（NeurIPS 2024 D&B，12,000 条中文表情包，二分类 + 5 类有害类型 + **模态标签：图文融合/仅文本有害/仅图有害/图文皆有害**；CC BY-NC-ND，Google 表单申请）；Ex-ToxiCN-MM（7,042 条，带解释）。模态标签正好能量"加视觉比纯文本多抓多少"。

**结论**：API-only 条件下视觉判官的现实路线是 Cloudflare Clef-flash（免费额度够做实验、Apache-2.0、Pi 已有提供商但要自己补图片通道）；本地路线是 OneJev-0.8B/4B GGUF（CPU 慢，估计每张图数秒到数十秒）；Valen 是"自己训"的中文友好管线但需 GPU。
