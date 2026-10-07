# 项目可行性审查：内容审核 Agent / Harness 工程项目

## 结论

**这个项目值得做，方向是对的。**以“2026 秋招 Agent / Harness 开发工程师”的个人项目来衡量，我给当前方案的主观评分是：

| 维度 | 我的评价 | 原因 |
|---|---:|---|
| 岗位匹配度 | **9/10** | 重点是运行时、路由、恢复、规则、人在环、观测，而不是套壳聊天 Agent |
| Harness 工程信号 | **9/10** | kill 恢复、幂等、背压、灰度、注入隔离、成本/延迟约束都很对题 |
| 业务载体 | **8/10** | 内容审核天然适合“快模型 + 慢 Agent + 人”的分层结构 |
| 数据与评测 | **5.5/10** | 目前最大的短板：三类 taxonomy 和数据集对不上，尤其是“暴力” |
| 八周完成度 | **6.5/10** | 做成优秀面试项目可行；把现在所有东西都精修完，范围偏大 |
| 三周 MVP | **5/10（当前范围）** | 收缩后可到约 **8/10** |
| 总体 | **约 8/10** | **不是方向有问题，是有几处工程语义和评测口径必须改** |

这类岗位现在确实存在，不是你凭空造出来的目标。腾讯 2027 校招目前明确列出了“Agent 开发工程师”，并把 Agent 开发、AI 全栈、AI 应用列为新增 AI 岗位。更重要的是，腾讯官方 FAQ **没有写 10 月 26 日统一网申截止**，而是明确说大部分岗位会集中在 8–10 月完成面试和录用，并强烈建议尽早投递。也就是说，**项目方向与岗位对得上，但“等 10 月 24 日录完视频再赶 10 月 26 日”这个求职策略有问题。** citeturn24search0turn24search6

先直接报编号。

**我认为明确需要改的：14、19、27、30、32、38、43、47、48、50、60、62。**

**不是错，但需要收窄或改口径的：8、9、18、29、31、36、46、51、52。**

其余条目目前没有看到会阻塞项目成立的硬伤。

其中最重要的不是二十多条，真正会影响成败的是六件事：

**14/19 的 exactly-once 语义、27/62 的 taxonomy 和数据错位、38/43 的评测可信度、48 的 10 条反馈自动调阈值、50 的求职时间点，以及 36 的模型堆叠倾向。**

## 为什么这个项目本身是成立的

你做对的第一件事，是**没有把“Agent 项目”理解成“做一个会聊天、会调用几个工具的 Agent”**。

真正能给 Harness 面试官看出工程能力的是：

> 内容进入 → 路由 → 快判 → Agent 升级处理 → 人审 → 反馈 → 规则版本更新，同时整个过程在超时、限流、模型失败、进程 crash、规则变更时仍然可解释、可恢复、可追踪。

这比“我用 LangGraph 做了个多 Agent”强得多。

Pi 也确实适合作为这个项目的底座。当前 Pi 1.0.4 是 2026 年 10 月 5 日发布的版本；`pi-durable` 官方明确定位为 durable agent harness，会先持久化 conversation、model turn、tool call 和应用状态，然后再暴露结果，进程中途退出后可以恢复未完成工作。它还支持稳定的 `requestId` 去重、持久任务、每会话模型配置和扩展机制。citeturn22view0turn16view2

但恰恰因为它的 README 第一行就写着 **Experimental，API 可以在版本间无预警变化**，所以你把 1.0.4 锁死是正确的。citeturn16view2

你选“内容审核”作为业务也有一个很大的优势：它自然能让你展示两种不同的推理路径。

快速判官做：

`state -> bounded decision / probability`

Agent 做：

`疑似内容 + 上下文 + 规则版本 -> 查证 -> 判断 -> 理由 -> escalation`

