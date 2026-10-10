// Display names for codes the API returns. Unknown codes are shown as they are.
import type { Action, RouteKind } from "./api.ts";

export const SCENE: Record<string, string> = { comment: "评论", danmaku: "弹幕", nickname: "昵称", post: "帖子", image: "图片" };
export const ACTION: Record<Action, string> = { pass: "放行", limit: "限流", takedown: "下架" };
export const ACTOR: Record<string, string> = { fastpath: "快判", agent: "agent", human: "人工" };
export const STATE: Record<string, string> = { queued: "排队中", investigating: "调查中", disposed: "已处置", human_queue: "待人工", human_disposed: "人工已处置" };
export const TRIGGER: Record<string, string> = { fast: "快判", suspicious: "疑似", appeal: "申诉", recheck: "复查", rule_change: "规则变更" };
export const ROUTE: Record<RouteKind, string> = { fast_pass: "自动放行", fast_block: "自动处置", agent: "转 agent", human_direct: "直接转人工", appeal: "申诉重审", other: "其他" };
export const ROUTES: RouteKind[] = ["fast_pass", "fast_block", "agent", "human_direct", "appeal"];
export const QUESTION: Record<string, string> = { "ABUSE-001": "辱骂", "MARKETING-003": "营销引流", injection_guard: "注入检查", image_check: "图片检查", "VIOLENCE-004": "暴力" };
export const CATEGORY: Record<string, string> = { ABUSE: "辱骂", MARKETING: "营销引流", VIOLENCE: "暴力" };
export const PHASE: Record<string, string> = { intake: "等待快判", agent: "agent 处理中", human: "等待人工", done: "已完成" };

export const TOOL: Record<string, string> = {
  load_rule: "读取规则", get_thread_context: "取线程上下文", get_account_history: "取账号历史", judge: "带证据复判",
  confirm: "打乱选项复问", dispose: "提交处置", release: "交人工", escalate_model: "升级模型",
};

/** Reasons: why a review was suspicious, why it went to a person, why the fast path decided. */
export const REASON: Record<string, string> = {
  suspicious_band: "概率处于待定区间", injection_suspected: "疑似注入", needs_context: "需结合上下文", parent_missing: "缺少父内容",
  blacklist_hit: "命中黑名单", rate_limited: "账号触发频控", evidence_gap: "证据不足", timeout: "超时", budget_tools: "工具次数用尽",
  budget_cost: "费用预算用尽", judge_down: "判官不可用", model_release: "模型主动放弃", backpressure: "系统积压", revoked: "执行已撤销",
  preprocess_error: "预处理失败", fastpath_error: "快判多次失败", calib_missing: "缺少校准", judge_incomplete: "判官未完整作答",
  image_unsupported: "包含图片", image_review: "图片需人工查看", bundle_missing: "规则版本缺失", agent_stalled: "agent 无进展",
  all_required_covered_and_confirmed: "所有规则均低于放行线，且复问一致", block_support: "达到处置线",
};
export function reasonText(code: string | null | undefined): string {
  if (!code) return "—";
  if (REASON[code]) return REASON[code]!;
  if (code.startsWith("uncovered:")) return `未能放行：${code.slice(10).split(",").map((c) => CATEGORY[c] ?? c).join("、")}`;
  if (code.startsWith("block_support; also_hit:")) return `达到处置线（另命中 ${code.slice(24)}）`;
  if (code.startsWith("calib_missing:")) return `缺校准：${code.slice(14)}`;
  if (code.startsWith("judge_incomplete:")) return `判官未答：${code.slice(17)}`;
  return code;
}

export const APPEAL_REASONS: { code: string; label: string }[] = [
  { code: "disagree", label: "不认同处置" },
  { code: "context_missing", label: "没看上下文" },
  { code: "misread", label: "理解有误" },
  { code: "other", label: "其他" },
];
export const appealReason = (code: string | null): string => APPEAL_REASONS.find((x) => x.code === code)?.label ?? (code ?? "—");

/** How demo mode's judge works, for the mode badge and the overview: scripted, or a real judge run replayed on real texts. */
export function demoJudgeNote(c: { demo_corpus?: { judge: string; items: number } | null }): string {
  return c.demo_corpus
    ? `评论选自测试集中的 ${c.demo_corpus.items.toLocaleString()} 条真实文本，联系方式已脱敏；快判分数为 Kev 的实测结果，agent 与审核员为模拟`
    : "判官与 agent 均为模拟";
}
