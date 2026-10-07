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

/** Deterministic option-order shuffle for the confirmation copy. */
export function shuffleCriteria(criteria: Record<string, string>, seed: number): Record<string, string> {
  const keys = Object.keys(criteria);
  let s = seed >>> 0;
  for (let i = keys.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }
  return Object.fromEntries(keys.map((k) => [k, criteria[k]!]));
}

export const CONFIRM_SUFFIX = "#confirm";

/** Build System One questions: `sha` and `sha#confirm` (shuffled) for each question when `inCallConfirm`. */
export function buildQuestions(questions: readonly Question[], inCallConfirm: boolean, seed = 17): Record<string, ClassifierQuestion> {
  const out: Record<string, ClassifierQuestion> = {};
  for (const q of questions) {
    out[q.sha] = { type: "choice", instructions: q.instructions, criteria: q.criteria };
    if (inCallConfirm) out[`${q.sha}${CONFIRM_SUFFIX}`] = { type: "choice", instructions: q.instructions, criteria: shuffleCriteria(q.criteria, seed) };
  }
  return out;
}
