// Offline probe of a reworded judge question (owner 2026-10-10): re-ask Jev, with the current and with the candidate
// instructions, on the items a harness run left undecided (evidence_gap / agent_stalled), and count how many leave the
// agent-stage middle band and whether they land on the expected side. Text only (model view), primary + in-call copy,
// the fitted temperatures of calib/jev-latest for the current rules version; nothing is written to any app.db.
// usage: node --experimental-strip-types scripts/probe-prompt.ts <run app.db> <cases.jsonl> [conc=24]   (JEV_* from .env)
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import type { Question } from "../packages/core/src/index.ts";
import { jevModel, jevProvider } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge } from "../packages/worker/src/pi-judge.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const [dbPath, casesPath, conc] = process.argv.slice(2);
const CANDIDATE = (JSON.parse(readFileSync("rules/drafts/question-wording-v2.json", "utf8")) as { instructions: Record<string, string> }).instructions;

const { bundle } = loadBundle("rules", "config/scenes.yaml");
const questions = core.rulesFor(bundle, "comment").map((r) => r.question);
const withText = (q: Question, text: string): Question => ({ ...q, instructions: text });
const candidate = questions.map((q) => (q.ruleId && CANDIDATE[q.ruleId] ? withText(q, CANDIDATE[q.ruleId]!) : q));
const lines = Object.fromEntries(bundle.rules.map((r) => [r.ruleId, r.agentThresholds ?? r.thresholds]));
// temperatures of the current rules version (file comment-<key>.<rulesVer>.json, else the plain one)
const T: Record<string, number> = {};
for (const f of readdirSync("calib/jev-latest").sort()) {
  const c = JSON.parse(readFileSync(join("calib/jev-latest", f), "utf8")) as { T: number; bucket: { question: string; rules_ver: string } };
  if (!T[c.bucket.question] || c.bucket.rules_ver === bundle.rulesVer) T[c.bucket.question] = c.T;
}
const cal = (probs: Record<string, number>, t: number): number => {
  const ks = Object.keys(probs), l = ks.map((k) => Math.log(Math.max(probs[k]!, 1e-12)) / t), m = Math.max(...l), z = l.reduce((a, x) => a + Math.exp(x - m), 0);
  return Math.exp(l[ks.indexOf("violate")]! - m) / z;
};

const models = createModels();
models.setProvider(jevProvider({ baseUrl: process.env["JEV_BASE_URL"]!, apiKey: process.env["JEV_API_KEY"]! }));
const judge = piJudge(models, jevModel(models), { inCallConfirm: true, timeoutMs: 30_000 });
type Case = { case_id: string; kind: string; target: { text: string }; expected: { disposition: string } };
const cases = new Map(readFileSync(casesPath!, "utf8").split("\n").filter(Boolean).map((l) => { const c = JSON.parse(l) as Case; return [c.case_id, c] as const; }));
const db = new DatabaseSync(dbPath!, { readOnly: true });
const ids = (db.prepare("SELECT content_id FROM review WHERE release_reason IN ('evidence_gap','agent_stalled')").all() as { content_id: string }[]).map((r) => r.content_id);

/** candidate preprocessing: undo the adversarial spacing / emoji splitting the eval set carries (adversarial/space,
 *  adversarial/emoji) — drop emoji, and whitespace or filler punctuation between two CJK characters */
const CJK = "\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef";
export function restore(t: string): string {
  return t.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "")
    .replace(new RegExp(`(?<=[${CJK}])[\\s·・._\\-*~]+(?=[${CJK}])`, "gu"), "");
}
const PREPROCESS = process.env["PROBE_RESTORE"] === "1";
type Verdict = "pass" | "act" | "middle" | "error";
async function verdict(qs: Question[], text: string): Promise<{ v: Verdict; p: Record<string, number> }> {
  const res = await judge.classify({ contentId: "probe", text: core.modelView(text), scene: "comment", evidence: [], questions: qs });
  if (res.status !== "ok") return { v: "error", p: {} };
  const p: Record<string, number> = {};
  let anyAct = false, allPass = true;
  for (const q of qs) {
    const a = res.answers[q.sha], b = res.variant?.answers[q.sha];
    const key = core.questionKey(q);
    if (!a || !T[key]) { allPass = false; continue; }
    const pa = cal(a.probs, T[key]!), pb = b ? cal(b.probs, T[key]!) : pa;
    p[key] = (pa + pb) / 2;
    if (q.kind !== "rule") continue;
    const ln = lines[q.ruleId!]!;
    if (pa >= ln.block && pb >= ln.block) anyAct = true;
    if (!(pa < ln.pass && pb < ln.pass)) allPass = false;
  }
  return { v: anyAct ? "act" : allPass ? "pass" : "middle", p };
}

const tally = { current: new Map<string, number>(), candidate: new Map<string, number>() };
const byKind = new Map<string, { n: number; cur_decided: number; cand_decided: number; cand_right: number; cand_wrong: number }>();
let i = 0;
await Promise.all(Array.from({ length: Number(conc ?? 24) }, async () => {
  while (i < ids.length) {
    const c = cases.get(ids[i++]!);
    if (!c) continue;
    const [cur, cand] = await Promise.all([verdict(questions, c.target.text), verdict(candidate, PREPROCESS ? restore(c.target.text) : c.target.text)]);
    const exp = c.expected.disposition, want: Verdict | "human" = exp === "pass" ? "pass" : exp === "human" ? "human" : "act";
    const mark = (v: Verdict): string => (v === "middle" || v === "error" ? v : want === "human" ? `${v}_vs_human` : v === want ? "right" : "wrong");
    tally.current.set(mark(cur.v), (tally.current.get(mark(cur.v)) ?? 0) + 1);
    tally.candidate.set(mark(cand.v), (tally.candidate.get(mark(cand.v)) ?? 0) + 1);
    const k = byKind.get(c.kind) ?? { n: 0, cur_decided: 0, cand_decided: 0, cand_right: 0, cand_wrong: 0 };
    k.n++; if (cur.v === "pass" || cur.v === "act") k.cur_decided++;
    if (cand.v === "pass" || cand.v === "act") { k.cand_decided++; if (mark(cand.v) === "right") k.cand_right++; if (mark(cand.v) === "wrong") k.cand_wrong++; }
    byKind.set(c.kind, k);
  }
}));
console.log(JSON.stringify({ items: ids.length, rulesVer: bundle.rulesVer, restore: PREPROCESS, current: Object.fromEntries(tally.current), candidate: Object.fromEntries(tally.candidate), byKind: Object.fromEntries(byKind) }, null, 1));
