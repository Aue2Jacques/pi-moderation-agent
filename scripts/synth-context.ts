// Synthetic context for the harness showcase set (owner 2026-10-09): the texts are real test-split comments, which come
// with no thread and no account, so a real agent has nothing to look up and hands nearly everything to a person. This
// builds the missing evidence by a fixed recipe, then relabels every comment WITH its context by the frozen procedure.
//   synth <cases.jsonl> <out.jsonl> [conc=40]
//       thread: deepseek-v4.1-flash writes one parent post and 0-3 earlier replies for the comment's scene; the parent's
//       relation to the comment is assigned by a fixed hash share — neutral topic 60%, the parent mocks itself / jokes
//       15%, the two sides argue 15%, unrelated 10%. The model never sees a label and is told not to judge or name rules.
//       account history: four kinds drawn with label-dependent shares (an assumption, recorded per item and in the
//       manifest): violating comment — repeat offender 30%, warned 15%, clean 55%; allowed comment — 3%, 7%, 90%.
//   label <synth.jsonl> <out.jsonl> [conc=80]
//       ABUSE-001 (abuse-v4.3) and MARKETING-003 (marketing-v2) standards, deepseek-v4.1-flash and qwen3.8-flash x 3
//       runs each, gemini-3.8-flash tie-break when the two disagree (FROZEN procedure in lib/labeling.ts); the labeler
//       sees the parent, the replies and the comment, never the account history. Expected disposition: any violate ->
//       takedown (abuse) / limit (marketing only); any uncertain -> human; else pass.
//   corpus <demo-corpus.jsonl> <out.jsonl> [conc=60]
//       the same thread + history recipe for every line of the console's demo corpus (no relabel: the demo keeps the
//       recorded judge answers and the dataset label); the demo traffic writes them next to each comment
// Text stays on the server (data/); prints counts only.
// usage: node --experimental-strip-types scripts/synth-context.ts synth|label ...   (RELAY_* from env or .env)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ABUSE_V43, MARKETING_V2, finalLabel, majority, readAnswers, type Answer, type Label, type Standard } from "./lib/labeling.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const BASE = () => env("RELAY_BASE_URL").replace(/\/+$/, "");
const h01 = (salt: string, id: string): number => parseInt(createHash("sha256").update(`${salt}|${id}`).digest("hex").slice(0, 8), 16) / 0xffffffff;
const readJsonl = <T>(p: string): T[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

type Case = {
  case_id: string; kind: string; source: string; target: { text: string; account: string; mentions: string[]; images: string[] };
  thread: { ref: string; text: string; account: string; offset_min: number }[]; reply_to: string | null;
  history: { kind: "prior_ruling" | "post"; payload: unknown; offset_days: number }[];
  expected: { disposition: string; rules: string[] }; synth?: Record<string, unknown>;
};

function knobs(model: string): Record<string, unknown> {
  if (model.startsWith("deepseek")) return { max_tokens: 8192, thinking: { type: "disabled" } };
  if (model.startsWith("qwen")) return { max_tokens: 8192, enable_thinking: false };
  return { max_tokens: 8192 };
}
async function chat(model: string, messages: { role: string; content: string }[]): Promise<string | undefined> {
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(`${BASE()}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env("RELAY_API_KEY")}` },
        body: JSON.stringify({ model, stream: false, ...knobs(model), messages }), signal: AbortSignal.timeout(90_000) });
      if (res.ok) return ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1000 * (a + 1)));
  }
  return undefined;
}
async function pool<T>(xs: T[], conc: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => { while (i < xs.length) await f(xs[i++]!); }));
}
const json = (raw: string | undefined): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  const m = /\{[\s\S]*\}/.exec(raw);
  try { return m ? JSON.parse(m[0]) as Record<string, unknown> : undefined; } catch { return undefined; }
};

const SCENE: Record<string, string> = { weibo: "微博", danmaku: "视频弹幕区", waimai: "外卖评价区", shopping: "购物评价区", hotel: "酒店点评区" };
const sceneOf = (source: string): string => { for (const [k, v] of Object.entries(SCENE)) if (source.includes(k)) return v; return "社交平台评论区"; };
const RELATIONS: [string, number, string][] = [
  ["neutral", 0.6, "父帖是一个普通话题，这条评论是对父帖的回应"],
  ["self_mock", 0.15, "父帖作者在自嘲或开玩笑，语气轻松"],
  ["argue", 0.15, "父帖作者与评论者观点对立，讨论气氛紧张"],
  ["unrelated", 0.1, "父帖与这条评论没有明显关系"],
];
const pickRelation = (id: string): [string, string] => { let u = h01("relation", id); for (const [k, w, d] of RELATIONS) { if (u < w) return [k, d]; u -= w; } return ["neutral", RELATIONS[0]![2]]; };
const HISTORY: Record<"violate" | "allow", [string, number][]> = { violate: [["repeat", 0.3], ["warned", 0.15], ["clean", 0.55]], allow: [["repeat", 0.03], ["warned", 0.07], ["clean", 0.9]] };
const pickHistory = (id: string, cls: "violate" | "allow"): string => { let u = h01("history", id); for (const [k, w] of HISTORY[cls]) { if (u < w) return k; u -= w; } return "clean"; };

