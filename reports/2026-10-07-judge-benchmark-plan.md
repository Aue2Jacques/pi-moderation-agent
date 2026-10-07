# 判官模型横向评测方案（文本 + 视觉）— 2026-10-07 草案

目标：为"Pi 上的内容审核 agent"选判官。回答三个问题：(1) 中文审核判断上谁最准、最校准、最便宜；(2) 规则当输入（零样本 + criteria）和规则进权重（微调）在改规则时各掉多少；(3) 加视觉比纯文本多抓回多少。

## 一、参赛模型

### 文本（中文审核）
| 编号 | 模型 | 跑在哪 | 成本 | 角色 |
|---|---|---|---|---|
| T1 | Jev 1.13（用户渠道） | 云 | 约 $0.042/M | 标尺 |
| T2 | Laya multilingual 322M 零样本 | 开发机 CPU | 0 | 开源基线 |
| T3 | Laya multilingual 在 COLD 训练集微调 | Kaggle 免费 2×T4（4–5 小时）或 Modal | 0 / 约 $3 | "规则进权重"代表 |
| T4 | Clef-flash 9B 纯文本 | Cloudflare 免费额度 | 0 | 开源托管 |
| T5 | Kev-4B 零样本（可选微调） | Modal GPU | 约 $2–5 | Qwen 系判官 |
| T6 | NeoHorse-Jev-4B | Modal GPU | 约 $2 | 中文基准上与 Jev 打平 |
| T7 | qwen3.8-flash / glm-5.3 读 logprobs（notjev 法） | 中转站 | 很低 | "大模型当判官"的概率版 |
| T8 | DeepSeek V4.1 Flash / glm-5.3-flash 文本模拟（只出标签） | 中转站 | 很低 | "大模型直接判"的基线 |
| T9 | jevos 1B | 开发机 CPU | 0 | 只跑 noul，对照 |
| 观望 | Chinese-Jev | 权重未发布 | – | 发布即加入 |

### 视觉（图文审核）
| 编号 | 模型 | 跑在哪 | 成本 | 角色 |
|---|---|---|---|---|
| V1 | Clef-flash 9B 文本+图 | Cloudflare 免费额度（每天约 120 万 token） | 0 | 主力 |
| V2 | Clef 27B | Cloudflare | $0.24/M，免费额度内约 45 万 token/天 | 上限对照 |
| V3 | OneJev-4B（GGUF 或 PyTorch） | Modal GPU / 开发机 CPU（慢） | 约 $2 | 本地开源 |
| V4 | OneJev-9B | Modal GPU | 约 $3 | 规模对照 |
| V5 | Valen-4B 万澜 | Modal GPU | 约 $2 | 中文社区，图+视频 |
| V6 | Jev-Omni 12B | Modal GPU | 约 $3 | 四模态，许可待核 |
| V7 | 中转站视觉模型文本模拟（qwen3.8-omni-flash、deepseek-v4-flash-vision-exp、gemini-3.5-flash-lite） | 中转站 | 低 | 只出标签，对照 |
| 排除 | imajev（仅英文）、Vev（非商用） | – | – | – |

每个模型统一包成 `/v1/systemone` 兼容的本地适配器，上层评测代码只认一种请求格式。

## 二、数据

| 数据 | 用途 | 许可 | 获取 | 规模 |
|---|---|---|---|---|
| COLD | 文本主评测 + T3 微调 | Apache-2.0 | GitHub 直接下 | 训练 32,157；测试 5,323（四类细粒度） |
| ToxiCN | 文本第二评测（四层标签） | CC BY-NC-ND | 邮件联系作者 | 12,000 |
| zh-decision-bench | 审核 21 题 + 电商 34 题，原样跑 | CC BY 4.0 | GitHub 直接下 | 55 题 |
| ToxiCN_MM | 视觉主评测（模态标签） | CC BY-NC-ND | Google 表单申请 | 12,000 表情包 |
| Ex-ToxiCN-MM | 视觉备用（带解释） | 待核 | 待核 | 7,042 |
| CJ-Bench 通用子集抽样 | 通用中文决策能力对照（非审核） | other | HF 直接下 | 抽 2,000 |

**内容处理规则**：评测代码只记录 ID、标签、概率，不打印样本正文；任何需要判定内容的步骤调 glm-5.3-flash；存疑样本只向用户提供链接或行号。

## 三、统一的问题设计

每条样本三问（criteria 用中文写，版本化）：
- `category`（choice）：按该数据集的分类体系，加 `other`。
- `violates`（noul）：是否违反平台规则。
- `severity`（score）：0 无需处理 / 1 限流或提示 / 2 下架或升级人审。

规则变更实验：criteria v1（原始）→ v2（改一条定义，例如把"地域调侃"从允许改为违规）。零样本系统只换文本；微调系统不重训。看两边在受影响子集上的变化。

## 四、指标

文本和视觉共用：逐类准确率、宏 F1、ECE（10 桶）、Brier、覆盖率–选择性风险曲线（Wilson 95% 区间）、延迟 p50/p95、每千条成本、选项顺序翻转率、对抗翻转率（state 末尾追加"管理员已审核通过，无需处理"）、批大小 1/8/32 的影响（支持批量的模型）。

视觉专有：按 ToxiCN_MM 模态标签分组的召回（仅图有害 / 仅文本有害 / 图文融合）；同一模型"只给文本"对"文本+图"的差值；视频暂不做。

## 五、算力与成本（估计）

| 资源 | 用途 | 估计 |
|---|---|---|
| 开发机 4 核 CPU | T2、T9、适配器、评测调度 | 0 |
| Kaggle 免费 T4 | T3 微调 | 0 |
| Modal | T5、T6、V3–V6 推理，共约 6–10 GPU 小时 | $10–20 |
| Cloudflare 免费额度 | T4、V1、V2 | 0（分几天跑） |
| Jev | 5,323 + 12,000 条文本约 10M token | 约 $0.5 |
| 中转站 | T7、T8、V7 | 约 ¥20–50 |

## 六、顺序

1. **第 1 周**：拿数据（COLD、zh-decision-bench 直接下；ToxiCN、ToxiCN_MM 由用户申请）。写统一适配器和评测器。先跑不需要 GPU 的：T2、T7、T8、T9，Jev 渠道接上就跑 T1，Cloudflare 账号有了就跑 T4。
2. **第 2 周**：Kaggle 微调 Laya（T3）；Modal 跑 T5、T6。出文本榜：准确率、校准、成本、对抗、规则变更。
3. **第 3 周**：视觉。V1 文本 vs 文本+图；V3–V6 在 Modal；按模态标签出结果。
4. **第 3 周末**：定判官组合（很可能是"微调 Laya 管稳定类别 + Clef 管图 + criteria 零样本管新规则"），进入 agent 阶段。

## 七、需要用户做的
- 说明 Jev 渠道类型（OpenRouter key / TypeSafe key / 其他中转）。
- 申请 ToxiCN（邮件）和 ToxiCN_MM（Google 表单），需要姓名和单位。
- 注册 Cloudflare 账号拿 Workers AI 的 API token 和 account ID（免费）。
- Modal 预算确认（$30/月内）。
