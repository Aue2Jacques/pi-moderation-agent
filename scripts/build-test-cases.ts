// Stage ④ end-to-end evaluation input (dev plan 2026-10-08 §6): the frozen test split as case rows for run-ac.ts, so the
// whole system (fast path + agent) runs on it. Expected disposition from the platform conclusion of each item:
// abuse violate -> takedown (ABUSE-001), else marketing violate -> limit (MARKETING-003), both allow -> pass, anything
// else (a standard uncertain or not fully answered) -> human. Standalone items: no thread, no history.
// usage: node --experimental-strip-types scripts/build-test-cases.ts  -> data/cases/test-v1-e2e.jsonl
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const test = new Set(readFileSync("data/eval/split-v1.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; split: string }).filter((r) => r.split === "test").map((r) => r.id));
const lab = (std: string) => new Map(readFileSync(`data/eval/labels-${std}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; label: string; source: string }).map((r) => [r.id, r] as const));
const A = lab("abuse-v4.3"), M = lab("marketing-v2");
const rows = readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; text: string; group: string; source: string; label_bin: number; label_orig: string | null })
  .filter((x) => test.has(x.id)).map((it) => {
    const a = A.get(it.id), m = M.get(it.id);
    const exp = a?.label === "violate" ? { disposition: "takedown", rules: ["ABUSE-001"] }
      : m?.label === "violate" ? { disposition: "limit", rules: ["MARKETING-003"] }
        : a?.label === "allow" && m?.label === "allow" ? { disposition: "pass", rules: [] as string[] } : { disposition: "human", rules: [] as string[] };
    return { case_id: "t" + createHash("sha256").update(`test-v1-e2e|${it.id}`).digest("hex").slice(0, 11), kind: it.group, source: "public", eval_id: it.id, dataset: it.source,
      original_label: { label_bin: it.label_bin, label_orig: it.label_orig },
      target: { text: it.text, account: `a-t-${it.id.slice(1, 7)}`, mentions: [], images: [] }, thread: [], reply_to: null, history: [],
      expected: { ...exp, why: "platform conclusion (frozen labeling procedure)", source: `abuse ${a?.source ?? "-"}/${a?.label ?? "-"}; marketing ${m?.source ?? "-"}/${m?.label ?? "-"}` } };
  });
writeFileSync("data/cases/test-v1-e2e.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const c: Record<string, number> = {};
for (const r of rows) c[r.expected.disposition] = (c[r.expected.disposition] ?? 0) + 1;
console.log(JSON.stringify({ rows: rows.length, expected: c }));