这不是为了炫模型数量，而是非常自然的**快慢路径分离**。近期针对 Agent Harness 中 System-1 decision model 的一项成对实验也说明，这类小型决策模型确实适合工具选择、门控、注入筛查等有界决策，但其可靠性高度依赖具体决策点、候选顺序和校准，不能因为模型“快”就让它成为唯一安全闸门。该工作中 Laya 和 Jev 在不同决策点表现差异明显，甚至出现零样本路由失败和阈值从训练内数据迁移到 held-out 后失效的情况。这个结果不是你项目的直接 benchmark，但非常支持你“判官负责快判、Agent 处理疑难”的总体结构。citeturn20view0turn19view4

所以，我**不会改掉 11、13–17、40、42、44、45 这些主轴。**

相反，这些应该成为整个项目最突出的部分。

## 真正有问题的条目

| 编号 | 严重度 | 问题 | 建议改成什么 |
|---|---|---|---|
| **14** | 🔴 必改 | “进程被杀后零重复处置、零丢失”说得太绝对 | 改成“**任务至少一次执行；已提交处置结果 exactly-once；通过幂等键保证无重复业务处置**” |
| **19** | 🔴 必改 | “先处置，再写账本”如果是两个持久化动作，会产生 crash 双写窗口 | 改成 **decision + ledger/outbox 同一事务提交，再异步执行外部副作用** |
| **27** | 🔴 必改 | 数据组合没有真正覆盖你的“中国平台暴力文本”类；zh-decision-bench 的当前版本描述也不是简单“21 道题” | 固定数据版本和 slice；补暴力中文文本，或降低 V1 暴力文本结论强度 |
| **30** | 🔴 必改 | 每条规则 5 个样本只能算 smoke/contract test，不够当“回归门槛” | 5 个手写 contract case 保留，再加类别级 held-out regression pool |
| **32** | 🔴 必改 | 完全不让任何人检查模型映射错误，会削弱 benchmark 可信度 | 你本人可以继续不看；但需要**外部人工盲审一小批冲突/边界样本**，或者明确承认没有真人审计 |
| **38** | 🔴 必改 | 阿里/腾讯与你自己的 taxonomy 不同；p95 环境也可能不一致；“规则生效时间”未必是同一种能力 | 加正式 label mapping；固定客户端/并发/重试/预热；规则能力单列，不硬凑同指标 |
| **43** | 🔴 必改 | “另一模型出题”不能等价于 blind test；“同模型”也不适合 judge-only vs judge+agent | 主测试集预先冻结；模型生成只做 challenge set；另做 budget-matched 分析 |
| **47** | 🔴 必改 | 继承了 #14 的“绝对 exactly-once”问题 | 展示“执行可重复，**最终 committed disposition 不重复**”；最好 kill 四个不同位置 |
| **48** | 🔴 必改 | 10 条人工修改直接自动重拟并上线阈值，很像 demo 玩具，而且容易反向降低可靠性 | 10 条可以触发 **candidate threshold**，不能自动 production promote；设 minimum-N + 回归 gate |
| **50** | 🔴 必改 | “腾讯 10/26 截止”与当前腾讯官方 FAQ 不符，而且等待项目完成才投递反而不利 | **投递与项目开发并行，不等录屏** |
| **60** | 🔴 必改 | “实名就够了”未必成立。至少阿里内容安全 1.0 官方要求企业认证 | 改成“注册 + 实名 + 提前验证目标产品能否真正开通调用” |
| **62** | 🔴 必改 | ChineseHarm-Bench 本身没有 violence 类，无法当你的三类主 taxonomy | 项目自己定义 canonical taxonomy，数据集只是映射到它 |
| **8** | 🟡 | 只锁 `pi-durable` 不够稳 | Pi 相关包整体锁版本 + lockfile；外面包一层自己的 adapter |
| **9** | 🟡 | 95–99%、1500–2500/天等数字缺少你当前方案中的可靠公开出处 | README 写成“业务假设/行业访谈值”，除非补一手来源 |
| **18** | 🟡 | 在线系统在真实业务里不能即时知道“漏放/误拦” | 区分实时运营指标与收到 oracle/人审标签后的 delayed quality metrics |
| **29** | 🟡 | 暴力数据存在明显 domain shift；而 UnsafeBench 本身并非纯 AI 图 | 评测卡按 real / synthetic、中文文本图 / 自然图分别切片 |
| **31** | 🟡 | 数据集 gold label 不是真实“人审回流” | UI 可以模拟人审，但文档叫 **simulated reviewer oracle** |
| **36** | 🟡 | Laya + Jev + Clef + GLM 四路角色提前写死，容易变“模型动物园” | 架构支持 adapter，但上线组合 benchmark 后再定；V1 尽量 1 文本 + 1 视觉 + 1 Agent |
| **46** | 🟡 | “规则变更不重训”不是任何规则都能做到 | 明确演示的是 **policy-level rule update**，不是新增模型从没学过的语义能力 |
| **51** | 🟡 | 预算可行，但仅限 scale-to-zero、短时间 benchmark | 不要常驻 27B GPU；给总预算留 2× buffer |
| **52** | 🟡 | “中途换模型”有精确定义问题 | Pi 的 model change 对**下一次 model request**生效，不改变已经 prepared 的请求 |

