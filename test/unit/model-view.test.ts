// E5: the runtime model view passes the shared cases (the eval builder's Python copy passes the same file).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_VIEW_VERSION, modelView } from "../../packages/core/src/model-view.ts";

const CASES = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "rules", "model-view-cases.json"), "utf8")) as { version: string; cases: { in: string; out: string; eval?: boolean }[] };

describe("model view (E5)", () => {
  it("version matches the shared cases", () => expect(MODEL_VIEW_VERSION).toBe(CASES.version));
  for (const c of CASES.cases.filter((x) => !x.eval)) it(`${c.in} -> ${c.out}`, () => expect(modelView(c.in)).toBe(c.out));
});
