// Stage ③ probe (dev plan 2026-10-08 §5, "long text and violence rules: define the rule and a few cases first"):
//   1) the draft VIOLENCE-004 question (rules/drafts/) asked to the real judge on the self-written draft cases, in a
//      throw-away bundle = live rules + the draft; raw probabilities (no calibration exists for it)
//   2) long posts: benign dev-split texts joined to ~500 / ~2,000 / ~5,000 characters, and the ~2,000 one with one
//      self-written abusive sentence at the start, the middle or the end; ABUSE-001 raw probability, status, latency
// Prints numbers only. usage: node --experimental-strip-types scripts/probe-draft-and-long.ts
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge, relayProvider } from "../packages/worker/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const JEV = env("JEV_MODEL", "jev-latest");
const models = createModels();
models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: JEV }));
const judge = piJudge(models, jevModel(models, JEV), { inCallConfirm: true, timeoutMs: 60_000 });
const pOf = (q: core.Question, a: Record<string, { probs: Record<string, number> }>) => a[q.sha]?.probs[q.violationOption] ?? null;

// 1) draft violence question
const tmp = mkdtempSync(join(tmpdir(), "draft-rules-"));
for (const f of readdirSync("rules").filter((x) => /^[A-Z]+-\d+\.yaml$/.test(x))) copyFileSync(join("rules", f), join(tmp, f));
copyFileSync("rules/drafts/VIOLENCE-004.yaml", join(tmp, "VIOLENCE-004.yaml"));
const draft = loadBundle(tmp, "config/scenes.yaml").bundle;
const qs = core.rulesFor(draft, "comment").map((r) => r.question);
const vq = core.rulesFor(draft, "comment").find((r) => r.ruleId === "VIOLENCE-004")!.question;
const aq = core.rulesFor(draft, "comment").find((r) => r.ruleId === "ABUSE-001")!.question;
const cases = (JSON.parse(readFileSync("data/cases/violence-draft-v1.json", "utf8")) as { cases: { id: string; text: string; expected: string }[] }).cases;
const violence = [];
for (const c of cases) {
  const res = await judge.classify({ contentId: c.id, text: c.text, scene: "comment", evidence: [], questions: qs });
  violence.push({ id: c.id, expected: c.expected, status: res.status, p_violence: res.status === "ok" ? +(pOf(vq, res.answers) ?? NaN).toFixed(3) : null, p_abuse: res.status === "ok" ? +(pOf(aq, res.answers) ?? NaN).toFixed(3) : null });
}
// 2) long posts
const live = loadBundle("rules", "config/scenes.yaml").bundle;
const pq = [...core.rulesFor(live, "post").map((r) => r.question)];
const abuseQ = core.rulesFor(live, "post").find((r) => r.ruleId === "ABUSE-001")!.question;
const benign = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { text: string; group: string; split: string; slice: string })
  .filter((x) => x.split === "dev" && x.slice === "everyday/hotel").map((x) => x.text);
const joinTo = (n: number) => { let s = ""; for (const t of benign) { if (s.length >= n) break; s += t + "。"; } return s.slice(0, n); };
const NEEDLE = "楼上这帮人全是垃圾，赶紧滚出这个城市。";
const L2 = joinTo(2000);
const longs: [string, string][] = [["benign-500", joinTo(500)], ["benign-2000", L2], ["benign-5000", joinTo(5000)],
  ["needle-start-2000", NEEDLE + L2], ["needle-middle-2000", L2.slice(0, 1000) + NEEDLE + L2.slice(1000)], ["needle-end-2000", L2 + NEEDLE]];
const long = [];
for (const [id, text] of longs) {
  const t0 = Date.now();
  const res = await judge.classify({ contentId: id, text, scene: "post", evidence: [], questions: pq });
  long.push({ id, chars: text.length, status: res.status, latency_ms: Date.now() - t0, p_abuse: res.status === "ok" ? +(pOf(abuseQ, res.answers) ?? NaN).toFixed(3) : null, input_tokens: res.status === "ok" ? res.usage.input : null });
}
console.log(JSON.stringify({ judge: JEV, draftRulesVer: draft.rulesVer, violence, long }, null, 1));
