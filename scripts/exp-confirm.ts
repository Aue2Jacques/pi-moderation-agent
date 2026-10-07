// Phase 3b: is the in-call shuffled copy an independent confirmation, or a near-duplicate of the same forward pass?
// Three arms on the same 50 self-written sentences (no dataset text):
//   A in-call  : one request with original + shuffled copy
//   B two-calls: original request, then a separate request with shuffled options
//   C repeat   : original request sent twice unchanged (noise floor)
// Reports choice agreement, mean |Δp| on the violation option, tokens and latency per arm.
// usage: node --experimental-strip-types scripts/exp-confirm.ts   (JEV_BASE_URL / JEV_API_KEY from env or .env)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";
import type { JudgeAnswers } from "../packages/worker/src/judge-client.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const models = createModels();
models.setProvider(jevProvider({ baseUrl: process.env["JEV_BASE_URL"]!, apiKey: process.env["JEV_API_KEY"]! }));
const inCall = piJudge(models, jevModel(models), { inCallConfirm: true, timeoutMs: 20_000 });
const single = piJudge(models, jevModel(models), { inCallConfirm: false, timeoutMs: 20_000 });
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const questions = core.rulesFor(bundle, "comment").flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]);

// 50 self-written sentences, mild, mixed intent
const S: string[] = (JSON.parse(readFileSync("fixtures/benign/sentences.json", "utf8")) as { exp_confirm: string[] }).exp_confirm;

type Arm = { agree: number; dp: number[]; tokensIn: number; tokensOut: number; ms: number; n: number; flips: string[] };
const arms: Record<"A_in_call" | "B_two_calls" | "C_repeat", Arm> = {
  A_in_call: { agree: 0, dp: [], tokensIn: 0, tokensOut: 0, ms: 0, n: 0, flips: [] },
  B_two_calls: { agree: 0, dp: [], tokensIn: 0, tokensOut: 0, ms: 0, n: 0, flips: [] },
  C_repeat: { agree: 0, dp: [], tokensIn: 0, tokensOut: 0, ms: 0, n: 0, flips: [] },
};
const rows: unknown[] = [];

function compare(arm: Arm, a: JudgeAnswers, b: JudgeAnswers, tag: string): void {
  for (const q of questions) {
    const x = a[q.sha]; const y = b[q.sha];
    if (!x || !y) continue;
    arm.n++;
    if (x.choice === y.choice) arm.agree++; else arm.flips.push(`${tag}:${q.ruleId ?? q.kind}:${x.choice}>${y.choice}`);
    arm.dp.push(Math.abs((x.probs[q.violationOption] ?? 0) - (y.probs[q.violationOption] ?? 0)));
  }
}

const CONCURRENCY = Number(process.env["CONCURRENCY"] ?? 8);
type Four = { i: number; a: Awaited<ReturnType<typeof inCall.classify>>; b1: typeof a; b2: typeof a; c2: typeof a };
async function runOne(i: number, text: string): Promise<Four> {
  const req = { contentId: `exp:${i}`, text, scene: "comment", evidence: [], questions };
  const [a, b1, b2, c2] = await Promise.all([inCall.classify(req), single.classify(req), single.classify({ ...req, shuffleSeed: 17 }), single.classify(req)]);
  return { i, a, b1, b2, c2 };
}
const results: Four[] = [];
let next = 0;
let done = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < S.length) {
    const i = next++;
    results.push(await runOne(i, S[i]!));
    done++;
    if (done % 10 === 0) console.log(`progress ${done}/${S.length} ${Date.now() - t0}ms`);
  }
}));
results.sort((x, y) => x.i - y.i);
for (const { i, a, b1, b2, c2 } of results) {
  if (a.status !== "ok" || b1.status !== "ok" || b2.status !== "ok" || c2.status !== "ok") { console.log(i, "non-ok", a.status, b1.status, b2.status, c2.status); continue; }
  compare(arms.A_in_call, a.answers, a.variant?.answers ?? {}, `s${i}`);
  arms.A_in_call.tokensIn += a.usage.input; arms.A_in_call.tokensOut += a.usage.output; arms.A_in_call.ms += a.latencyMs;
  compare(arms.B_two_calls, b1.answers, b2.answers, `s${i}`);
  arms.B_two_calls.tokensIn += b1.usage.input + b2.usage.input; arms.B_two_calls.tokensOut += b1.usage.output + b2.usage.output; arms.B_two_calls.ms += b1.latencyMs + b2.latencyMs;
  compare(arms.C_repeat, b1.answers, c2.answers, `s${i}`);
  arms.C_repeat.tokensIn += b1.usage.input + c2.usage.input; arms.C_repeat.tokensOut += b1.usage.output + c2.usage.output; arms.C_repeat.ms += b1.latencyMs + c2.latencyMs;
  const abuse = questions.find((q) => q.ruleId === "ABUSE-001" && q.kind === "rule")!;
  rows.push({ i, abuse_p: [a.answers[abuse.sha]?.probs["violate"], a.variant?.answers[abuse.sha]?.probs["violate"], b1.answers[abuse.sha]?.probs["violate"], b2.answers[abuse.sha]?.probs["violate"], c2.answers[abuse.sha]?.probs["violate"]].map((v) => Number((v ?? 0).toFixed(3))) });
}
console.log(`wall ${Date.now() - t0}ms for ${S.length * 4} calls at concurrency ${CONCURRENCY}`);
const mean = (xs: number[]): number => (xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : 0);
const summary = Object.fromEntries(Object.entries(arms).map(([k, v]) => [k, {
  pairs: v.n, choice_agreement: Number((v.agree / Math.max(1, v.n)).toFixed(3)), mean_abs_dp: Number(mean(v.dp).toFixed(4)), p90_abs_dp: Number(([...v.dp].sort((a, b) => a - b)[Math.floor(v.dp.length * 0.9)] ?? 0).toFixed(4)),
  tokens_in_per_sentence: Math.round(v.tokensIn / S.length), tokens_out_per_sentence: Math.round(v.tokensOut / S.length), ms_per_sentence: Math.round(v.ms / S.length), flips: v.flips,
}]));
console.log(JSON.stringify(summary, null, 1));
mkdirSync("data", { recursive: true });
writeFileSync("data/exp-confirm.json", JSON.stringify({ summary, rows, n: S.length, date: new Date().toISOString() }, null, 1));
console.log("wrote data/exp-confirm.json");
