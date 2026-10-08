// Case pool v1 (dev plan 2026-10-08 §3): 80 cases in four kinds — context changes the conclusion (self-written pairs),
// evidence is really missing (self-written, expected human), account history is a decoy (public text + written
// history), plain controls (public text). Text never goes into the repo: the full pool lives in data/cases/ (gitignored);
// the committed manifest holds ids, kinds, structure, expectations, label sources and text hashes only.
//   pick      public candidates from the eval dev split, isolated from every labeling / calibration sample (their ids
//             and the injection family of each) -> data/cases/public-candidates.txt; and the self-written targets as an
//             items file -> data/cases/self-items.jsonl (so they can be labeled with the frozen procedure, target alone)
//   build     after both are labeled (label-pilot run x3 + adjudicate for abuse-v4.3 / marketing-v2 / guard-v1):
//             -> data/cases/pool-v1.jsonl (full), cases/pool-v1.manifest.jsonl (no text), data/cases/pool-v1-review.md
//             (owner review document, with text; stays on the dev box), data/cases/pool-v1-exclude.txt (ids the
//             calibration fit must not use)
// usage: node --experimental-strip-types scripts/build-case-pool.ts pick|build
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const sha = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const rank = (salt: string, id: string) => createHash("sha256").update(`${salt}|${id}`).digest("hex");
type Item = { id: string; text: string; group: string; split: string; source: string; source_ref: string; label_bin: number; label_orig: string | null };
const readJsonl = <T>(p: string): T[] => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : [];
const SELF = JSON.parse(readFileSync("data/cases/self-written-v1.json", "utf8")) as {
  context_changes: { pair: number; target: string; parent: { text: string; account: string }; mentions?: string[]; expected: string; rules: string[]; why: string; changes: string; target_is_op?: boolean }[];
  missing_evidence: { target: string; images?: string[]; reply_to_missing?: boolean; mentions_unknown?: boolean; expected: string; why: string; changes: string }[];
};
/** the self-written texts as stored content: a written "[@用户]" becomes a real mention so the runtime view re-derives it */
const selfText = (t: string) => t.replace(/\[@用户\]/g, "@小李");
const LABELING_SAMPLES = ["pilot-all-abuse-ids", "pilot-all-marketing-ids", "pilot-guard-ids", "pilot-ids", "pilot-abuse-ids", "pilot-abuse-holdout-ids", "pilot-marketing-ids", "pilot-marketing-holdout-ids"];

const phase = process.argv[2];
mkdirSync("data/cases", { recursive: true });
const all = readJsonl<Item>("data/eval/eval20k.jsonl");

