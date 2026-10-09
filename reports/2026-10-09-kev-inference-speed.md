# Kev-4B 推理提速：逐项测量与 kevfast 封装（2026-10-09）

负责人 2026-10-09 要求先把开源判官 Kev-4B 的推理速度提上去（准确率暂不管），并逐项统计每一步优化了什么。数字仅供参考，都是单次运行。

## 1. 环境与口径

| 项 | 内容 |
|---|---|
| 机器 | RTX 5060 Ti 16 GB（SM 12.0），torch 2.8.0+cu128，flash-linear-attention 0.5.2 |
| 模型 | 微调 v1（`/hy-tmp/train/runs/kev4b-v1`，只在算力服务器），bf16，LoRA 已合并，Kev 自带融合算子（`kev/fused_qwen35.py`） |
| 题目 | 评论场景的 3 题（辱骂、营销、注入防护）+ 各自打乱选项的复问，共 6 题，与 `eval-test.ts` 发出的相同 |
| 文本 | 测试集前 512 条（`text` 视图） |

## 2. 先测清楚的事实

**每条请求的组成（实测）**：Kev 原格式下，每条请求的中位数为 535 个 token；评论本身平均 26 个（中位数 18，p90 60），其余是规则原文和选项。Kev 的格式是"状态（评论）在前，每题一个分支在后"，分支之间互不可见，分支带着完整的规则原文。所以每条评论都要把所有规则重算一遍。Kev 的前缀缓存只在"状态完全相同"时命中。

**显卡上限（实测）**：bf16 矩阵乘法 51 TFLOPS（与推理同形状的 41–51），FP8 103 TFLOPS。

**一次推理的时间分布**（规则前置格式，一批 16 条，2,891 个 token，各模块前后同步计时；容器里没有 CUPTI 权限，用不了 torch.profiler）：

| 模块 | 占比 |
|---|---|
| MLP（32 层） | 50.5% |
| Gated DeltaNet 线性注意力（24 层） | 32.5% |
| 普通注意力（8 层） | 11.3% |
| 其他 | 5.7% |

**并发上不去的原因**（kev.serve，原格式，500 条，只有辱骂和营销两题 + 复问）：

| 并发 | 每秒条数 |
|---|---|
| 1 | 6.4 |
| 16 | 8.0 |
| 64 | 8.7–11.7 |

单条耗时从并发 1 时的 125 ms，涨到并发 64 时的 5.4–7.3 s。显卡此时已经满载。

服务端显存设置调过两次：开 `expandable_segments` 每秒 8.2 条；关前缀缓存那组没测完，提速转向逐项优化后就停了。默认设置下，v0 评测时 7 次 CUDA graphs 捕获全部因显存不足失败，后来几次服务启动是 0 次失败。

## 3. 逐项测量（`scripts/gpu/kev_speed_bench.py`）

速度测法：规则原文只算一次，作为缓存前缀（294 个 token）；每条评论一行，接在前缀后面，行内是"评论 + 题目分支"。各阶段都是 eager 模式（不开 CUDA graphs），每批 32 条，另测一条一条发时的单条耗时。

漂移测法：用训练过的原格式答 200 条（1,200 道题），和 S0 的 bf16 答案比较。

| 阶段 | 改了什么 | 每秒条数（批 32） | 相对上一阶段 | 单条 p50 | 每条 token（中位数） | 补齐浪费 | 答案漂移（vs bf16） |
|---|---|---|---|---|---|---|---|
| 参照 A | Kev 原格式，eager，一条一条 | 4.8 | — | 209 ms | 535 | — | — |
| 参照 B | Kev 原格式，kev.serve（CUDA graphs），4 题，并发 64 | 11.7 | — | 125 ms（并发 1） | — | — | — |
| S0 | 规则前置：规则只算一次缓存起来，评论只算一次；分支仍带"按上面的规则 X 判断这条内容"和三个选项 | 21.1 | — | 88–96 ms | 182 | 27.2% | 参照 |
| S1 | + FP8 矩阵乘法（权重按行、激活按 token 动态缩放，`torch._scaled_mm`） | 27.8 | +32% | 130–138 ms | 182 | 27.2% | 平均 \|dp\| 0.0024，最大 0.118，首选变化 2 / 1,200 |
| S2 | + 按长度分批（先排序再分批，少补齐） | 38.5 | +38% | 130 ms | 182 | 3.8% | 同 S1（只改分批） |
| S3 | + 分支只留一行：规则原文只在缓存前缀里，选项写成"是 / 否 / 不确定" | 66.7 | +73% | 131 ms | 100 | 6.5% | 需重新训练，未测 |
| S4 | + 去掉复问（6 题 → 3 题） | 92.5 | +39% | 130 ms | 67 | 9.1% | 需重新训练，未测 |

每秒处理的 token：S0 是 4,037，S2–S4 是 7,049–7,366。

