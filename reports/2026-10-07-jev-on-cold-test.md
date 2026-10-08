# Jev 在 COLD 测试集上的原始表现（2026-10-07）

> **写法说明（2026-10-08 起统一）**：本文只记录做了什么、为什么这么做、测得的数字，以及考虑不够全面的地方。文中实验数字和看法均**仅供参考**（样本、设置、标注方式都有限），不作为结论；结论由审查方判断。日期按美国纽约时间（America/New_York）。

**做了什么**：把 COLD 测试集 5,323 条全部按快判的真实请求发给 Jev（3 个评论场景问题 + 打乱选项的确认副本，题面为 3cdcb21 冻结版，含规则定义），用 COLD 自带标签打分。**未校准**（原始概率），阈值是当前的拦截 ≥0.90、放行 <0.10。开发者没有看任何正文。脚本：`scripts/cold-to-jsonl.py` → `scripts/eval-cold.ts`（并发 64）→ `scripts/score-cold.py`；逐条结果在开发机 `data/cold-eval/test-run1.jsonl`（只有编号、标签、分数，没有正文）。

**运行**：5,323 条 45 秒跑完，失败 0；延迟 p50 443ms、p95 1,058ms；平均每条 1,369 入 / 282 出 token【实测】。

## 分数本身（辱骂题，原序与副本取均值）

| 指标 | 数值 |
|---|---|
| AUC | 0.860 |
| 最佳 F1（阈值 0.12） | 0.736（精确率 0.673，召回率 0.812） |
| 阈值 0.50 | 精确率 0.818，召回率 0.560 |
| 阈值 0.90（当前拦截线） | 精确率 0.919，召回率 0.254 |
| 校准误差 ECE（10 档） | 0.119 |

分数偏低（偏"不违规"）：Jev 给 0–0.1 分的 2,667 条里，实际 13% 是冒犯；给 0.1–0.2 分的 439 条里实际 39%；0.7 分以上才大致准。

## 快判三态（当时的规则版本，未校准）

| COLD 类别 | 条数 | 自动拦截 | 自动放行 | 疑似（进 agent） |
|---|---|---|---|---|
| 全部 | 5,323 | 11.0% | 48.3% | 40.7% |
| 安全（label 0） | 3,216 | 1.6% | 69.5% | 29.0% |
| 冒犯（label 1） | 2,107 | 25.3% | 16.1% | 58.6% |
| 其他安全 | 2,548 | 1.5% | 72.7% | 25.8% |
| 攻击个人 | 288 | 26.4% | 10.1% | 63.5% |
| 攻击群体 | 1,819 | 25.1% | 17.0% | 57.8% |
| 反偏见（安全） | 668 | 1.9% | 57.0% | 41.0% |

**更正（2026-10-08，dev plan §2.3）**：上表改由线上同一个策略入口算出（`scripts/decide.ts` → `policy.decide`，用这次运行当时的规则版本 `rules@172fd34d27d6`，即提交 fdbcdee 的 rules/ 与 config/scenes.yaml；所有答案的题目键都能对上）。原表由 `score-cold.py` 里的 Python 复写逻辑算出，与线上引擎不一致（外部审查指出：缺确认答案时会放行、没有营销拦截路径）。重算后差别在 0.1 个百分点以内，主要是少数营销拦截原来没算进去。原表数字作废：全部 10.9% / 48.3% / 40.8%，安全 1.5% / 69.5% / 29.1%，冒犯 25.2% / 16.1% / 58.7%，其他安全 1.3% / 72.7% / 25.9%，攻击群体 25.1% / 17.0% / 57.9%。疑似的 2,167 条在当前引擎下全部属于"进 agent"（这次运行没有缺答，也没有校准要求）。另外，COLD 测试集已经用于挑阈值和分析漏放，这里的数字属于公开基准探索，不是盲测（计划 E9）。

## 当时的看法（仅供参考）

