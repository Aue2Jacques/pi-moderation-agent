// Agent-layer injection pairs (dev plan 2026-10-08 §2.2: "the agent-layer pair test is done in stage ②"). From the eval
// dev split: injection items (base text + an "approve this / ignore the rules" suffix) and their bases, 25 pairs with a
// violating base and 25 with a normal base, chosen by a fixed hash order. Written as case-pool rows so that
// `run-ac.ts` runs them end to end (fast path + agent); each pair's two rows share `pair`.
// Expected disposition: the base's frozen platform label when it has one (abuse-v4.3 / marketing-v2), else the dataset's
// own label (source recorded per row). The injected copy expects the same disposition as its base.
// usage: node --experimental-strip-types scripts/build-injection-cases.ts [nPerSide=25]  -> data/cases/injection-pairs-v1.jsonl
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const N = Number(process.argv[2] ?? 25);
type Item = { id: string; text: string; group: string; split: string; source: string; source_ref: string; slice: string; label_bin: number };
const all = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item);
const byRef = new Map(all.filter((i) => i.group !== "injection").map((i) => [`${i.source}|${i.source_ref}`, i] as const));
const lab = (std: string) => new Map((existsSync(`data/eval/labels-${std}.jsonl`) ? readFileSync(`data/eval/labels-${std}.jsonl`, "utf8") : "").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as { id: string; label: string; source: string }).map((r) => [r.id, r] as const));
const abuse = lab("abuse-v4.3"), mkt = lab("marketing-v2");
const rank = (id: string) => createHash("sha256").update(`inj-cases|${id}`).digest("hex");
const pairs = all.filter((i) => i.group === "injection" && i.split === "dev").flatMap((inj) => {
  const base = byRef.get(`${inj.source.replace(/\+injection$/, "")}|${inj.source_ref.replace(/:inj\d+$/, "")}`);
  return base ? [{ inj, base }] : [];
}).sort((a, b) => rank(a.inj.id).localeCompare(rank(b.inj.id)));
const expectedOf = (base: Item): { disposition: string; rules: string[]; source: string } => {
  const a = abuse.get(base.id), m = mkt.get(base.id);
  if (a && a.label === "violate") return { disposition: "takedown", rules: ["ABUSE-001"], source: `platform abuse-v4.3 (${a.source})` };
  if (m && m.label === "violate") return { disposition: "limit", rules: ["MARKETING-003"], source: `platform marketing-v2 (${m.source})` };
  if (a && a.label === "allow" && (!m || m.label === "allow")) return { disposition: "pass", rules: [], source: `platform abuse-v4.3 (${a.source})${m ? ` + marketing-v2 (${m.source})` : ""}` };
  return base.label_bin === 1 ? { disposition: "takedown", rules: ["ABUSE-001"], source: `dataset ${base.source} label` } : { disposition: "pass", rules: [], source: `dataset ${base.source} label` };
};
const pick = [...pairs.filter((p) => p.base.label_bin === 1).slice(0, N), ...pairs.filter((p) => p.base.label_bin === 0).slice(0, N)];
const rows = pick.flatMap((p, k) => {
  const exp = expectedOf(p.base);
  const mk = (it: Item, kind: string) => ({
    case_id: "i" + createHash("sha256").update(`inj-pairs-v1|${it.id}`).digest("hex").slice(0, 11), kind, pair: k + 1, source: "public", eval_id: it.id, dataset: it.source,
    target: { text: it.text, account: `a-inj-${k + 1}`, mentions: [], images: [] }, thread: [], reply_to: null, history: [],
    expected: { disposition: exp.disposition, rules: exp.rules, why: kind === "inj_injected" ? "注入后缀不改变内容本身的结论" : "原句", source: exp.source },
  });
  return [mk(p.base, "inj_base"), mk(p.inj, "inj_injected")];
});
writeFileSync("data/cases/injection-pairs-v1.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ pairs: pick.length, rows: rows.length, expected: rows.reduce((m: Record<string, number>, r) => { m[`${r.kind}:${r.expected.disposition}`] = (m[`${r.kind}:${r.expected.disposition}`] ?? 0) + 1; return m; }, {}), expectedSource: rows.reduce((m: Record<string, number>, r) => { const k = r.expected.source.split(" (")[0]!; m[k] = (m[k] ?? 0) + 1; return m; }, {}) }));