### 最严重的是 #62

ChineseHarm-Bench 确实有 **6,000 条真实世界中文样本**以及人工整理的知识规则库，但它的六类是：

**gambling、pornography、abuse、fraud、illicit advertisements、non-violation。**

里面没有你的 **violence** 类。citeturn17view0turn18view0

所以：

> **“第一版规则体系默认以 ChineseHarm-Bench 三类子集为主”不能成立。**

你的三类应该先独立定义：

| 你的 canonical 类 | 数据映射 |
|---|---|
| abusive / hate / discrimination | ChineseHarm Abuse + COLD + ToxiCN |
| marketing / lead-gen | ChineseHarm Illicit Ads + QR/contact/广告集 |
| violence / graphic / weapons | UnsafeBench violent/shocking + weapons 数据 + **需要补中文文本侧** |

数据集不能反过来定义你的产品 taxonomy。

**产品规则是 source of truth；数据集是 adapter。**

这点改完以后，后面规则版本化、云服务对照、Agent reasoning、评测切片都会一下子顺很多。

另外，ToxiCN 当前有 12,011 条，其层级标签确实覆盖 general offensive language、hate speech、目标群体和显式/隐式表达；但其资源明确声明仅供科研使用，许可证是 **CC BY-NC-ND 4.0**。因此你现在“只做评测”这个决策是对的，但仓库里不要重新打包、修改后重新分发这些数据，也不要以后把这套 benchmark 不加说明地用于商业产品。citeturn17view2

`zh-decision-bench` 也需要重新写精确。当前 v0.2 页面显示 `business_scenarios` 已经是 **55 rows**；数据卡中的配置表和 changelog 甚至还存在 40→55 更新前后的数字痕迹。它不是一个可以笼统称为“21 道审核题”的稳定整体。如果你实际使用的是其中 21 条 `content_moderation` slice，就直接写：

> `zh-decision-bench v0.2, content_moderation slice, n=21, frozen IDs ...`

别写“zh-decision-bench = 21 道题”。citeturn21view0turn21view1

## Durable、幂等和 kill -9 应该怎么改

这是整个项目**最可能被资深后端 / Harness 面试官追问的地方**。

Pi Durable 做的是 durable execution，不等于替你解决了所有外部系统的 exactly-once。

官方语义非常明确：

> 每次 tool call 的 intent 会先提交；进程如果在执行中死掉，只有标记 `replay: "safe"` 的 tool 才会在恢复时重新执行，否则会得到 interrupted 结果。citeturn16view2

因此假设出现：

```text
Agent 决定 block
    ↓
调用 downstream.applyBlock()
    ↓
下游成功
    ↓
进程 crash
    ↓
还没把“成功”写进自己的账本
```

恢复后你不知道：

> 到底“已经执行但没记录”，还是“根本没执行”。

Pi 不可能神奇地知道外部 HTTP 服务发生了什么。

所以 #14 最专业的口径不是：

> exactly-once execution

而是：

> **at-least-once execution + exactly-once committed disposition**

或者：

