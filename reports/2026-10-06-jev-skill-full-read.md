# wuyoscar/jev-skill 全文精读（2026-10-06）

读了：README 全部 108 个用例、5 个 SKILL.md、references 下 22 个文件（community 证据账本 R01–R12/P01–P21/N01–N05、implementation-patterns 22 个模式、agent-recipes 28 条、human-recipes 28 条、intake 76 条、x-intake 29 条、pitfalls、calibration）、evals 全部结果、三份 update 日志。

## 一、它真正是什么

不是"Jev 包装器"，是一个**新原语的使用手册**：一个不生成文字、只对"有界的问题"给概率的函数。手册的核心句子：
- "Jev chooses, classifies and scores. Your agent supplies evidence and takes action."
- "Let semantics identify parts; let code compute."（语义负责辨认，代码负责计算）
- "Never turn generated text into selectors or coordinates."（永远不把生成的文字当选择器）
- "Confidence is not permission."（置信度不是权限）
- "Agreement is not accuracy."（一致不等于正确）

所以它展示的不是"判官能做 108 件事"，而是**一种编程模型**：代码拥有所有精确的东西（ID、哈希、算术、权限、时间），模型只回答一个个封闭的语义问题，每个回答带概率和 unknown 出口。

## 二、108 个用例背后的 22 个实现模式（这才是可迁移的东西）

| # | 模式 | 一句话 | 典型来源 |
|---|---|---|---|
| 1 | 选原文片段而不是生成值 | 解析器找候选 → 判官选 ID → 代码复制原值 | 官方 span extraction |
| 2 | "最佳匹配"和"有没有合适的"分开问 | Choice 排名 + 单独 Noul 问是否存在答案 | semantic find、skill 选择 |
| 3 | 不改写原文地恢复结构 | 判行连续性 → 代码成块 → 判块类型 | OCR/autoformat |
| 4 | 条件问题一起问，只消费命中的分支 | 一次请求问意图+目标+伴随问题，代码按意图取用 | 智能家居 fan-out |
| 5 | 语义辨认成分，代码算结果 | "下周五"→ 相对/绝对成分 → 日历代码算日期 | 日期、货币、单位 |
| 6 | 有界局部选择遍历层级/图 | 只给当前节点的邻居，判官选，代码控 beam 和终止 | 产品分类、代码导航、知识图 |
| 7 | 维度量一次，策略单独改 | 多个 Score 存成特征向量，用户改权重不重算 | killmyidea、HA 复合策略 |
| 8 | 判官答案当监督学习的特征 | 生成模型提问题 → 判官给数值特征 → CatBoost | 官方 autoresearch feature discovery；N02 记账 91% vs 直接判 40% |
| 9 | 结构校验之后加语义校验 | schema 过了再逐条 Noul 语义规则 | zod-jev、JevLint |
| 10 | 用独立证据核验生成的候选 | 便宜模型抽取 → 判官对照源文 → 有界修复 | 结构化抽取级联、引用核查 |
| 11 | 对现成建议排序而不是发明命令 | 历史/检索出候选 → 判官排 → 用户确认 | shell history、启动器、补全 |
| 12 | 观察变成可复用的语义状态 | 传感器观察 → 若干"情境"概率 → 多个确定性自动化消费 | Home Assistant situation layer |
| 13 | 人可编辑的类别和消费者 | 每类一个 Noul，YAML 里写阈值和动作 | 邮件分类器 |
| 14 | 用部分观察驱动交互 | 语音片段 + 新鲜 UI → 意图/目标/完整性 → 等/做/问 | 语音浏览器 |
| 15 | 用户定义的 rubric 标注转录 | 每个发言单元独立打分 → 时间线 | Jevmeter |
| 16 | 语义谓词放在普通数据操作旁边 | SQL 缩小行 → 判官谓词 → 代码过滤 | jevql、pg-jev |
| 17 | 世界设计 / 动作选择 / 呈现分离 | 作者设计世界 → 判官选合法动作 → 模拟器更新 → 渲染 | 鲸鱼城、游戏 |
| 18 | 改进动作接口，而不是更快的选择器 | 网站暴露 `search_catalog` 这种任务级动作 | **WindTunnel：WebMCP+Jev 49/49 题 vs DOM 25/49** |
| 19 | 资源压力改策略，不改判断 | 上下文越满阈值越松，但概率不造假 | compact-adviser |
| 20 | 偶尔定策略，频繁做局部动作 | 推理模型定子目标，判官在子目标下选合法动作，卡住就重规划 | Pac-Man、Tetris |
| 21 | 角色选择和表现风格分开 | 谁下一个说 / 用什么语气，各一个问题 | 多机器人播客 + TTS |
| 22 | 把自然语言任务编译成可编辑的问题集 | 生成模型起草 typed questions → 人审 → 判官批量答 | OpenRouter compile、prompt2jev |