以批量吞吐看，S4 是 S0 的 4.4 倍，是参照 B 的 7.9 倍。参照 B 只问两题 + 复问；线上实际是三题 + 复问，评测时测得每秒约 8 条，按这个算是 11.6 倍。

## 4. 没做或没做成的

1. **单条耗时被 FP8 拖慢**：88–96 ms → 130 ms。一条一条发时矩阵很小，激活量化的额外算子和 `_scaled_mm` 的固定开销超过了收益。没有按批大小切换 bf16 / FP8，也没有把激活量化融合进前一个算子。
2. **CUDA graphs**：各阶段都是 eager。参照 A 和参照 B 的单条差（209 → 125 ms）里有 CUDA graphs 的作用，但两者的服务路径和题数不同，不能单独归因。FP8 和新格式还没接进 kev.serve 的 graphs 路径。
3. **线性注意力换算子**：vLLM 用的 FlashInfer Blackwell GDN 预填充算子（flashinfer PR #3001）只支持 SM100/SM100A + CUDA 13。这张卡是 SM120，torch 用的是 cu128，所以没试。
4. **准确率**：S1 只测了相对 bf16 的漂移，没在测试集上重算 AUROC 和分流；S3、S4 改了输入格式，要按新格式重新训练后才能评测。另外，按新格式（规则前置）导出训练数据时，Kev 训练的状态上限是 384 token，规则 294 token 加上评论后，12,693 条里有 758 条超长会被丢掉（训练于 10-09 启动后按负责人要求停止）。
5. **S0–S4 的"一行"**：评论和所有题目分支在同一行里，后面的分支能看到前面的分支。Kev 原本的分支互不可见。速度上的计算量相同，但这不是能直接用的格式。正式实现需要分支之间的注意力隔离（块因果掩码），或者让 Kev 的缓存支持"规则前缀 + 评论续算"再分支。
6. **vLLM / SGLang**：没换。有报告称 vLLM 里 Qwen3.5-4B 的前缀缓存块是 528 token，短于此的前缀命中率为 0。我们的规则前缀是 294 token。另外 Kev 的指针头需要自行移植。

## 5. kevfast：可开关的推理引擎（`python/kevfast/`）

负责人 10-09 要求："先不管准确率……把优化到极致的情况先封装好，先修复你目前的问题，然后把每一个优化的功能封装成一个可以开关的选项"。第 3 节的原型有两个问题：各题在同一行里能互相看见；FP8 让单条变慢。kevfast 是重写的推理路径，用同一个 Kev checkpoint。

**怎么算**：每次计算把一批 token 段首尾拼接（不补齐），段分三层：

| 层 | 内容 |
|---|---|
| 前缀 | 规则块，可选，跨请求缓存 |
| 内容 | 每条请求一段 |
| 分支 | 每道题一段 |

- DeltaNet 层把父段的最终状态作为子段的初始状态，用的是 fla 的 varlen 算子，传入每段的初始状态。
- 注意力层每段只读祖先段和自己（因果）。所有段共有的前缀，在批量小时随段一起取出、走融合 SDPA；批量大时单独算一次，再按 log-sum-exp 精确合并。
- 分支之间互不可见，与 Kev 一致。

**开关**（`Options`，服务端用 `KF_*` 环境变量；`/v1/models` 会报告当前开关，评测可据此记录）：

| 开关 | 取值 | 作用 | 改变模型读到的输入？ |
|---|---|---|---|
| layout | native / rules_first | rules_first：状态以 `rules` 字段开头时，规则块作缓存前缀 | 是（需按该格式训练） |
| questions | full / short | short：分支只有规则名和短选项 | 是 |
| confirm | on / off | off：不算 `#confirm` 复问 | 少答一半题 |
| fp8 | off / on / auto | FP8 矩阵乘法；auto 只在一次计算 ≥ fp8_min_tokens 时用（同时保留 bf16 与 FP8 两份权重） | 只改舍入 |
| branch_mode | two_pass / rows / auto | rows：一次计算，每道题一行"评论 + 分支"；two_pass：先算评论，分支接着它的状态算；auto：≤ 4 条请求用 rows | 否 |
| cuda_graphs | on / off | rows 调用按 16 token 分档右补齐，每个（行数，档位）录制一次 CUDA graph 后重放；服务端遇到新题目组合时预录 | 否 |
| max_pass_tokens 等 | 数值 | 每次计算的 token 预算（16 GB 卡上约 14k 分支 token 时显存不足）、图的大小上限 | 否 |

**一致性检查**（`python -m kevfast.check_parity`，96 条文本，和 Kev 自己的 bf16 计算比）：

