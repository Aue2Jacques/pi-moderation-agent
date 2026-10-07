# pi-moderation-agent

在 [Pi](https://github.com/earendil-works/pi) 之上二开的内容审核 agent 系统（求职项目，面向 Agent / Harness 开发岗）。

**技术中心一句话**：让模型决定需要查什么，但不让模型决定自己拥有什么权限、采用哪套规则、哪些结果可以提交。

## 现在在哪一步

项目文档 v2.3 已冻结（四轮外部审查通过）。开发文档 v1.0 已写（[docs/dev-doc-v1.md](docs/dev-doc-v1.md)），待审查后按其 §14 的 14 天排期开发。尚无代码。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/project-doc-v2.md](docs/project-doc-v2.md) | **项目文档（权威）**：目标、业务、范围与分类体系、企业级属性、架构、模块设计、Pi 接口映射、数据、评测、演示、计划、风险；附录 C/D/E 是三轮审查的修订记录 |
| [docs/dev-doc-v1.md](docs/dev-doc-v1.md) | **开发文档 v1.0**：仓库结构、app.db DDL、状态转换表、事务边界、提交校验与错误码、接口、租约与取消、Pi 绑定写法（按 pi-durable 1.0.4 的 d.ts 核对）、评测执行协议、用例目录与 CI、部署配置、14 天排期 |
| [docs/reviews/](docs/reviews/) | 四轮外部审查原文：可行性、设计、harness/agent 角度、基于 GitHub 的终审 |
| [docs/requirements-v1.md](docs/requirements-v1.md) | 需求文档 v1（历史，第 12–15 节记录了早期修订） |
| [docs/dev-eval-plan-v1.md](docs/dev-eval-plan-v1.md) | 开发与评测方案 v1（历史；Pi 源码映射细节仍有参考价值） |
| [docs/confirmed-items-2026-10-07.md](docs/confirmed-items-2026-10-07.md) | 早期 63 条确认事项清单（历史） |
| [reports/](reports/) | 调研报告：审核业务、开源盘点、判官模型、Pi 生态与接口、jev-skill 精读、可行性 |

阅读顺序：project-doc-v2.md → docs/reviews/round-3 → reports 按需。

## 范围（第一版）

- 内容：短文本、长文本、图片。不做视频、直播、音频。
- 类别：不友好（ABUSE）、营销引流（MARKETING）、暴力（VIOLENCE）。不做色情、涉政、未成年、宗教、博彩。
- 不接真实平台；流量由公开数据集回放模拟；账号历史与对话上下文由公开规则合成。

## 数据与敏感内容

仓库不包含任何数据集样本。开发者本人不阅读样本正文；需要判定内容时由模型完成；日志、轨迹、仪表盘默认脱敏。数据集许可见 project-doc-v2.md 第 8 节。

## 审查方式

后续评审请直接读 `docs/project-doc-v2.md`，按章节号给意见。审查原文会归档到 `docs/reviews/`。