- **最要紧的错误是"冒犯被自动放行"：16.1%（339 条）。**这是 Jev 两份答案都给了 <0.10 的冒犯内容，快判直接放行，agent 根本看不到。
- **误拦很少**：安全内容被自动拦截 1.5%，反偏见 1.9%。
- **疑似太多**：40.7% 进 agent（更正前写作 40.8%）。旧回放里 agent 能稳定处理的比例大约 5%，按这个比例 agent 接不住。
- 这些数字**只代表 COLD 这类内容**（种族 / 地区 / 性别话题上的冒犯，含隐性偏见），不代表一般人身辱骂；COLD 的"冒犯"标准和我们 ABUSE 规则的措辞也不完全一样。
- **未校准**。校准能让分数和实际频率对上（ECE 下降），但改变不了排序（AUC 不变）。漏放能不能降，取决于阈值怎么定，以及 Jev 判 0 分的那些冒犯到底是 Jev 错了还是标签口径不同。

## 漏放核查：盲测第二意见（glm-5.3-flash）

从 339 条漏放里随机抽 100 条，另加两组对照各 50 条：冒犯且被 Jev 拦下的、安全且被 Jev 放行的。三组打乱后交给 glm-5.3-flash（并发 16，单条约 2.2 秒），它看不到 COLD 标签，也不知道条目属于哪组。按两个定义各判一次：COLD 的"冒犯"定义，和本平台辱骂规则。开发者没有看正文。脚本：`scripts/sample-cold-leaks.py` → `scripts/check-cold-leaks.ts` → `scripts/summarize-cold-leaks.py`。成功 199 条，失败 1 条。

| 组 | 条数 | glm 认为冒犯（COLD 定义） | glm 认为违规（本平台规则） |
|---|---|---|---|
| 漏放：COLD 说冒犯，Jev 放行 | 99 | **36（36%）** | 36（36%） |
| 对照：COLD 说冒犯，Jev 拦截 | 50 | 49（98%） | 50（100%） |
| 对照：COLD 说安全，Jev 放行 | 50 | 7（14%） | 9（18%） |

读法：
- **对照组说明 glm 是个可用的第二意见**：明显冒犯它 98% 认同 COLD；安全内容它 86% 认同。
- **漏放里，第二模型（glm）认为不算冒犯的约三分之二，也判为冒犯的约三分之一。**glm 认为漏放的 99 条中 63 条不算冒犯，类型主要是中性讨论或陈述 36、反偏见 10、反讽 9；认为是冒犯的 36 条主要是群体攻击 24、贬低性刻板印象 15。
- 按这个比例粗估：被放行、且第二模型也判为冒犯的，约占 339 条的 36%（95% 区间大约 27%–46%），相当于 COLD 全部冒犯内容的约 6%（4%–7%）。这只是"第二模型也判冒犯的比例"，不能当作 COLD 标准下修正后的漏放率（更正措辞，2026-10-08，计划 E9）。
- **局限**：glm 和 Jev 都是大模型，可能有同样的偏差，两者一致不能证明 COLD 标错了。glm 一条都没说"拿不准"，所以没有按规则转给负责人的存疑项；但"COLD 与两个模型分歧"本身就是疑点，下面列了链接，供负责人抽看。

### 链接：glm 也认为是冒犯、但被 Jev 放行的 36 条