## 三、生态规模（都是 9-15 之后三周内的事）

- 公开项目 2,170 个（arXiv 2609.30216，截至 9-22）；一人审过 287 个；至少 7 个 awesome 列表，其中中文的有 yzfly/awesome-jev-zh、LINUX DO 39 条、Datawhale 22 条、Chinese-Jev（1,000 万预训练样本）。
- 原语已被塞进：shell 管道（SemDecide）、Postgres（pg-jev 扩展 / jevql CLI）、schema 校验（zod-jev）、lint（JevLint）、电子表格、Home Assistant、启动器、剪贴板、React 组件选择（jev-ui 的 Branch/Rank/Gate）、编程语言控制流（Probably）、知识图导航（neo4jev）、监督学习特征、语义 grep、MCP 服务器（10 个命名工具）。
- 浏览器/桌面：browser-use/jev-ultrafast（判官选 DOM 动作，小模型打字）、Stagehand 把判官塞进 act/observe/extract 单个原语里、WindTunnel 基准、Codex CUA、iOS 模拟器、语音控制。
- 游戏/世界：Doom、Tetris、Mario（读模拟器 RAM，不是截图）、50 个并发 Subway Surfers、Minecraft、Slay the Spire 2、MuJoCo 火箭着陆、鲸鱼城（264 个片段 5 分钟）。
- 创作：MIDI 作曲（Jevthoven）、故事一致性传感器（SillyTavern）、像素选色、视频混剪、关卡生成。
- Agent 内部：pi-warden、Canny（确定性账本 + 判官建议）、winnow（可恢复的输出过滤）、fast-jev-compaction、jev-skill-gate、Jev Codex Router、JevRouter、hermes-jev-router、TokenTrim 的 agent 失败归因基准（6,257 条轨迹）。

## 四、正反证据账本（同行最在意的部分）

**正面（有数字）**
- LangChain（N01）：5 条冻结轨迹各判 100 次，500 次二元判断全部与人一致，方差低于 3 个 LLM 判官，0.44 秒。
- WindTunnel：WebMCP+Jev+Mercury 141/147 次尝试通过、49/49 题；DOM 配置 76/147、25/49。两者是不同的完整 harness，不是纯接口消融。
- N02：把"记账分类"拆成 12–14 个语义维度 + 拟合权重，91.05% vs 直接判 39.98%；词袋 NB 94.91%；叠加 96.95%。
- R11：本地 Qwen3.8 27B Q4 和 Jev 在 SemIf 144 题上准确率完全相同（96.53%），延迟 239ms vs 368ms。
- 本仓库自测：证据消融 20 对（更多证据只减少 unknown，不提高准确率）；20 个真实 PR 价值分类 20/20 一致；BBH 160 题 Jev 85%、DeepSeek 75%；置信 ≥0.9 的 100 题仍错 8 题。

**反面（有数字）**
- 本仓库 agent 配对实验：固定第 3/6/9 步问判官，12/12 → 10/12，成本翻倍、延迟翻倍。
- R02 pi-warden 作者回放 17,000 次调用：**"偏离任务就拦"表现差，被降级为建议**；"计划 vs 实际调用"更有用。
- Jev Tetris 作者：关键词基线赢 Jev，Jev 赢随机。
- N05：fast-jev-compaction 回放 277 次调用，Jev 和"永远输出 0"的桩压缩率几乎一样（87.7% vs 88.5%），都丢了 16 个后面要用的结果。原因是判官根本没拿到结果内容。
- N02 反例：同样的维度拆分法用在注入检测，硬负例误报从 1.5% 飙到 37.2%。
- N03 Parallel：Jev 重排 NDCG@10 0.7 可比，但主题分类和"是否需要新信息"都输给自家专用分类器，单条成本更高。
- willkelly E9：直接覆盖指令只骗到 1/200，**伪造"经理已决定"骗到 147/200**。
- pg-jev 作者：一次 40/80 行比 1–20 行差。
- 校准：[.9,1] 桶平均概率 0.98、实际准确率 0.89；中低置信桶不单调。
- "8 个路由器全部不如最好的单模型"（Agent-as-a-Router，摘要）。