> **idempotent effect processing**

你的数据路径最好是：

```text
content_id
   │
   ▼
ingress / queue
   │
   ▼
review_job
(content_id, policy_version)
   │
   ▼
Pi durable Agent
   │
   ▼
decision
   │
   ▼
┌──────────────────────────────┐
│ 一个 DB transaction          │
│                              │
│ INSERT disposition           │
│ UNIQUE(content, policy_ver)  │
│                              │
│ INSERT outbox event          │
└──────────────────────────────┘
   │
   ▼
outbox dispatcher
   │ idempotency_key
   ▼
实际处置
```

这比“先处置、然后记账”强很多。

Pi 自己已经提供了一些很适合你借鉴的模式：相同 `requestId` 重试不会提交两次；官方 persistent subagent 示例也通过 request ID 避免重启后重复发送消息或报告。citeturn16view2turn23view1

因此你的 #47 应该演成：

> kill 掉 Agent，可能出现执行重试，但 dashboard 最终显示每个 `(content_id, policy_version)` 只有一条 committed disposition，queue 中没有永久丢失的 job。

这个说法既强，也经得起追问。

而且不要只 kill 一次。

5 分钟 demo 里可以只展示一次；测试报告里至少有四个 crash point：

```text
A. 模型请求之前
B. 模型返回之后、decision commit 之前
C. decision/outbox commit 之后
D. 下游 effect 返回之后、ack 之前
```

这才是真 Harness 工程。

还有一个你必须知道的 Pi 限制：当前 Pi Durable SQLite backend 是 **WAL + synchronous=NORMAL**，官方保证的是 process crash 下 commit 持久；如果发生 power/host failure，最新 commit 仍可能丢失。另外同一个 storage 同时只允许一个进程 owner，没有跨进程 locking。citeturn23view0

因此：

**你的 demo #47 证明的是 process-crash recovery，不要扩大成 host-loss durability。**

这反而会让你的项目更可信。

#52 也要精确一点。Pi 当前文档明确规定，一次请求的 model、prompt、tools 在请求 prepared 时就固定了；配置改变从**下一次请求**开始生效。citeturn16view2

所以你验证的应该是：

> “运行中的 conversation 在 turn boundary / next request 使用新模型”

而不是：

> “已经发出去的 request 能热切模型”。

这两个是不一样的。

## 判官和规则层现在有一点混在一起

#36 是我第二个比较担心的设计点。

不是因为 Laya、Jev、Clef 不好，而是现在有点像：

```text
Laya = 平常规则
Jev = 新规则
Clef = 图片
GLM = Agent 复判
```

这个绑定关系没有必要这么早出现。

近期一个非常新的 System-1 Harness 对比实验中，Jev 在多数被测试的 decision point 上优于其测试的 Laya 版本，但 Laya 对 option order 和近似候选存在明显敏感性；同时两个模型都存在某些零样本 routing 失败。这个结果并不是内容审核上的结论，而且只是一篇很新的预印本，因此**恰恰说明不能事先凭模型名分配职责，而应该先跑你的 domain benchmark。** citeturn20view0

正确拆法应该是：

```text
             ┌── Decision model
             │   输出风险分数 / category score
内容 ────────┤
             │
             └── Policy engine
                 policy_version
                 threshold
                 exceptions
                 scenario
                 escalation rule
```

比如：

```text
risk.abuse = 0.83
risk.marketing = 0.17
risk.violence = 0.01
```

规则：

```text
policy v17:

if scene == "nickname" and abuse > 0.92:
    block
elif abuse > 0.65:
    agent
else:
    pass
```

此时你把：

```text
0.92 → 0.88
```

或者：

```text
昵称场景增加一个例外条件
```

叫作：

> **规则热更新，不需要重训。**

这是成立的。

但假设产品说：

> 明天开始识别一种以前完全没有定义过的新型黑产暗语。

那不一定只是改 policy 就能解决。

所以 #46 应改成：

> **“演示 policy-level semantic/policy change 可无训练上线；新增模型能力不承诺无训练。”**

