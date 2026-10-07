import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const ROOT = join(import.meta.dirname, "..", "..");

describe("config files", () => {
  it("models.json: every relay model has context_window, max_output_tokens, input, price; prices.yaml covers each", () => {
    const m = JSON.parse(readFileSync(join(ROOT, "config", "models.json"), "utf8")) as { models: Record<string, Record<string, unknown>>; defaults: Record<string, string> };
    const prices = parse(readFileSync(join(ROOT, "config", "prices.yaml"), "utf8")) as { models: Record<string, { input: number; output: number }> };
    for (const [id, spec] of Object.entries(m.models)) {
      expect(spec["context_window"], id).toBeGreaterThan(0);
      expect(spec["max_output_tokens"], id).toBeGreaterThan(0);
      expect(Array.isArray(spec["input"]), id).toBe(true);
      expect(prices.models[`a6api/${id}`], `price for ${id}`).toBeDefined();
    }
    for (const v of ["AGENT_MODEL", "STRONG_MODEL", "VISION_CHECK_MODEL", "SENSITIVE_CHECK_MODEL", "JUDGE_LOGPROB_MODEL"]) expect(m.models[m.defaults[v]!], v).toBeDefined();
  });
});