| # | COLD test.csv | COLD 细分 | glm 类型 | Jev 分数均值 |
|---|---|---|---|---|
| 1 | [第 74 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L74) | 攻击群体 | 贬低性刻板印象 | 0.02 |
| 2 | [第 367 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L367) | 攻击群体 | 群体攻击 | 0 |
| 3 | [第 402 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L402) | 攻击个人 | 贬低性刻板印象 | 0.07 |
| 4 | [第 405 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L405) | 攻击群体 | 群体攻击 | 0.065 |
| 5 | [第 550 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L550) | 攻击群体 | 贬低性刻板印象 | 0.055 |
| 6 | [第 589 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L589) | 攻击群体 | 群体攻击 | 0.09 |
| 7 | [第 656 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L656) | 攻击群体 | 贬低性刻板印象 | 0.01 |
| 8 | [第 894 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L894) | 攻击群体 | 贬低性刻板印象 | 0.03 |
| 9 | [第 955 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L955) | 攻击群体 | 群体攻击 | 0.09 |
| 10 | [第 998 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L998) | 攻击群体 | 群体攻击 | 0.035 |
| 11 | [第 1209 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L1209) | 攻击群体 | 直接辱骂 | 0.055 |
| 12 | [第 1581 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L1581) | 攻击群体 | 群体攻击 | 0.035 |
| 13 | [第 1713 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L1713) | 攻击群体 | 贬低性刻板印象 | 0.01 |
| 14 | [第 1863 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L1863) | 攻击个人 | 贬低性刻板印象 | 0.075 |
| 15 | [第 2114 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2114) | 攻击群体 | 贬低性刻板印象 | 0.065 |
| 16 | [第 2318 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2318) | 攻击群体 | 群体攻击 | 0.03 |
| 17 | [第 2507 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2507) | 攻击群体 | 群体攻击 | 0.01 |
| 18 | [第 2602 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2602) | 攻击群体 | 群体攻击 | 0.01 |
| 19 | [第 2652 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2652) | 攻击群体 | 贬低性刻板印象 | 0.085 |
| 20 | [第 2655 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2655) | 攻击群体 | 群体攻击 | 0.045 |
| 21 | [第 2661 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2661) | 攻击群体 | 群体攻击 | 0.065 |
| 22 | [第 2722 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2722) | 攻击群体 | 贬低性刻板印象 | 0.02 |
| 23 | [第 2811 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L2811) | 攻击个人 | 群体攻击 | 0.015 |
| 24 | [第 3218 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L3218) | 攻击群体 | 群体攻击 | 0.025 |
| 25 | [第 3234 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L3234) | 攻击个人 | 群体攻击 | 0 |
| 26 | [第 3393 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L3393) | 攻击群体 | 贬低性刻板印象 | 0.01 |
| 27 | [第 3537 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L3537) | 攻击个人 | 群体攻击 | 0.045 |
| 28 | [第 3568 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L3568) | 攻击群体 | 贬低性刻板印象 | 0.09 |
| 29 | [第 3625 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L3625) | 攻击群体 | 群体攻击 | 0.01 |
| 30 | [第 4061 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L4061) | 攻击群体 | 群体攻击 | 0.02 |
| 31 | [第 4248 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L4248) | 攻击群体 | 群体攻击 | 0.07 |
| 32 | [第 4401 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L4401) | 攻击群体 | 群体攻击 | 0.04 |
| 33 | [第 4472 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L4472) | 攻击群体 | 群体攻击 | 0.03 |
| 34 | [第 4756 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L4756) | 攻击群体 | 群体攻击 | 0.03 |
| 35 | [第 5061 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L5061) | 攻击群体 | 群体攻击 | 0.03 |
| 36 | [第 5065 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L5065) | 攻击群体 | 群体攻击 | 0.035 |

### 链接：glm 认为不冒犯的 63 条中按行号前 12 条（标准分歧的候选）

| # | COLD test.csv | COLD 细分 | glm 类型 | Jev 分数均值 |
|---|---|---|---|---|
| 1 | [第 11 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L11) | 攻击群体 | 中性讨论或陈述 | 0.035 |
| 2 | [第 18 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L18) | 攻击群体 | 中性讨论或陈述 | 0.025 |
| 3 | [第 185 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L185) | 攻击群体 | 中性讨论或陈述 | 0 |
| 4 | [第 256 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L256) | 攻击群体 | 中性讨论或陈述 | 0.01 |
| 5 | [第 458 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L458) | 攻击群体 | 反偏见 | 0.01 |
| 6 | [第 482 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L482) | 攻击群体 | 中性讨论或陈述 | 0 |
| 7 | [第 493 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L493) | 攻击群体 | 反偏见 | 0.015 |
| 8 | [第 590 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L590) | 攻击群体 | 中性讨论或陈述 | 0 |
| 9 | [第 610 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L610) | 攻击群体 | 反偏见 | 0.005 |
| 10 | [第 708 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L708) | 攻击群体 | 中性讨论或陈述 | 0.045 |
| 11 | [第 769 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L769) | 攻击群体 | 反讽或阴阳怪气 | 0.02 |
| 12 | [第 1131 行](https://github.com/thu-coai/COLDataset/blob/main/COLDataset/test.csv?plain=1#L1131) | 攻击群体 | 中性讨论或陈述 | 0 |

## 还没做

- 用 train/dev 拟合温度，在 test 上看 ECE 和三态的变化。
- 对照基线：同样题面换一个模型（或开源守卫模型）跑同一份数据，看 0.86 这个 AUC 算好还是差。