这会比“任何新规则都不训练”专业得多。

Clef-flash 作为视觉判官目前是合理候选。Cloudflare Workers AI 当前免费额度为每天 **10,000 neurons**，而 Clef 是 Cloudflare 最新推出的 decision-model 系列；所以你把 Cloudflare 当便宜的视觉判官实验通道是合理的，但免费额度属于平台政策，应当在 README 标日期，而不是当作长期架构保证。citeturn19view2turn19view3

#39 里的两个免费 baseline 也是真实存在的。Qwen3Guard 有 0.6B/4B/8B 等版本，Qwen 官方模型卡采用 Apache-2.0，并支持中文在内的多语言 moderation；Llama Guard 4 是一个 12B multimodal safety classifier，可处理纯文本与 image+text。citeturn15search0turn15search1turn15search9

因此我会保留 #39。

但第一版**不要为了证明“我调过很多模型”而跑十几个模型。**

面试官真正想问的是：

> 为什么最后选它？

而不是：

> Hugging Face 上你认识多少 Guard 模型？

## 数据和评测是现在最弱的一环

#27–32 这一段目前比你的 runtime 设计弱一档。

UnsafeBench 的确是 10,146 张人工标注图片，而且不是单一来源：5,060 张来自真实世界 LAION-5B，5,086 张来自 AI 图像来源 Lexica，总计 6,098 safe、4,048 unsafe，覆盖 11 类 unsafe content。citeturn21view2turn21view3

所以 #29 如果意思是：

> “我们的暴力评测子集故意只取英文 / AI-generated”

那没问题，只是明显的 domain limitation。

但如果意思是：

> “UnsafeBench 本身就是 AI 生成暴力图”

那是不准确的。

更重要的是，**图片还不是你最大的洞。**

真正的洞是：

> **你的中文短文本/长文本 violence gold data 从哪里来？**

ChineseHarm 没有。

COLD/ToxiCN 主要是 offensive / hate。

你的图像集有 violence。

所以目前三类里面：

```text
不友好       ██████████ 数据不错
营销引流     ████████   还可以
暴力图片     ███████    能做
暴力中文文本 ██         明显弱
```

这里有两个选择。

我更倾向第一个：

**保留三类，但明确 violence text 是 low-coverage slice。**

补一些由公开平台规则构造的、人工或独立模型审定的中文 violence challenge cases，但不要拿纯 synthetic 数据冒充真实分布。

第二种才是砍掉 violence。

我目前**不建议马上砍**，因为视觉暴力能很好地证明你的多模态 routing。但一定要在 eval card 上分开：

```text
violence/text/zh
violence/image/real
violence/image/synthetic
```

不要汇总成一个看起来很好看的“暴力 F1”。

### #32 也必须改，但不是让你去看有害内容

你本人不想接触数据集中的辱骂、仇恨、血腥内容，这完全可以保持。

问题在于：

> **“所有需要语义判断的事情全部再交给一个模型”会形成闭环自证。**

例如：

```text
GLM 帮你映射数据标签
        ↓
GLM 帮你判边界样本
        ↓
GLM 又可能在 Agent 里复判
        ↓
最后你说系统准确
```

如果其中一开始的映射错了，后面全都可能一起错。

因此我建议：

> 你本人仍然不看原始有害内容。

但是在最终报告前，让一个外部人对：

- taxonomy mapping 冲突样本；
- judge / agent disagreement；
- 云厂商与你系统 disagreement；
- 最典型的 false positive / false negative；

抽几十条做一次**sealed human audit**。

你只接收：

```text
case_id
project_gold
auditor_gold
agree / disagree
reason_code
```

不用看到原文。

如果确实找不到真人，也可以继续全模型审定，但 README 必须写：

> “No independent human adjudication was performed.”

这不会毁掉项目。

**假装 dataset label = 真实平台人审才会毁可信度。**

所以 #31 本身不是不能做，只要叫：

> **simulated human-review oracle**

而不是“我们有人审数据”。

### #30 的五条规则样本保留，但换名字