| 检查 | 题数 | 最大 \|dp\| | 平均 \|dp\| | 首选变化 |
|---|---|---|---|---|
| native，two_pass | 576 | 0.0166 | 0.00044 | 0 |
| rules_first，two_pass（和 Kev 对同一串 token 的计算比） | 576 | 0.0254 | 0.00059 | 0 |
| native，rows | 576 | 0.0116 | 0.00039 | 1 |
| rules_first，rows | 576 | 0.0161 | 0.00056 | 0 |
| rules_first，rows，单条 + CUDA graphs | 96 | 0.0109 | 0.00038 | 0 |
| native，fp8=on（对 bf16） | 576 | 0.0892 | 0.00213 | 2 |

**提速阶梯**（`python -m kevfast.bench`，512 条测试文本；吞吐为每批 32 条，单条为一次一条、64 条；单条在 E6 前先预录图）：

| 阶段 | 每秒条数 | 单条 p50 | 单条 p95 | 显存峰值 |
|---|---|---|---|---|
| E0 原格式、全题 + 复问、bf16（Kev 的计算，拼接不补齐） | 9.4 | 206 ms | 231 ms | 10.6 GB |
| E1 + rules_first | 17.7 | 215 ms | 240 ms | 12.3 GB |
| E2 + short 问题 | 27.1 | 205 ms | 212 ms | 13.0 GB |
| E3 + 去复问 | 42.3 | 203 ms | 222 ms | 11.4 GB |
| E4 + fp8 auto | 55.4 | 203 ms | 210 ms | 14.8 GB |
| E5 + branch_mode auto | 55.5 | 104 ms | 118 ms | 14.8 GB |
| E6 + CUDA graphs，fp8 改为 on | 55.3 | 37.8 ms | 51.8 ms | 11.5 GB |

E6 用 fp8=on 是因为：fp8=auto 时同时保留两份权重，再预录图会在 16 GB 卡上显存不足（实测一次 OOM）。

**单条耗时拆解**（rules_first + short + 去复问 + fp8 auto，单条，各段同步计时）：两次计算各约 100 ms，分别只算 33 个和 54 个 token。主要开销是每层的算子启动：每次计算约 600 次调用。rows 模式合成一次计算后约 105 ms，加 CUDA graphs 后约 38–48 ms。批量 32 条时，带同步计时的矩阵乘法约 290 ms（2,784 个 token）。

**服务端端到端**（`python -m kevfast.serve`，原格式 + 全题 + 复问 + fp8=on + 自动分支 + CUDA graphs，`eval-test.ts collect` 并发 32，完整测试集）：

| 判官 | 请求 | 用时 | 辱骂 AUROC | 营销 AUROC | 注入 AUROC |
|---|---|---|---|---|---|
| Kev 原服务（v1，第 5 节前的评测） | 3,002 / 0 失败 | 约 6 分钟 | 0.9644 | 0.9987 | 0.9961 |
| kevfast（同一 checkpoint） | 3,002 / 0 失败 | 282 s | 0.9643 | 0.9986 | 0.9957 |

第一次端到端运行时 3,002 条全部返回 422：`serve.py` 用了 `from __future__ import annotations`，FastAPI 认不出局部导入的请求类型。去掉后重跑。失败的那次输出移到 `/hy-tmp/train/void-kevfast-422`。

**还没做**：
1. rules_first / short / 去复问的准确率：要按新格式训练。规则前置时 Kev 训练的状态上限（384 token）会丢 758 条，见第 4 节第 4 条。
2. 批量路径（two_pass）没有 CUDA graphs，分支那次计算仍偏慢：一批 32 条时 303 ms，内容那次 171 ms。
3. 去掉复问后，快判的"复问一致"检查（`confirmsCallId`）就没有了，策略层怎么处理没改。
4. 单元测试：kevfast 只能在 GPU 上跑，没进 CI；一致性检查和 bench 是在算力服务器上手动跑的。

## 复现

```bash
# kevfast（算力服务器，kev 环境，PYTHONPATH 指向仓库的 python/）
PYTHONPATH=python python -m kevfast.check_parity <run> <wire6.json> <texts.jsonl> 96 --fp8
PYTHONPATH=python python -m kevfast.bench <run> <wire6.json> <texts.jsonl> 512
KF_LAYOUT=native KF_FP8=on PYTHONPATH=python python -m kevfast.serve --run <run> --port 8010   # 再用 JEV_BASE_URL=http://127.0.0.1:8010/v1 跑 eval-test.ts
# 第 3 节的原型：wire6.json = 评论场景 6 题（buildQuestions(..., true) 的输出）
cd /hy-tmp/work/kev && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True .venv/bin/python /hy-tmp/pma/scripts/gpu/kev_speed_bench.py \
  /hy-tmp/train/runs/kev4b-v1 /hy-tmp/train/wire6.json /hy-tmp/pma/data/eval/test-v1-kev4b-v1/requests-text.jsonl /hy-tmp/pma/data/eval/eval20k.jsonl
```