const [phase, a1, a2, a3] = process.argv.slice(2);

if (phase === "synth") {
  const cases = readJsonl<Case>(a1!);
  const out: Case[] = [];
  let failed = 0;
  await pool(cases, Number(a3 ?? 40), async (c) => {
    const [rel, relDesc] = pickRelation(c.case_id);
    const k = Math.floor(h01("replies", c.case_id) * 4);   // 0-3 earlier replies
    const raw = await chat("deepseek-v4.1-flash", [
      { role: "system", content: "你在为内容审核系统构造评测用的讨论串。只输出一个 JSON 对象，不要输出其他文字。" },
      { role: "user", content: `下面是一条来自${sceneOf(c.source)}的用户评论。请虚构它所在的讨论串：一条父帖，以及 ${k} 条在这条评论之前出现的同线程回复。\n要求：${relDesc}；内容自然、像真实用户写的；不要评价这条评论，不要出现“违规”“举报”“审核”“规则”等词；不要改写评论本身；每条不超过 60 字。\n输出格式：{"parent": "父帖内容", "replies": ["回复1", "..."]}\n\n评论：${c.target.text}` },
    ]);
    const j = json(raw);
    const parent = typeof j?.["parent"] === "string" ? (j["parent"] as string).slice(0, 120) : undefined;
    if (!parent) { failed++; return; }
    const replies = (Array.isArray(j?.["replies"]) ? (j!["replies"] as unknown[]) : []).filter((x): x is string => typeof x === "string").slice(0, k).map((x) => x.slice(0, 120));
    const cls: "violate" | "allow" = c.expected.disposition === "pass" ? "allow" : "violate";
    const hist = pickHistory(c.case_id, cls);
    const rule = c.kind === "marketing" ? "MARKETING-003" : "ABUSE-001";
    const history: Case["history"] = hist === "repeat" ? [1, 2, 3].slice(0, 2 + Math.floor(h01("n", c.case_id) * 2)).map((d, i) => ({ kind: "prior_ruling", payload: { action: i === 0 ? "takedown" : "limit", rule_ids: [rule] }, offset_days: d * 2 }))
      : hist === "warned" ? [{ kind: "prior_ruling", payload: { action: "limit", rule_ids: [rule] }, offset_days: 4 }] : [];
    out.push({ ...c, thread: [{ ref: "parent", text: parent, account: `u_p_${c.case_id}`, offset_min: 30 }, ...replies.map((t, i) => ({ ref: `r${i + 1}`, text: t, account: `u_r${i}_${c.case_id}`, offset_min: 20 - i * 5 }))],
      reply_to: "parent", history, synth: { relation: rel, replies: replies.length, history: hist, source_label: cls } });
  });
  out.sort((x, y) => x.case_id.localeCompare(y.case_id));
  writeFileSync(a2!, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const count = (key: string) => out.reduce((m, x) => { const v = String(x.synth![key]); m[v] = (m[v] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log(JSON.stringify({ written: out.length, failed, relation: count("relation"), history: count("history") }));
} else if (phase === "label") {
  const cases = readJsonl<Case>(a1!);
  const view = (c: Case): string => [`【父帖】${c.thread.find((t) => t.ref === "parent")?.text ?? ""}`, ...c.thread.filter((t) => t.ref !== "parent").map((t) => `【同线程较早的回复】${t.text}`), `【待判断的评论，回复父帖】${c.target.text}`, "（只判断“待判断的评论”本身，父帖与其他回复只作为理解语境的参考。）"].join("\n");
  type Job = { c: Case; std: Standard; model: string; run: number };
  const LABELERS = ["deepseek-v4.1-flash", "qwen3.8-flash"];
  const ask = async (std: Standard, model: string, c: Case): Promise<Label | undefined> => {
    const raw = await chat(model, [{ role: "system", content: "你是中文内容审核标注员。只输出一个 JSON 对象，不要输出任何其他文字。" }, { role: "user", content: std.prompt.trimEnd().replace("{{TEXT}}", () => view(c)) }]);
    const r = raw === undefined ? undefined : readAnswers(std, raw);
    return r && r.missing.length === 0 ? std.label(r.got as Record<string, Answer>) : undefined;
  };
  const votes = new Map<string, Label[]>();
  const key = (c: Case, std: Standard, model: string) => `${c.case_id}|${std.id}|${model}`;
  const jobs: Job[] = cases.flatMap((c) => [ABUSE_V43, MARKETING_V2].flatMap((std) => LABELERS.flatMap((model) => [0, 1, 2].map((run) => ({ c, std, model, run })))));
  let failed = 0;
  await pool(jobs, Number(a3 ?? 80), async (j) => { const l = await ask(j.std, j.model, j.c); if (!l) { failed++; return; } votes.set(key(j.c, j.std, j.model), [...(votes.get(key(j.c, j.std, j.model)) ?? []), l]); });
  // tie-break: gemini x 3 where the two labelers' majorities differ
  const ties = cases.flatMap((c) => [ABUSE_V43, MARKETING_V2].filter((std) => majority(votes.get(key(c, std, LABELERS[0]!)) ?? []) !== majority(votes.get(key(c, std, LABELERS[1]!)) ?? [])).map((std) => ({ c, std })));
  await pool(ties.flatMap((t) => [0, 1, 2].map(() => t)), Number(a3 ?? 80), async (t) => { const l = await ask(t.std, "gemini-3.8-flash", t.c); if (l) votes.set(key(t.c, t.std, "gemini"), [...(votes.get(key(t.c, t.std, "gemini")) ?? []), l]); });
  const out = cases.map((c) => {
    const lab = Object.fromEntries([ABUSE_V43, MARKETING_V2].map((std) => {
      const a = majority(votes.get(key(c, std, LABELERS[0]!)) ?? []), b = majority(votes.get(key(c, std, LABELERS[1]!)) ?? []);
      const g = votes.get(key(c, std, "gemini"));
      return [std.id, finalLabel(a, b, g ? majority(g) : undefined)];
    })) as Record<string, ReturnType<typeof finalLabel>>;
    const ab = lab[ABUSE_V43.id]!.label, mk = lab[MARKETING_V2.id]!.label;
    const disposition = ab === "violate" ? "takedown" : mk === "violate" ? "limit" : ab === "allow" && mk === "allow" ? "pass" : "human";
    const rules = [...(ab === "violate" ? ["ABUSE-001"] : []), ...(mk === "violate" ? ["MARKETING-003"] : [])];
    return { ...c, expected: { disposition, rules }, synth: { ...c.synth, labels: { abuse: lab[ABUSE_V43.id], marketing: lab[MARKETING_V2.id] }, source_expected: c.expected.disposition } };
  });
  writeFileSync(a2!, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const by = out.reduce((m, x) => { m[x.expected.disposition] = (m[x.expected.disposition] ?? 0) + 1; return m; }, {} as Record<string, number>);
  const changed = out.filter((x) => (x.expected.disposition === "pass") !== (String(x.synth!["source_expected"]) === "pass")).length;
  console.log(JSON.stringify({ labeled: out.length, failed_calls: failed, tie_breaks: ties.length, expected: by, changed_vs_source_label: changed }));
} else if (phase === "corpus") {
  // the demo corpus (scripts/make-demo-corpus.py lines: id, kind, slice, text, recorded answers) gets the same recipe:
  // a parent post and 0-3 earlier replies, an account history by the label shares above (label = the corpus kind: normal
  // -> allowed, others -> violating); written back as corpus lines with `thread` and `history` (DEMO_CORPUS)
  type Line = { id: string; kind: string; slice: string; text: string; [k: string]: unknown };
  const items = readJsonl<Line>(a1!);
  const out: Line[] = [];
  let failed = 0;
  await pool(items, Number(a3 ?? 60), async (it) => {
    const [rel, relDesc] = pickRelation(it.id);
    const k = Math.floor(h01("replies", it.id) * 4);
    const raw = await chat("deepseek-v4.1-flash", [
      { role: "system", content: "你在为内容审核系统构造评测用的讨论串。只输出一个 JSON 对象，不要输出其他文字。" },
      { role: "user", content: `下面是一条来自${sceneOf(it.slice)}的用户评论。请虚构它所在的讨论串：一条父帖，以及 ${k} 条在这条评论之前出现的同线程回复。\n要求：${relDesc}；内容自然、像真实用户写的；不要评价这条评论，不要出现“违规”“举报”“审核”“规则”等词；不要改写评论本身；每条不超过 60 字。\n输出格式：{"parent": "父帖内容", "replies": ["回复1", "..."]}\n\n评论：${it.text}` },
    ]);
    const j = json(raw);
    const parent = typeof j?.["parent"] === "string" ? (j["parent"] as string).slice(0, 120) : undefined;
    if (!parent) { failed++; out.push(it); return; }
    const replies = (Array.isArray(j?.["replies"]) ? (j!["replies"] as unknown[]) : []).filter((x): x is string => typeof x === "string").slice(0, k).map((x) => x.slice(0, 120));
    const hist = pickHistory(it.id, it.kind === "normal" ? "allow" : "violate");
    const rule = it.kind === "marketing" ? "MARKETING-003" : "ABUSE-001";
    const history = hist === "repeat" ? [1, 2, 3].slice(0, 2 + Math.floor(h01("n", it.id) * 2)).map((d, i) => ({ action: i === 0 ? "takedown" : "limit", rule_ids: [rule], offset_days: d * 2 }))
      : hist === "warned" ? [{ action: "limit", rule_ids: [rule], offset_days: 4 }] : [];
    out.push({ ...it, thread: { parent, replies, relation: rel }, history, history_kind: hist });
  });
  const order = new Map(items.map((x, i) => [x.id, i]));
  out.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
  writeFileSync(a2!, out.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(JSON.stringify({ items: out.length, failed, with_thread: out.filter((x) => x["thread"]).length }));
} else {
  throw new Error("usage: synth-context.ts synth <cases> <out> [conc] | label <synth> <out> [conc] | corpus <corpus> <out> [conc]");
}