**方法论资产**：冻结标签再调用、收据带哈希、Wilson 区间、"重复判是测稳定性不是测准确率"、判断缓存要带证据版本（dbt-assay 的两个失败：证据缺失被判成矛盾；新守卫没作用于旧缓存）。

## 五、对我们的启发（拓宽后的方向池）

把"判官"从"门控"改读为"**一种新的编程原语**"之后，Pi 上能做的事远不止路由：

| # | 方向 | 对应模式 | 一句话 | 证据状态 |
|---|---|---|---|---|
| A | 模型给自己编 System 1 | 22 + 96 + Pi codemode | agent 在 codemode 脚本里写 `if (await judge(...))`，把本该在上下文里慢想的几十个小判断外包给代码+判官 | Pi 的 codemode 已能 `models.classify()`；无人测过对 token/步数的影响 |
| B | 判断缓存与证据版本 | pitfalls §2 + dbt-assay | 项目规则合规、文件相关性等判断按（证据哈希, rubric 版本）缓存，跨会话复用 | 有失败案例可对照，无实现 |
| C | 决策账本 → 自校准 | calibration + laya-forge/stuntd | 每个决策点记录概率和事后结果，按点拟合阈值；harness 越用越准 | 校准协议现成，无人做在线版 |
| D | 改进动作接口 | 18 + SoL-Pi Action Fusion | 给 agent 任务级工具而不是 bash，判官在小动作空间里选 | WindTunnel 49/49 vs 25/49 是最强的单条证据 |
| E | 策略/战术分离的编码 agent | 20 + Blink 导航 | 大模型定子目标，判官在枚举出的候选（开哪个文件、跑哪个测试）里选 | Pac-Man/Tetris 是演示；代码场景无数据 |
| F | 判官驱动的大小模型路由 | 19 + jev-router 示例 | 上一轮推荐 | 有 17 道反差题可测 |
| G | 多 agent 交通管制 | 17/81 + pi-subagents | 子 agent 报告准入、谁下一个说、何时升级到人 | JD 高频；无标准任务集 |
| H | 把失败轨迹变成判官数据集 | P06 + 你的 213 条 GLM 失败 | 决定性步骤/错误类型标注 → 训练/评测本地判官 | TokenTrim 已有 6,257 条基准 |
| I | 世界模拟里的双速 agent | 17 + 20 | 鲸鱼城式：规划器造世界，判官走每步 | 最炫，离岗位最远 |
| J | 非编码的 Pi 个人 agent | 12/13/14 + pi-chat | 收件箱/日历/通知的有界决策 + 收据 | 用户曾否"烂大街"类 |

**仓库自己给的最重要提醒**：固定间隔问判官会变差；判官拿不到真正证据时等于随机；伪造权威一句话就能翻转。任何方向都必须先回答"证据从哪来、何时问、误报怎么算"。

## 六、补读：工具本身的功能清单（README 前 500 行 + skills 目录 + docs）

### 6.1 可运行的东西
| 组件 | 做什么 |
|---|---|
| `skills/jev/scripts/jev.py`（346 行，纯标准库） | `decide request.json`：校验请求 → 调 OpenRouter `/api/alpha/decisions` 或 TypeSafe `/v1/systemone` → 校验响应（问题 ID、类型、概率有限且在 [0,1]、总质量误差 ≤0.05）→ 按 `--min-probability 0.8 --min-margin 0.15` 给每题贴 selected / needs_review 状态。退出码 0 选定、2 需复核、1 错误。`--dry-run` 只离线校验。无重试、禁重定向、密钥只走环境变量、错误输出只含 error_kind/phase/http_status 不含原文。拒绝重复 JSON 字段和 NaN/1e999。`classify` 子命令按 `support-labels.json` 批量分类文本 |
| `jev-decide setup` | 只检查两个 key 是否存在，解释 A（真 Jev）/B（模拟）两条路 |
| 模式 B「模拟」 | 没 key 时由宿主 agent 或指定模型（如 DeepSeek）按同样 state/questions 作答，但必须标 `agent_simulation`/`model_simulation`、`jev_called:false`、概率为 null，不许编概率 |
| 12 个 JSON 模板（assets/） | checkpoint、completion、routing、context、batch-triage（两条记录六个问题）、rubric、semantic-rules、span-selection、document-block（块类型 + 条件伴随问题）、voice-style、browser-route、support-labels、prompt-to-jev |
| `prompt_to_jev.py` | 把一段自然语言 prompt 拆成 Choice/Noul/Score 三类问题 + 留在代码里的精确规则（金额>100 且 >30 天）+ 留给生成模型的写回复；附 6 个转换检查用例 |
| `jev-eval/scripts/prepare.py` | 把红队转录 JSONL 离线转成逐会话请求（outcome + evidence 两问），标签白名单隔离，不碰目标 |
| 安装/更新 | 全由 agent 执行：确认来源 commit、预检五个目标目录、`uv tool install`、`copytree` 拒绝覆盖、离线验证；v0.2.0 发布版是 11 个入口，main 是 5 个入口的预览 |
| 传输诊断 | 30 秒 socket 超时不是作业总时限；失败保留阶段信息；S20 原始超时后回放 0.32 秒成功 |