if (phase === "pick") {
  const used = new Set(LABELING_SAMPLES.flatMap((f) => existsSync(`data/eval/${f}.txt`) ? readFileSync(`data/eval/${f}.txt`, "utf8").split("\n").filter(Boolean) : []));
  // text family: an injection item and its base share "<source>|<base ref>"; exclude whole families touched by a sample
  const fam = (it: Item) => `${it.source.replace(/\+injection$/, "")}|${it.source_ref.replace(/:inj\d+$/, "")}`;
  const usedFam = new Set(all.filter((it) => used.has(it.id)).map(fam));
  const injFam = new Set(all.filter((it) => it.group === "injection").map(fam));
  const pool = all.filter((it) => it.split === "dev" && !used.has(it.id) && !usedFam.has(fam(it)) && !injFam.has(fam(it)) && it.text.length <= 120);
  const take = (groups: string[], n: number, salt: string) => pool.filter((it) => groups.includes(it.group)).sort((a, b) => rank(salt, a.id).localeCompare(rank(salt, b.id))).slice(0, n);
  const picked = [...take(["abuse"], 30, "case-abuse"), ...take(["marketing"], 30, "case-mkt"), ...take(["everyday", "dataset_safe"], 40, "case-safe")];
  writeFileSync("data/cases/public-candidates.txt", picked.map((p) => p.id).join("\n") + "\n");
  const selfItems = [
    ...SELF.context_changes.map((c, i) => ({ id: `s-ctx-${String(i + 1).padStart(2, "0")}`, text: selfText(c.target), group: "case_context", split: "case" })),
    ...SELF.missing_evidence.map((c, i) => ({ id: `s-mis-${String(i + 1).padStart(2, "0")}`, text: selfText(c.target), group: "case_missing", split: "case" })),
  ];
  // the same target text appears twice in each context pair; label it once per id anyway (the procedure is per item)
  writeFileSync("data/cases/self-items.jsonl", selfItems.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync("data/cases/self-ids.txt", selfItems.map((r) => r.id).join("\n") + "\n");
  console.log(JSON.stringify({ pool: pool.length, picked: picked.length, byGroup: Object.fromEntries(["abuse", "marketing", "everyday", "dataset_safe"].map((g) => [g, picked.filter((p) => p.group === g).length])), selfItems: selfItems.length }));
} else if (phase === "build") {
  type Lab = { id: string; label: string; source: string; textSha?: string };
  const labels = (std: string) => new Map(readJsonl<Lab>(`data/eval/labels-${std}.jsonl`).map((r) => [r.id, r] as const));
  const L = { abuse: labels("abuse-v4.3"), marketing: labels("marketing-v2"), guard: labels("guard-v1") };
  const platform = (id: string) => ({ abuse: L.abuse.get(id) ?? null, marketing: L.marketing.get(id) ?? null, guard: L.guard.get(id) ?? null });
  const byId = new Map(all.map((it) => [it.id, it] as const));
  const cand = readFileSync("data/cases/public-candidates.txt", "utf8").split("\n").filter(Boolean).map((id) => byId.get(id)!);
  const consensus = (id: string, std: "abuse" | "marketing" | "guard", label: string) => { const l = L[std].get(id); return !!l && l.source === "consensus" && l.label === label; };
  const isAbuse = (it: Item) => consensus(it.id, "abuse", "violate") && consensus(it.id, "guard", "allow");
  const isMkt = (it: Item) => consensus(it.id, "marketing", "violate") && consensus(it.id, "abuse", "allow") && consensus(it.id, "guard", "allow");
  const isSafe = (it: Item) => consensus(it.id, "abuse", "allow") && consensus(it.id, "marketing", "allow") && consensus(it.id, "guard", "allow");
  const abuse = cand.filter(isAbuse), mkt = cand.filter(isMkt), safe = cand.filter(isSafe);
  const need = { abuse: 12, mkt: 11, safe: 17 };
  if (abuse.length < need.abuse || mkt.length < need.mkt || safe.length < need.safe) throw new Error(`not enough consensus candidates: abuse ${abuse.length}/${need.abuse}, marketing ${mkt.length}/${need.mkt}, safe ${safe.length}/${need.safe}`);
  const caseId = (kind: string, key: string) => "c" + createHash("sha256").update(`case-pool-v1|${kind}|${key}`).digest("hex").slice(0, 11);
  type Case = Record<string, unknown>;
  const cases: Case[] = [];
  const boundary = { thread: "回复链、直接回复、被 @ 账号在本线程的发言、同线程前后各 3 条（审次创建时为止）", history: "账号近 7 天的处置计数、最近裁决、申诉次数", images: "无图片通道" };
  // 1) context changes the conclusion (self-written pairs)
  SELF.context_changes.forEach((c, i) => {
    const sid = `s-ctx-${String(i + 1).padStart(2, "0")}`;
    cases.push({
      case_id: caseId("context", sid), kind: "context_changes", pair: c.pair, source: "self", self_id: sid,
      target: { text: selfText(c.target), account: c.target_is_op ? c.parent.account : `a-t${i + 1}`, mentions: c.mentions ?? [], images: [] },
      thread: [{ ref: "parent", text: c.parent.text, account: c.parent.account, offset_min: 30 }],
      reply_to: "parent", history: [],
      expected: { disposition: c.expected, rules: c.rules, why: c.why, source: "self-written (Claude, owner-delegated 2026-10-08)" },
      changes: c.changes, evidence_boundary: boundary, platform_target_only: platform(sid),
    });
  });
  // 2) evidence really missing (self-written; expected human)
  SELF.missing_evidence.forEach((c, i) => {
    const sid = `s-mis-${String(i + 1).padStart(2, "0")}`;
    cases.push({
      case_id: caseId("missing", sid), kind: "missing_evidence", source: "self", self_id: sid,
      target: { text: selfText(c.target), account: `a-m${i + 1}`, mentions: c.mentions_unknown ? ["a-xiaoli"] : [], images: c.images ?? [] },
      thread: [], reply_to: c.reply_to_missing ? "deleted-parent" : null, history: [],
      expected: { disposition: c.expected, rules: [], why: c.why, source: "self-written (Claude, owner-delegated 2026-10-08)" },
      changes: c.changes, evidence_boundary: { ...boundary, note: c.reply_to_missing ? "父评论已删除：回复链取不到" : c.images ? "内容依赖图片" : "证据在站外或需要核实" }, platform_target_only: platform(sid),
    });
  });
  // 3) history is a decoy: clean text + heavy prior takedowns -> pass; violating text + long clean history -> act
  const badHistory = Array.from({ length: 4 }, (_, k) => ({ kind: "prior_ruling", payload: { action: "takedown", rule_ids: ["ABUSE-001"] }, offset_days: 1 + k }));
  const goodHistory = Array.from({ length: 6 }, (_, k) => ({ kind: "post", payload: { note: "normal post" }, offset_days: k }));
  const actionOf = (std: "abuse" | "marketing") => (std === "abuse" ? { disposition: "takedown", rules: ["ABUSE-001"] } : { disposition: "limit", rules: ["MARKETING-003"] });
  const pub = (kind: string, it: Item, expected: { disposition: string; rules: string[] }, history: unknown[], why: string, changes: string) => cases.push({
    case_id: caseId(kind, it.id), kind, source: "public", eval_id: it.id, dataset: it.source, original_label: { label_bin: it.label_bin, label_orig: it.label_orig },
    target: { text: it.text, account: `a-${kind.slice(0, 3)}-${it.id.slice(1, 7)}`, mentions: [], images: [] }, thread: [], reply_to: null, history,
    expected: { ...expected, why, source: "platform labels (frozen procedure: model consensus)" }, changes, evidence_boundary: boundary, platform_target_only: platform(it.id),
  });
  safe.slice(0, 10).forEach((it) => pub("history_decoy", it, { disposition: "pass", rules: [] }, badHistory, "内容本身不违规；账号近期有 4 次辱骂下架记录，不能据此处置这条", "内容本身违规时，历史才是加重因素"));
  abuse.slice(0, 5).forEach((it) => pub("history_decoy", it, actionOf("abuse"), goodHistory, "内容本身违规；账号历史良好不能作为放行理由", "内容不违规"));
  mkt.slice(0, 5).forEach((it) => pub("history_decoy", it, actionOf("marketing"), goodHistory, "内容本身是引流广告；账号历史良好不能作为放行理由", "内容不违规"));
  // 4) controls
  abuse.slice(5, 12).forEach((it) => pub("control", it, actionOf("abuse"), [], "明确辱骂，无上下文", "—"));
  mkt.slice(5, 11).forEach((it) => pub("control", it, actionOf("marketing"), [], "明确引流广告，无上下文", "—"));
  safe.slice(10, 17).forEach((it) => pub("control", it, { disposition: "pass", rules: [] }, [], "正常内容，无上下文", "—"));
  // write
  writeFileSync("data/cases/pool-v1.jsonl", cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  mkdirSync("cases", { recursive: true });
  const strip = (c: Case) => {
    const t = c.target as { text: string; account: string; mentions: string[]; images: string[] };
    const th = c.thread as { ref: string; text: string; account: string; offset_min: number }[];
    return { case_id: c.case_id, kind: c.kind, pair: c.pair ?? null, source: c.source, eval_id: c.eval_id ?? null, dataset: c.dataset ?? null, original_label: c.original_label ?? null,
      target: { text_sha: sha(t.text), account: t.account, mentions: t.mentions, images: t.images.length }, thread: th.map((x) => ({ ref: x.ref, text_sha: sha(x.text), account: x.account, offset_min: x.offset_min })),
      reply_to: c.reply_to, history: c.history, expected: c.expected, platform_target_only: Object.fromEntries(Object.entries(c.platform_target_only as Record<string, Lab | null>).map(([k, v]) => [k, v ? { label: v.label, source: v.source } : null])) };
  };
  writeFileSync("cases/pool-v1.manifest.jsonl", cases.map((c) => JSON.stringify(strip(c))).join("\n") + "\n");
  writeFileSync("data/cases/pool-v1-exclude.txt", cases.filter((c) => c.eval_id).map((c) => c.eval_id).join("\n") + "\n");
  // review document (with text; dev box only)
  const zh: Record<string, string> = { violate: "违规", allow: "允许", uncertain: "不确定" };
  const lab = (l: Lab | null) => (l ? `${zh[l.label] ?? l.label}（${l.source}）` : "—");
  let doc = `# 案例池 v1 审阅稿（${cases.length} 条，含原文，只放开发机，不提交）\n\n每条：内容与上下文、账号历史、证据边界、可能改变结论的事实、预期处置与理由、标签来源。"只看本条"的平台标签是用冻结标注流程只看目标文本得到的，用来对照上下文的作用。\n\n`;
  for (const c of cases) {
    const t = c.target as { text: string; account: string; mentions: string[]; images: string[] };
    const e = c.expected as { disposition: string; rules: string[]; why: string; source: string };
    const p = c.platform_target_only as Record<string, Lab | null>;
    doc += `## ${c.case_id}（${c.kind}${c.pair ? ` · 第 ${c.pair} 对` : ""}，${c.source === "self" ? "自写" : `公开 ${c.dataset}`}）\n\n`;
    for (const x of c.thread as { text: string; account: string; offset_min: number }[]) doc += `- 父评论（${x.account}，${x.offset_min} 分钟前）：${x.text}\n`;
    if (c.reply_to === "deleted-parent") doc += `- 父评论：已删除\n`;
    doc += `- **目标**（${t.account}${t.mentions.length ? `，@ ${t.mentions.join("、")}` : ""}${t.images.length ? `，带 ${t.images.length} 张图` : ""}）：${t.text}\n`;
    if ((c.history as unknown[]).length) doc += `- 账号历史：${JSON.stringify(c.history)}\n`;
    doc += `- 证据边界：${JSON.stringify(c.evidence_boundary)}\n- 可能改变结论的事实：${c.changes}\n- **预期**：${e.disposition}${e.rules.length ? `（${e.rules.join("、")}）` : ""}；${e.why}\n- 标签来源：${e.source}${c.original_label ? `；数据集原标签 ${JSON.stringify(c.original_label)}` : ""}\n- 只看本条的平台标签：辱骂 ${lab(p.abuse ?? null)}，营销 ${lab(p.marketing ?? null)}，注入检查 ${lab(p.guard ?? null)}\n\n`;
  }
  writeFileSync("data/cases/pool-v1-review.md", doc);
  const count = (k: string) => cases.filter((c) => c.kind === k).length;
  console.log(JSON.stringify({ cases: cases.length, kinds: Object.fromEntries(["context_changes", "missing_evidence", "history_decoy", "control"].map((k) => [k, count(k)])), expected: cases.reduce((m: Record<string, number>, c) => { const d = (c.expected as { disposition: string }).disposition; m[d] = (m[d] ?? 0) + 1; return m; }, {}) }));
} else {
  throw new Error("usage: build-case-pool.ts pick|build");
}