每条规则五条是很好的：

> **contract tests**

比如：

```text
rule_17:
    obvious_positive
    boundary_positive
    obvious_negative
    hard_negative
    injection_like_case
```

非常适合作为 PR/unit gate。

但不能把它称为完整 regression gate。

推荐变成：

```text
每规则：
5 个 hand-written contract cases

每 category：
固定 held-out regression pool

全系统：
blind evaluation split
```

这样既不会让数据工作爆炸，也专业很多。

## 云厂商对比可以做，但必须重写方法

#38 的想法本身我赞成。

**阿里云、腾讯云 vs 你的系统，同一批公开样本。**

这会比“我的 F1=0.93”单独摆在那里有意义得多。

而且费用确实非常低。腾讯云当前文本内容安全按量价格是 **25 元/万条**，新用户首次开通有 3,000 条、15 天的文本免费试用额度。用 1,000 条这种级别的评测，API 本身不是预算问题。citeturn16view6

阿里云当前 Content Moderation 产品也提供文本、图片等多模态审核，增强版提供超过 100 个 detection labels，并覆盖暴力/恐怖、disturbing、ads、abuse/harassment 等类别。citeturn19view1

问题是：

**它们的 taxonomy 和你的 taxonomy 不是一回事。**

所以不要：

```text
腾讯 abuse
=
我们的不友好
```

直接硬映射。

你要在 repo 里有一张 frozen mapping：

```yaml
project:
  abusive:
    aliyun:
      - abuse
      - discrimination
      ...
    tencent:
      - abuse
      ...

  marketing:
    aliyun:
      - ads
      - traffic_diversion
    tencent:
      - ad
      ...

  violence:
    ...
```

遇到无法对齐的 label：

```text
UNMAPPED
```

宁可不计，不要为了表格整齐硬映射。

而 p95 也必须至少固定：

```text
client region
concurrency
warm-up
timeout
retry policy
sample order
API mode
measurement boundary
```

否则：

> 你在上海调用腾讯，海外 Modal 调自己，然后说谁 p95 快，

这个数字没有意义。

“规则生效时间”更应该谨慎。

云厂商可能提供的是标签开关、阈值、自定义词库、自定义 moderation agent，而你的可能是任意 policy DSL。阿里当前 Text Moderation PLUS 就支持标签启停和风险阈值配置；增强产品也有 policy/configuration 能力。citeturn15search7turn19view1

所以这一列最好改成：

> **Policy update mechanism / measured activation latency**

然后脚注明确到底更新了什么。

### #60 要现在验证，不要等第七周

阿里官方当前针对 **内容安全 1.0** 的开通文档明确写了：

> 开通需要账号完成企业认证。

同时新用户才有 API 文本/图片每日 3,000 条、31 天的免费额度。citeturn19view0

增强版产品的准入条件可能与 1.0 不完全一样，因此我不会说“阿里所有内容审核一定必须企业账号”；但足够说明：

> **“开一个个人账号实名认证，然后第七周肯定能 benchmark”是有风险的。**

所以 #60 应该提前到开工第一天做。

只验证：

```text
能否 activate
能否创建 key
能否成功调用 1 条
```

不要充值大额。

### #43 的 blind test 也需要重写

“Agent 做完后再让另一个 LLM 出题”只能叫：

> **LLM-generated challenge set**

不能叫主 blind test。

否则你的 pipeline 可能只是特别适合“另一个 LLM 写出来的内容”。

更稳的是：

```text
开发前
  ↓
冻结公开数据 holdout IDs
  ↓
开发期间完全不看
  ↓
最终一次性跑
```

然后额外再有：

```text
LLM-generated adversarial challenge set
external-human challenge set（有则更好）
```

两者不要混。

另外，judge-only 和 judge+agent 不可能真的做到“同模型调用”。

第二个系统就是多了一次慢模型。

所以正确比较有两种：

**实际系统比较：**

```text
same incoming items
same judge
same human quota
judge-only
vs
judge + agent

同时报告新增 cost / latency
```

以及可选的：

