// Policy-first judging with the v2 prompt (rules/prompts/abuse-policy-v2.txt): decide violates / allowed / unsure first,
// then the rule (V2–V4) gives the severity. The model must quote the clause it relied on (`basis`), so we can check that
// the decision is anchored in the written policy.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROMPT_V2 = readFileSync(join(import.meta.dirname, "..", "..", "rules", "prompts", "abuse-policy-v2.txt"), "utf8");
const SYSTEM = "你是中文内容审核员。只输出一个 JSON 对象，不要输出任何其他文字。";

export type V2Answer = { decision: string; rule: string; target: string; basis: string; confidence: number; reason: string };
export type ChatCfg = { model: string; base: string; key: string };

/** Model-specific request knobs on the relay: max_tokens = official max; thinking off where the model allows it.
 *  (Requests also send stream:false: the relay answers gemini with SSE unless told otherwise.) */
function knobs(model: string): Record<string, unknown> {
  if (model.startsWith("deepseek")) return { max_tokens: 393216, thinking: { type: "disabled" } };
  if (model.startsWith("qwen")) return { max_tokens: 131072, enable_thinking: false };
  if (model.startsWith("gemini")) return { max_tokens: 65536 };
  return { max_tokens: 131072 };
}

export async function judgeV2(cfg: ChatCfg, text: string): Promise<V2Answer | null> {
  const user = PROMPT_V2.trimEnd().replace("{{TEXT}}", () => text);
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(`${cfg.base}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, stream: false, ...knobs(cfg.model), messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const m = /\{[\s\S]*\}/.exec(body.choices?.[0]?.message?.content ?? "");
      if (!m) continue;
      const v = JSON.parse(m[0]) as V2Answer;
      if (["违规", "允许", "不确定"].includes(v.decision)) return { ...v, confidence: Number(v.confidence) };
    } catch { /* retry */ }
  }
  return null;
}

/** Severity per docs/policy/abuse-prompt-v2-draft.md §3.3. */
export function v2Level(v: V2Answer): { level: string; action: string } {
  if (v.decision === "违规") {
    const s = v.rule === "V4" ? 4 : v.rule === "V3" ? 3 : 2;   // an unlabelled violation counts as the mildest
    return { level: `S${s}`, action: s === 4 ? "下架并标记账号" : s === 3 ? "下架" : "限流/折叠" };
  }
  if (v.decision === "不确定") return { level: "S1", action: "放行，进抽查（看不出对象或需要上下文时交 agent）" };
  return { level: "S0", action: "放行" };
}

/** Does `basis` quote a clause of the prompt (a substring of at least 6 characters after removing spaces)? */
export function basisAnchored(v: V2Answer): boolean {
  const b = (v.basis ?? "").replace(/\s+/g, "");
  if (b.length < 6) return false;
  const p = PROMPT_V2.replace(/\s+/g, "");
  return p.includes(b) || p.includes(b.slice(0, Math.min(b.length, 12)));
}
