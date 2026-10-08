// openai-logprob judge: prompt construction (labels follow pi-ai llama-cpp-classify: A–Z, a–z, 0–9) and the parsing contract (docs §9.1).
export const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export type ChoiceQuestion = { instructions: string; criteria: Record<string, string> };

export type Prompt = { messages: { role: "system" | "user"; content: string }[]; labels: Record<string, string>; order: string[] };

/** One question per prompt; options are shuffled with `shuffleSeed` when given (confirmation calls). */
export function buildPrompt(state: unknown, q: ChoiceQuestion, shuffleSeed?: number): Prompt {
  let order = Object.keys(q.criteria);
  if (order.length > LABELS.length) throw new Error(`too many options: ${order.length}`);
  if (shuffleSeed !== undefined) order = shuffle(order, shuffleSeed);
  const labels: Record<string, string> = {};
  order.forEach((opt, i) => { labels[opt] = LABELS[i]!; });
  const options = order.map((opt) => `${labels[opt]}. ${q.criteria[opt]}`).join("\n");
  return {
    messages: [
      { role: "system", content: "You are a classifier. Answer with exactly one option letter and nothing else." },
      { role: "user", content: `<state>\n${JSON.stringify(state)}\n</state>\n\n${q.instructions}\n\n${options}\n\nAnswer:` },
    ],
    labels, order,
  };
}

export type TopLogprob = { token: string; logprob: number };
export type Parsed = { status: "ok"; probs: Record<string, number>; massCovered: number } | { status: "abstain"; reason: "missing_option" | "low_mass" | "no_label" };

/** All configured options must match a top-logprob token (leading whitespace stripped); otherwise abstain. */
export function parseTopLogprobs(top: readonly TopLogprob[], labels: Record<string, string>, massMin = 0.5): Parsed {
  const byLabel = new Map<string, number>();
  for (const t of top) {
    const tok = t.token.replace(/^\s+/, "");
    if (tok.length !== 1) continue;
    const prev = byLabel.get(tok);
    if (prev === undefined || t.logprob > prev) byLabel.set(tok, t.logprob);
  }
  if (byLabel.size === 0) return { status: "abstain", reason: "no_label" };
  const lp: Record<string, number> = {};
  for (const [opt, label] of Object.entries(labels)) {
    const v = byLabel.get(label);
    if (v === undefined) return { status: "abstain", reason: "missing_option" };
    lp[opt] = v;
  }
  const mass = Object.values(lp).reduce((a, l) => a + Math.exp(l), 0);
  if (mass < massMin) return { status: "abstain", reason: "low_mass" };
  const probs: Record<string, number> = {};
  for (const [opt, l] of Object.entries(lp)) probs[opt] = Math.exp(l) / mass;
  return { status: "ok", probs, massCovered: mass };
}

/** Seeded Fisher–Yates that always changes the order for ≥ 2 items (an identity result is rotated by one; see jev.ts). */
function shuffle(items: string[], seed: number): string[] {
  const a = [...items];
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  if (a.length > 1 && a.every((x, i) => x === items[i])) a.push(a.shift()!);
  return a;
}