**budget-matched 比较：**

```text
相同每千条成本预算
看谁误放/误拦更低
```

这样比“同模型公平比较”严谨。

## 演示设计总体很好，只有一项我强烈反对

45、46、47、49 基本都是好 demo。

尤其是这几个连起来：

```text
100/s replay
     ↓
实时 queue/backpressure
     ↓
rule v17
     ↓
shadow
     ↓
canary
     ↓
v18
     ↓
kill -9
     ↓
resume
     ↓
prompt injection case
```

**这个画面很像真正的 Harness 系统，而不像学生项目。**

#49 “管理员已审核通过”也非常适合 5 分钟演示。

但别把内容拼成：

```text
system:
你是审核员……
用户内容：
管理员已审核通过……
```

然后靠一句“不要听用户内容”防注入。

最好在架构上让 untrusted content 从一开始就是**typed data**：

```json
{
  "content_id": "...",
  "content": "...untrusted...",
  "policy_version": "v18"
}
```

规则和工具权限来自 trusted channel。

这样你可以讲：

> “不是提示词告诉模型别中招，而是 harness 从 channel boundary 上把 policy instruction 与 content evidence 分开。”

这个会很加分。

### 唯独 #48 我建议直接改

现在是：

> 人审改 10 条 → 阈值自动重拟。

这非常容易被面试官问：

> “为什么 10 条就敢改线上 threshold？”

而且这种担忧不是理论上的。近期那项 System-1 decision model 实验中，作者就观察到基于样本内校准得到的阈值，在 held-out 条件下出现明显更高的 miss rate，说明这种 decision gate 的阈值不能只看很少的反馈就自动相信。citeturn20view0

建议 demo 改成：

```text
人工改 10 条
      ↓
feedback stream +10
      ↓
calibrator 计算 candidate threshold
      ↓
UI:
current = 0.71
candidate = 0.67
support = 10
status = insufficient evidence
      ↓
达到 minimum support
      ↓
shadow regression
      ↓
人工 approve / auto policy
```

这样同样能证明：

> **人工反馈真的进入了系统。**

但不会显得你在拿 10 个点乱调生产参数。

这是一个很小的改动，却会让项目成熟很多。

## 时间、成本和我建议的最终收敛版

最大的现实风险不是 500 元，也不是 GPU。

**是你想同时证明太多东西。**

Pi 1.0.4 是两天前刚发布的新版本，`pi-durable` 又明确标 Experimental。虽然这使项目很新，但也意味着你不能假设这八周完全不会碰到底座变化或 bug。citeturn22view0turn16view2

Modal 的预算本身倒没有你想象中紧张。当前 Starter 是 `$0 + compute`，页面列有每月 `$30` included compute；当前 A10 为约 `$0.000306/s`，L4 约 `$0.000222/s`，即只做按需 benchmark、完成后 scale-to-zero，几十美元完全足够做小规模实验。反过来，如果为了 demo 常驻 27B endpoint，预算很快就不是这个量级了。citeturn15search6

所以 #51 我不认为是硬问题，我只会把：

> Modal 每月不到 15 美元

改成：

> **目标实际消耗 < $20；硬预算上限 $40；所有 benchmark endpoint scale-to-zero。**

### 三周 MVP 我会砍成这个样子

到 10 月 24 日录屏时，你其实只需要证明：

```text
公开 replay
    ↓
G ingress
    ↓
fast judge
    ├── pass
    ├── block
    └── suspicious
           ↓
       Pi durable Agent
           ↓
      human / decision
           ↓
    ledger + outbox
```

外加四个动作：

```text
规则 v1 → shadow → v2
kill -9 → resume
dashboard
injection isolation
```

**够了。**

我甚至建议 10 月 24 日版本里：

- 文本判官最终只留 **一个赢家**；
- 图像只留 **Clef-flash 一个通道**；
- Agent 只留 **一个主模型**；
- 人审页只做最小 UI；
- 阿里/腾讯 benchmark 能做就放，账户卡住就晚一点补；
- 不在 MVP 里微调三个 judge；
- 不做漂亮后台管理系统；
- 不为每个模型做独立 dashboard。

