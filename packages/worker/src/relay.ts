// The a6api relay as a pi-ai OpenAI-compatible provider. Model specs come from config/models.json (docs §13.3).
// Thinking: durable's default thinkingLevel is "off" (no `reasoning` option), and each model's `compat.thinkingFormat`
// turns that into the vendor's "thinking off" field (qwen: enable_thinking=false; deepseek: thinking.type=disabled; zai: forced on).
import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const RELAY_PROVIDER_ID = "a6api";

export type RelayModelSpec = {
  id: string; contextWindow: number; maxOutputTokens: number; input: ("text" | "image")[];
  priceUsd: { input: number; output: number; cachedInput?: number };
  thinkingFormat: "qwen" | "deepseek" | "zai" | "openai";
  temperature?: boolean;
};

export const RELAY_MODELS: RelayModelSpec[] = [
  { id: "qwen3.8-flash", contextWindow: 1_000_000, maxOutputTokens: 131_072, input: ["text", "image"], priceUsd: { input: 0.15, output: 0.47, cachedInput: 0.016 }, thinkingFormat: "qwen" },
  { id: "glm-5.3", contextWindow: 1_000_000, maxOutputTokens: 131_072, input: ["text"], priceUsd: { input: 1.4, output: 4.4, cachedInput: 0.26 }, thinkingFormat: "zai" },
  { id: "glm-5.3-flash", contextWindow: 1_000_000, maxOutputTokens: 131_072, input: ["text", "image"], priceUsd: { input: 0.15, output: 0.5, cachedInput: 0.03 }, thinkingFormat: "zai" },
  { id: "deepseek-v4.1-flash", contextWindow: 1_000_000, maxOutputTokens: 393_216, input: ["text", "image"], priceUsd: { input: 0.3, output: 1.2, cachedInput: 0.006 }, thinkingFormat: "deepseek" },
  { id: "gpt-6.1-sol", contextWindow: 1_050_000, maxOutputTokens: 128_000, input: ["text", "image"], priceUsd: { input: 2, output: 10, cachedInput: 0.1 }, thinkingFormat: "openai", temperature: false },
];

export function relayProvider(cfg: { baseUrl: string; apiKey: string; models?: RelayModelSpec[] }): Provider<"openai-completions"> {
  const models: Model<"openai-completions">[] = (cfg.models ?? RELAY_MODELS).map((m) => ({
    id: m.id, name: m.id, api: "openai-completions", provider: RELAY_PROVIDER_ID, baseUrl: cfg.baseUrl,
    input: m.input, reasoning: true, contextWindow: m.contextWindow, maxTokens: m.maxOutputTokens,
    cost: { input: m.priceUsd.input, output: m.priceUsd.output, cacheRead: m.priceUsd.cachedInput ?? 0, cacheWrite: 0 },
    compat: { thinkingFormat: m.thinkingFormat, maxTokensField: "max_tokens", supportsReasoningEffort: m.thinkingFormat === "openai", supportsStore: false, supportsDeveloperRole: false },
  }));
  return createProvider({
    id: RELAY_PROVIDER_ID,
    name: "a6api relay",
    baseUrl: cfg.baseUrl,
    auth: { apiKey: { name: "relay API key", login: async () => { throw new Error("key comes from the environment"); }, resolve: async () => ({ auth: { apiKey: cfg.apiKey }, source: "RELAY_API_KEY" }) } },
    models,
    api: openAICompletionsApi(),
  });
}