### 6.2 工作流方法（文档里反复强调的"怎么用才对"）
1. 决策契约六要素：决策是什么 / 证据单元与版本 / 问题类型 / 消费者 / unknown 出口 / 成功检查。
2. 问题设计：一题一事；Choice 是相对的（最佳候选），Noul 是绝对的（命题成不成立），两者要分开问；Score 每级要能独立成立，别写 ["0","1","2"]；永远留 none/unknown。
3. 状态要自给自足：Jev 不继承 agent 对话，必须把目标、规则、证据、决定性历史、候选含义、缺失项都放进 state；"够用的上下文，不是最大的上下文"。
4. 并行单元：同一状态多问题放一个请求（状态只发一次，问题互相看不见答案）；多记录分组并给稳定 ID；依赖步骤必须等新证据；CLI 没有调度器，并发由宿主做。
5. 投机扇出：可以提前把条件分支的问题一起问，代码只消费命中分支的答案。
6. 重复判断只测稳定性不测准确率；定预算和聚合规则再跑；不许"一直问到满意为止"。
7. 概率 ≠ 置信度 ≠ 分数 ≠ 权限 ≠ 成功；Noul 没有置信度字段；阈值不能跨任务/跨原语搬。
8. 缓存判断要按（证据版本，问题/rubric 版本，模型身份）做键；新守卫要作用于旧缓存的读路径。
9. 批量前先做 smoke test：约 30 条代表性样本、两臂同样上下文、先用假端点测代码、按 ID 配对、保留失败、报告 valid pairs / 一致率 / 逐类错误 / 成本，然后停下等授权。
10. 校准协议：冻结标签；报 NLL、Brier、可靠性分桶 + ECE；覆盖率 vs 选择性风险曲线；Wilson 95% 区间；换域/换模型后重新审计。置信度公式（适配器版）：choice_confidence = (max p − 1/K)/(1 − 1/K)。
11. 红队三种工作流：批量转录评审、多轮会话（continue/stop/review 由代码硬限）、多角色团队（协调者/设计者/执行者/Jev 分诊/独立审计，角色不混）。
12. 测误报不只测攻击：成对夹具（真风险 / 同词无害提及 / 引用 / 证据缺失 / 证据冲突）。

### 6.3 实验与数据集资产
- 已完成：BBH 160 题校准试点（Jev 85% vs DeepSeek 75%，≥0.9 桶错 8/100）；agent 配对 12 对（负结果）+ 4 对（正结果）；证据消融 20 对；真实 PR 20 条；24 条工单 smoke test（Jev 24/24，DeepSeek 23/24，$0.0011）；五模型面板 10 个数据集。
- 数据集菜单：BBH 四任务（已跑）；ComVE（CC BY-SA）、FalseQA（假前提）、AbstentionBench（该不该弃答，CC BY-NC）、弱智吧三个版本（GPT-4 答案，不是人工金标）。
- 弱智吧标注协议：四个独立轴（字面可答 / 假前提 / 双关 / 需澄清），两位中文标注者独立 + 仲裁，作为新标注试点发布。

### 6.4 API 事实
- OpenRouter：`POST /api/alpha/decisions`，模型 `typesafe/jev-1.13`，$0.042/M 输入，输出免费，上下文 32k。TypeSafe 直连：`jev-1.13.0`，64k 总 / 32k state。
- 响应：choice 返回 `choice + probabilities + confidence`；noul 只返回 P(yes)；score 返回概率加权的级别索引（0 起）+ legend。Choice 最多 255 个选项。
- 已知弱项（官方）：算术、计数、日期比较、复杂间接引用、长无关上下文、对抗引导；`P(x)` 不保证等于 `1 − P(not x)`。
