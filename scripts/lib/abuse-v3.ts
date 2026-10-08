// Fact-question labeling for the abuse rule (rules/prompts/abuse-facts-<version>.txt). The model answers 7 yes/no questions
// about what the text says; the label is computed here by a fixed table, never by the model. Design notes and the
// measurements behind it: docs/policy/abuse-standard-v3.md.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// versions live side by side (rules/prompts/abuse-facts-<version>.txt) so pilot runs can compare them
const templates = new Map<string, string>();
export function template(version = "v3"): string {
  if (!templates.has(version)) templates.set(version, readFileSync(join(import.meta.dirname, "..", "..", "rules", "prompts", `abuse-facts-${version}.txt`), "utf8"));
  return templates.get(version)!;
}
const SYSTEM = "你是中文内容审核标注员。只输出一个 JSON 对象，不要输出任何其他文字。";
export const QS = ["q1", "q2", "q3", "q4", "q5", "q6", "q7"] as const;
export type Facts = Record<(typeof QS)[number], boolean> & { reason: string };

function knobs(model: string): Record<string, unknown> {
  if (model.startsWith("deepseek")) return { max_tokens: 393216, thinking: { type: "disabled" } };
  if (model.startsWith("qwen")) return { max_tokens: 131072, enable_thinking: false };
  if (model.startsWith("gemini")) return { max_tokens: 65536 };
  return { max_tokens: 131072 };
}

export async function factsV3(cfg: { model: string; base: string; key: string; temperature?: number | undefined }, text: string, version = "v3"): Promise<Facts | null> {
  const user = template(version).trimEnd().replace("{{TEXT}}", () => text);
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(`${cfg.base}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, stream: false, ...knobs(cfg.model), ...(cfg.temperature === undefined ? {} : { temperature: cfg.temperature }), messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const m = /\{[\s\S]*\}/.exec(body.choices?.[0]?.message?.content ?? "");
      if (!m) continue;
      const raw = JSON.parse(m[0]) as Record<string, string>;
      if (!QS.every((q) => raw[q] === "是" || raw[q] === "否")) continue;
      return { ...Object.fromEntries(QS.map((q) => [q, raw[q] === "是"])), reason: String(raw.reason ?? "") } as Facts;
    } catch { /* retry */ }
  }
  return null;
}

/** The same 7 questions as Jev bool questions, read from the prompt file so all labelers see one wording:
 *  instructions = the definitions section + the question line; a question is "yes" when Jev's probability >= 0.5. */
export function jevQuestions(version = "v3"): Record<string, { type: "bool"; instructions: string; criteria: Record<string, string> }> {
  const TEMPLATE = template(version);
  const defs = /## 名词\n([\s\S]*?)\n## /.exec(TEMPLATE)?.[1]?.trim() ?? "";
  const out: Record<string, { type: "bool"; instructions: string; criteria: Record<string, string> }> = {};
  for (const q of QS) {
    const line = new RegExp(`^${q} (.+)$`, "m").exec(TEMPLATE)?.[1];
    if (!line) throw new Error(`question ${q} missing in abuse-facts-v3.txt`);
    out[q] = { type: "bool", instructions: `${defs}\n只看原文写了什么，拿不准就答否。\n${line}`, criteria: { true: "是", false: "否" } };
  }
  return out;
}

/** The fixed table (same scope as v2): q7 (quoted to refute / negated) clears everything; otherwise the heaviest hit. */
export function labelV3(f: Facts): { decision: "违规" | "允许"; rule: "V4" | "V3" | "V2" | "" } {
  if (f.q7) return { decision: "允许", rule: "" };
  if (f.q3) return { decision: "违规", rule: "V4" };
  if (f.q1 || f.q2 || f.q4) return { decision: "违规", rule: "V3" };
  if (f.q5 || f.q6) return { decision: "违规", rule: "V2" };
  return { decision: "允许", rule: "" };
}