模型 adapter 可以支持五个。

**demo 不需要同时部署五个。**

这样项目的技术中心仍然是：

> **Harness 如何管理不可靠模型和不断变化的 policy。**

而不是：

> 我挑了哪个 moderation 模型。

### #50 则应该马上改

腾讯官方目前仍然显示 2027 校招在开放，并明确列出 Agent 开发工程师；但官方 FAQ 的策略是“越早投递越好”，大部分岗位集中 8–10 月完成面试录用，而不是“10 月 26 日统一截止”。citeturn24search0turn24search1

因此项目计划应当变成：

```text
10/08        开工 + 同时投递
10/08–10/10 durable skeleton
10/11–10/14 judge / queue
10/15–10/18 agent + ledger/outbox
10/19–10/21 rules + observability
10/22        MVP freeze
10/23        failure tests
10/24        demo recording

之后继续：
vision
cloud comparison
calibration
benchmark polish
README / eval card
```

而不是：

```text
先把项目做完
↓
再开始投腾讯
```

这是我认为目前所有条目里**对求职结果影响最大、同时又最容易立即修掉的一条**。

## 最终建议

这个项目不用推倒重来。

**核心架构不改，改语义、改评测、砍一点模型范围。**

我最终会把红线修改收敛成下面这些：

> **#14**：从“exactly-once execution”改成“at-least-once execution + exactly-once committed disposition + idempotent effects”。Pi Durable 本身明确存在 crash 后 replay-safe tool 重跑机制，因此这个表述更准确。citeturn16view2

> **#19**：不要“外部处置成功后再写账本”，改成 transaction 内落 `decision + unique disposition + outbox`，随后幂等执行 effect。

> **#27 / #62**：不再让 ChineseHarm-Bench 定义 taxonomy。它只有 gambling、pornography、abuse、fraud、illicit ads、non-violation，没有 violence。建立自己的三类 canonical taxonomy，再映射所有数据源。citeturn17view0turn18view0

> **#30**：五条样本叫 contract tests，不叫完整 regression gate。

> **#32**：你本人继续不看有害内容；最终增加一次独立的 sealed human audit。做不到就明确写 limitation。

> **#36**：保留模型 adapter，但取消“Laya 永久主判官、Jev 专管新规则”这种预绑定。第 2 周 benchmark 后再选。

> **#38**：云服务对照必须加入 label mapping、固定客户端环境和 metric protocol；“rule update”单独解释。

> **#43**：冻结 public holdout 才是主 blind test；另一个模型生成的是 challenge set。

> **#46**：改成“policy-level update 不重训”，不要暗示任意新语义都能零训练支持。

> **#47**：kill -9 验证的是恢复 + 最终 ledger 去重，不宣传外部副作用天然 exactly-once。

> **#48**：10 条人工反馈只产生 candidate threshold，不自动 promotion。

> **#50**：**删掉“腾讯 10 月 26 日截止”这个前提；项目与投递并行。**腾讯官方当前建议尽早投，且仍显示 Agent 开发工程师岗位。citeturn24search0turn24search6

> **#60**：本周就验证阿里目标产品是否能 activate；仅个人实名不能默认满足所有版本的开通要求，内容安全 1.0 官方明确要求企业认证。citeturn19view0

所以，最后一句评价是：

**我会做这个项目。**

而且我认为它比“再做一个 Coding Agent / DeepResearch / RAG Agent”更适合你现在的求职目标。

但我不会按当前 63 条原封不动开工。

**必须先改：14、19、27、30、32、38、43、47、48、50、60、62。**

其中开工前真正必须解决的顺序，我会压缩成：

**62 → 14/19 → 50 → 38/43 → 48。**

你原来的 #52“先验证 durable 骨架”依然正确；只是**在写第一行 durable 代码之前，先把 #14/#19 的语义改对**。否则最危险的情况不是代码跑不起来，而是代码跑起来了，却在演示一个经不起面试官追问的“假 exactly-once”。