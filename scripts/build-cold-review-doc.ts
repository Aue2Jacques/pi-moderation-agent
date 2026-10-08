// Build a reading document for the project owner: selected COLD rows with the text, COLD labels, Jev's fast-path scores,
// the earlier glm verdict, and a new glm-5.3-flash breakdown on the D1–D6 dimensions of docs/policy/abuse-policy-draft.md.
// Severity and action are computed HERE from the draft's tables (not by the model). The document contains dataset text,
// so it is written under data/ (gitignored) and is meant for the owner, not for the developer.
// usage: node --experimental-strip-types scripts/build-cold-review-doc.ts <out.md>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decompose, severity, type Facts } from "./lib/abuse-decompose.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const OUT = process.argv[2] ?? "data/review/cold-examples-2026-10-07.md";
const MODEL = env("SENSITIVE_CHECK_MODEL", "glm-5.3-flash");
const BASE = env("RELAY_BASE_URL").replace(/\/+$/, "");
const KEY = env("RELAY_API_KEY");

// GitHub line numbers of COLD test.csv (= position + 2), grouped as in reports/2026-10-07-jev-on-cold-test.md
const GROUPS: [string, string, number[]][] = [
  ["1a", "Jev 放行，但 COLD 和 glm 都说冒犯（群体攻击）——Jev 真漏的候选", [998, 2661, 3218, 4756]],
  ["1b", "Jev 放行，但 COLD 和 glm 都说冒犯（贬低性刻板印象）——Jev 真漏的候选", [74, 402, 2652, 3393]],
  ["2a", "COLD 说冒犯，Jev 和 glm 都说不算（glm 认为是中性讨论）——标准分歧", [256, 2052, 3477, 4918]],
  ["2b", "COLD 说冒犯，Jev 和 glm 都说不算（glm 认为是反偏见）——标准分歧", [458, 493, 1727, 2707]],
  ["2c", "COLD 说冒犯，Jev 和 glm 都说不算（glm 认为是反讽）——标准分歧", [769, 2127, 3291, 3457]],
  ["3", "对照：三方都说冒犯，Jev 拦下", [252, 3301, 4040]],
  ["4", "对照：三方都说安全，Jev 放行", [542, 1117, 5032]],
  ["5", "反方向：COLD 说安全、Jev 放行，但 glm 说冒犯", [305, 1779, 3885]],
];
const FINE: Record<number, string> = { 0: "安全·其他", 1: "冒犯·攻击个人", 2: "冒犯·攻击群体", 3: "安全·反偏见" };

// data
const texts = new Map<number, { text: string; label: number; fine: number | null }>();
for (const l of readFileSync("data/cold-eval/test.jsonl", "utf8").split("\n")) if (l) { const r = JSON.parse(l) as { i: number; text: string; label: number; fine: number | null }; texts.set(r.i, r); }
const jev = new Map<number, { p: number; copy: number }>();
for (const l of readFileSync("data/cold-eval/test-run1.jsonl", "utf8").split("\n")) if (l) { const r = JSON.parse(l) as { i: number; status: string; primary?: Record<string, { p: number }>; copy?: Record<string, { p: number }> | null }; if (r.status === "ok") jev.set(r.i, { p: r.primary!["ABUSE-001"]!.p, copy: r.copy?.["ABUSE-001"]?.p ?? r.primary!["ABUSE-001"]!.p }); }
const prior = new Map<number, { cold_offensive: string; type: string }>();
if (existsSync("data/cold-eval/leak-check.jsonl")) for (const l of readFileSync("data/cold-eval/leak-check.jsonl", "utf8").split("\n")) if (l) { const r = JSON.parse(l) as { i: number; ok: boolean; cold_offensive: string; type: string }; if (r.ok) prior.set(r.i, r); }

const jobs = GROUPS.flatMap(([g, , lines]) => lines.map((line) => ({ g, pos: line - 2, line })));
const facts = new Map<number, Facts | null>();
let next = 0;
await Promise.all(Array.from({ length: 16 }, async () => {
  while (next < jobs.length) { const j = jobs[next++]!; facts.set(j.pos, await decompose({ model: MODEL, base: BASE, key: KEY }, texts.get(j.pos)!.text)); }
}));

