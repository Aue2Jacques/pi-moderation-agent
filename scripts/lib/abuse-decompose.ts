import { readFileSync } from "node:fs";
import { join } from "node:path";
// Fragment-level decomposition of a comment on the dimensions of docs/policy/abuse-policy-draft.md, and the severity
// table that turns facts into a level. The model only describes facts; severity is computed here.
export const D2 = ["具体个人", "公众人物", "受保护人群", "其他人群", "机构地方作品", "观点政策", "自己"] as const;
export const D4 = ["威胁", "去人化", "本质化贬低", "侮辱脏话", "贬损嘲讽", "以偏概全", "批评反对", "都没有"] as const;
// draft §3.1: rows D2, columns D4 (威胁 去人化 本质化贬低 侮辱脏话 贬损嘲讽 以偏概全 批评反对)
export const TABLE: Record<string, (number | null)[]> = {
  具体个人: [4, 4, 3, 3, 2, 0, 0],
  公众人物: [4, 4, 3, 2, 1, 0, 0],
  受保护人群: [4, 4, 3, 3, 2, 1, 0],
  其他人群: [4, 3, 2, 2, 1, 0, 0],
  机构地方作品: [4, 0, 0, 0, 0, 0, 0],
  观点政策: [null, 0, 0, 0, 0, 0, 0],
  自己: [null, 0, 0, 0, 0, 0, 0],
};
export const ACTION = ["放行", "放行，进抽查", "限流/折叠", "下架", "下架并标记账号"];

export type Fragment = { span: string; d2: string; d3: string; d4: string; d5: string; d6: string };
export type Facts = { d1: string; fragments: Fragment[]; reason: string };
export type FragSev = { s: number | null; exception: string | null; inconsistent: boolean; needsContext: boolean };
export const SEVERE = new Set(["去人化", "本质化贬低", "侮辱脏话", "威胁"]);
export function fragSeverity(f: Fragment, d1: string): FragSev {
  const col = D4.indexOf(f.d4 as (typeof D4)[number]);
  const row = TABLE[f.d2];
  const base = col < 0 || col === 7 || !row ? 0 : (row[col] ?? 0);
  // exceptions act on this fragment only, and only when consistent with how the fragment speaks
  const claimsException = f.d6 === "反对偏见" || f.d6 === "自嘲或圈内自称" || (f.d5 === "转述引用" && f.d6 !== "赞同偏见或攻击");
  const inconsistent = claimsException && SEVERE.has(f.d4) && f.d2 !== "自己";
  if (claimsException && !inconsistent) return { s: 0, exception: f.d6 === "自嘲或圈内自称" ? "自我指称" : f.d5 === "转述引用" ? "转述" : "反对偏见", inconsistent: false, needsContext: false };
  const needsContext = d1 === "指向含糊" || (f.d6 === "看不出" && (f.d5 === "隐晦" || f.d5 === "反讽") && base >= 2);
  return { s: base, exception: null, inconsistent, needsContext };
}
export function severity(f: Facts): { level: string; action: string; why: string; per: FragSev[] } {
  if (f.d1 === "没有" || !f.fragments?.length) return { level: "S0", action: ACTION[0]!, why: "无指向或无评价", per: [] };
  const per = f.fragments.map((x) => fragSeverity(x, f.d1));
  const max = Math.max(...per.map((p) => p.s ?? 0));
  const ctx = per.some((p) => p.needsContext && (p.s ?? 0) === max && max >= 1);
  const inc = per.some((p) => p.inconsistent);
  const why = `${f.fragments.length} 个片段，最重 S${max}${inc ? "；有片段自称反对偏见但同时在侮辱/贬低，例外不成立" : ""}`;
  if (ctx) return { level: `S${max}?`, action: "需要上下文，交 agent", why, per };
  return { level: `S${max}`, action: ACTION[max]!, why, per };
}

export const SYSTEM = "你是中文内容审核标注员。只输出一个 JSON 对象，不要输出任何其他文字。";
// The instruction text is policy data, versioned with the rules: rules/prompts/abuse-decompose.txt
const TEMPLATE = readFileSync(join(import.meta.dirname, "..", "..", "rules", "prompts", "abuse-decompose.txt"), "utf8");
export const prompt = (text: string): string =>
  TEMPLATE.trimEnd().replace("{{D2}}", D2.join(" / ")).replace("{{D4}}", D4.join(" / ")).replace("{{TEXT}}", () => text);

export async function decompose(cfg: { model: string; base: string; key: string }, text: string): Promise<Facts | null> {
  const { model: MODEL, base: BASE, key: KEY } = cfg;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        // official max output per model (relay requirement, config/models.json); deepseek runs with thinking disabled for speed
        body: JSON.stringify({ model: MODEL, max_tokens: MODEL.startsWith("deepseek") ? 393216 : 131072, ...(MODEL.startsWith("deepseek") ? { thinking: { type: "disabled" } } : {}), ...(MODEL.startsWith("qwen") ? { enable_thinking: false } : {}), messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(text) }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const m = /\{[\s\S]*\}/.exec(body.choices?.[0]?.message?.content ?? "");
      if (!m) continue;
      const f = JSON.parse(m[0]) as Facts;
      if (f.d1 && Array.isArray(f.fragments)) return f;
    } catch { /* retry */ }
  }
  return null;
}

