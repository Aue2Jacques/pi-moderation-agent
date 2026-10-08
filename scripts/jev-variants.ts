// Run one Jev question variant (rules/prompts/jev-variants.yaml) over a COLD split and keep the raw typed answers
// (choice probabilities + confidence, score + confidence, bool probability). No text is written to the output.
// usage: node --experimental-strip-types scripts/jev-variants.ts <in.jsonl> <variant> <out.jsonl> [concurrency=64]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const [inPath, variant, outPath] = [process.argv[2]!, process.argv[3]!, process.argv[4]!];
const CONCURRENCY = Number(process.argv[5] ?? 64);

const spec = parse(readFileSync(join(import.meta.dirname, "..", "rules", "prompts", "jev-variants.yaml"), "utf8")) as { variants: Record<string, Record<string, ClassifierQuestion>> };
const questions = spec.variants[variant];
if (!questions) throw new Error(`unknown variant ${variant}`);
const modelId = env("JEV_MODEL", "jev-latest");
const models = createModels();
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId }));
const model = jevModel(models, modelId);

type Row = { i: number; label: number; fine: number | null; text: string };
const rows = readFileSync(inPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
const done = new Set<number>(existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { i: number; ok: boolean }).filter((r) => r.ok).map((r) => r.i) : []);
const todo = rows.filter((r) => !done.has(r.i));

let next = 0, ok = 0, failed = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < todo.length) {
    const r = todo[next++]!;
    let res: Awaited<ReturnType<typeof models.classify>> | undefined;
    const t = Date.now();
    for (let a = 0; a < 3; a++) {
      res = await models.classify(model, { state: { content: { text: r.text, scene: "comment" } } as unknown as JsonObject, questions }, { timeoutMs: 30_000 });
      if (res.stopReason === "stop") break;
      await new Promise((s) => setTimeout(s, 1000 * (a + 1)));
    }
    const good = res?.stopReason === "stop";
    if (good) ok++; else failed++;
    appendFileSync(outPath, `${JSON.stringify({ i: r.i, label: r.label, fine: r.fine, variant, ok: good, ms: Date.now() - t, ...(good ? { answers: res!.answers, usage: res!.usage ? { input: res!.usage.input, output: res!.usage.output } : null } : { err: res?.errorMessage?.slice(0, 80) }) })}\n`);
  }
}));
console.log(JSON.stringify({ variant, rows: rows.length, ran: todo.length, ok, failed, wall_s: Math.round((Date.now() - t0) / 1000) }));