const md: string[] = [
  "# COLD 例子阅读文档（2026-10-07）",
  "",
  "给负责人看的。含 COLD 原文，不进 git。开发者没有读过这份文档。拆解模型见文末。",
  "",
  "每条依次列出：COLD 原文；COLD 的标签；Jev 快判的分数和结果（≥0.90 拦截，两份都 <0.10 放行，其余交 agent）；glm 上一轮的判断；按 `docs/policy/abuse-policy-draft.md` 新方案的拆解（D1–D6 由 glm-5.3-flash 回答，严重度和处置由代码查表得出，不是 glm 定的）。",
  "",
  "每条末尾有一栏\"你的判断\"，写同意或不同意、应该怎么判即可。值得当判例的，标\"判例\"。",
  "",
];
const sevCount: Record<string, number> = {};
let n = 0;
for (const [g, title, lines] of GROUPS) {
  md.push(`## ${g}. ${title}`, "");
  for (const line of lines) {
    const pos = line - 2;
    const t = texts.get(pos)!;
    const j = jev.get(pos);
    const f = facts.get(pos);
    const sev = f ? severity(f) : null;
    if (sev) sevCount[`${g}:${sev.level}`] = (sevCount[`${g}:${sev.level}`] ?? 0) + 1;
    const mean = j ? (j.p + j.copy) / 2 : NaN;
    const fast = !j ? "无数据" : mean >= 0.9 ? "拦截" : j.p < 0.1 && j.copy < 0.1 ? "放行" : "交 agent";
    const pr = prior.get(pos);
    n++;
    md.push(
      `### ${n}. COLD 第 ${line} 行`,
      "",
      `> ${t.text}`,
      "",
      `- COLD 标签：${t.label === 1 ? "冒犯" : "安全"}（${t.fine === null ? "-" : FINE[t.fine]}）`,
      `- Jev：${j ? `${j.p.toFixed(2)} / ${j.copy.toFixed(2)}，快判结果：${fast}` : "无数据"}`,
      `- glm 上一轮：${pr ? `${pr.cold_offensive === "yes" ? "冒犯" : pr.cold_offensive === "no" ? "不冒犯" : "拿不准"}（${pr.type}）` : "这条上一轮没有抽到"}`,
      f
        ? `- 新方案拆解（按片段）：\n${(f.fragments ?? []).map((x, k) => { const ps = sev?.per[k]; return `  - 「${x.span}」对象 ${x.d2}${x.d3 && x.d3 !== "不适用" ? `（${x.d3}）` : ""}；方式 ${x.d4}；表达 ${x.d5}；立场 ${x.d6} → S${ps?.s ?? 0}${ps?.exception ? `（例外：${ps.exception}）` : ""}${ps?.inconsistent ? "（自称反对偏见但在侮辱/贬低，例外不成立）" : ""}`; }).join("\n") || "  - 无"}`
        : "- 新方案拆解：模型调用失败",
      sev ? `- 按新方案：**${sev.level}，${sev.action}**（${sev.why}）` : "",
      f ? `- glm 的理由：${f.reason}` : "",
      "- 你的判断：",
      "",
    );
  }
}
if (process.env["DUMP_FACTS"]) for (const [pos, f] of facts) {
  const sev = f ? severity(f) : null;
  console.error(JSON.stringify({ line: pos + 2, d1: f?.d1, frags: f?.fragments?.map((x) => ({ d2: x.d2, d3: x.d3, d4: x.d4, d5: x.d5, d6: x.d6 })), level: sev?.level, per: sev?.per }));
}
md.push("---", "", `拆解模型：${MODEL}；生成时间：${new Date().toISOString()}；方案：docs/policy/abuse-policy-draft.md（按片段拆解，例外只作用于本片段）。`, "");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n");
console.log(JSON.stringify({ out: OUT, items: n, failed: [...facts.values()].filter((f) => !f).length, severity_by_group: sevCount }));
