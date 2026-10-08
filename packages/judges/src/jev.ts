// Jev through pi-ai's built-in typesafe-system-one API (docs §9.1). One HTTP call carries every question twice:
// the original and a shuffled-options copy, so the fast path gets its confirmation answer in the same request (docs §9.2).
import { createProvider, type ClassifierModel, type ClassifierQuestion, type Models, type Provider } from "@earendil-works/pi-ai";
import { typesafeSystemOneApi } from "@earendil-works/pi-ai/api/typesafe-system-one.lazy";
import type { Question } from "@mod/core";

export type JevConfig = { baseUrl: string; apiKey: string; modelId?: string; pricePerMillionUsd?: number };

export const JEV_PROVIDER_ID = "jev";

export function jevProvider(cfg: JevConfig): Provider {
  const price = cfg.pricePerMillionUsd ?? 0.042;
  return createProvider({
    id: JEV_PROVIDER_ID,
    name: "Jev (System One relay)",
    auth: {
      apiKey: {
        name: "Jev API key",
        login: async () => { throw new Error("Jev key comes from the environment"); },
        resolve: async () => ({ auth: { apiKey: cfg.apiKey }, source: "JEV_API_KEY" }),
      },
    },
    models: [{
      type: "classifier", id: cfg.modelId ?? "jev-latest", name: "Jev 1.13", api: "typesafe-system-one", provider: JEV_PROVIDER_ID,
      baseUrl: cfg.baseUrl, input: ["text"], cost: { input: price, output: price, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192,
    }],
    classifiers: { "typesafe-system-one": typesafeSystemOneApi() },
  });
}

export function jevModel(models: Models, modelId = "jev-latest"): ClassifierModel<"typesafe-system-one"> {
  const m = models.getModelOfType("classifier", JEV_PROVIDER_ID, modelId);
  if (!m) throw new Error(`Jev model ${modelId} not registered`);
  return m as ClassifierModel<"typesafe-system-one">;
}

/**
 * Deterministic option-order shuffle for the confirmation copy. Guaranteed to change the order when there are ≥ 2 options:
 * a seeded Fisher–Yates can return the identity permutation (seed 17 did, for every 3-option question, until 2026-10-07),
 * in which case the order is rotated by one.
 */
export function shuffleCriteria(criteria: Record<string, string>, seed: number): Record<string, string> {
  const orig = Object.keys(criteria);
  const keys = [...orig];
  let s = seed >>> 0;
  for (let i = keys.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  if (keys.length > 1 && keys.every((k, i) => k === orig[i])) keys.push(keys.shift()!);
  return Object.fromEntries(keys.map((k) => [k, criteria[k]!]));
}

export const CONFIRM_SUFFIX = "#confirm";

/** Wire name of a question: its readable key (ABUSE-001, ABUSE-001.EX-QUOTE, image_check), or the sha when it has none. */
export const wireKey = (q: Question): string => q.key ?? q.sha;

/**
 * Build System One questions keyed by readable name: `key` and `key#confirm` (options shuffled) when `inCallConfirm`.
 * `toSha` maps every wire key (without the confirm suffix) back to the question sha used everywhere else.
 */
export function buildQuestions(questions: readonly Question[], inCallConfirm: boolean, seed = 17): { questions: Record<string, ClassifierQuestion>; toSha: Record<string, string> } {
  const out: Record<string, ClassifierQuestion> = {};
  const toSha: Record<string, string> = {};
  for (const q of questions) {
    const k = wireKey(q);
    if (toSha[k] && toSha[k] !== q.sha) throw new Error(`duplicate judge question key ${k}`);
    toSha[k] = q.sha;
    out[k] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
    if (inCallConfirm) out[`${k}${CONFIRM_SUFFIX}`] = { type: "choice", instructions: q.instructions, criteria: shuffleCriteria(q.criteria, seed) };
  }
  return { questions: out, toSha };
}
