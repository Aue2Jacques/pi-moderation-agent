// Training records for an open judge (Kev `kev.train --data`), built exactly as the fast path asks Jev: the same state
// shape and the same questions (packages/worker/src/pi-judge.ts, buildQuestions), main view `text`. Only the two rule
// questions (ABUSE-001, MARKETING-003); the injection guard has no platform labels outside test.
// Label per question, in order: the platform label (frozen procedure) when it is violate / allow; else the unified
// source label (data/eval/source-labels-v1.jsonl) unless its basis is "boundary"; a platform "uncertain" or a boundary
// item without a platform label drops that question; items of <= 3 characters are skipped. Writes the records (they
// carry dataset text: servers only, never committed) and a manifest with counts per label source.
// EXCLUDE=<file>[,<file>]: ids to leave out (a .txt of ids or a .jsonl with an `id` field), e.g. the calibration rows
// data/calib/platform-input.jsonl, so the judge is not calibrated on items it was trained on.
// usage: [EXCLUDE=...] node --experimental-strip-types scripts/export-kev-train.ts <split=train|val> <out.jsonl> [limit]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as core from "../packages/core/src/index.ts";
import { buildQuestions, wireKey } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";

const [split, out, limitArg] = process.argv.slice(2);
if ((split !== "train" && split !== "val") || !out) throw new Error("usage: export-kev-train.ts train|val <out.jsonl> [limit]");
const jsonl = <T>(p: string): T[] => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);
const sha = (t: string | Buffer) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const { bundle } = loadBundle("rules", "config/scenes.yaml");
const rules = ["ABUSE-001", "MARKETING-003"].map((id) => bundle.rules.find((r) => r.ruleId === id)!);
const { questions: wire } = buildQuestions(rules.map((r) => r.question), false);
const ids = new Set(jsonl<{ id: string; split: string }>("data/eval/split-v1.jsonl").filter((r) => r.split === split).map((r) => r.id));
const exclude = new Set((process.env.EXCLUDE ?? "").split(",").filter(Boolean).flatMap((f) => f.endsWith(".jsonl") ? jsonl<{ id: string }>(f).map((r) => r.id) : readFileSync(f, "utf8").split(/\s+/).filter(Boolean)));
const items = jsonl<{ id: string; text: string; text_strip: string }>("data/eval/eval20k.jsonl").filter((x) => ids.has(x.id));
const src = new Map(jsonl<{ id: string; cat: string; basis: string; short: boolean }>("data/eval/source-labels-v1.jsonl").map((r) => [r.id, r] as const));
const lab = (std: string) => new Map(jsonl<{ id: string; label: string }>(`data/eval/labels-${std}.jsonl`).map((r) => [r.id, r.label] as const));
const platform: Record<string, Map<string, string>> = { "ABUSE-001": lab("abuse-v4.3"), "MARKETING-003": lab("marketing-v2") };
const catOf: Record<string, string> = { "ABUSE-001": "ABUSE", "MARKETING-003": "MARKETING" };

const counts: Record<string, number> = {};
const bump = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
const lines: string[] = [];
for (const it of items) {
  if (exclude.has(it.id)) { bump("skip:excluded"); continue; }
  const s = src.get(it.id);
  if (!s) throw new Error(`no source label for ${it.id}`);
  if (s.short) { bump("skip:short"); continue; }
  const questions: Record<string, unknown> = {};
  for (const r of rules) {
    const key = wireKey(r.question);
    const q = wire[key];
    if (!q) throw new Error(`no wire question for ${key}`);
    const p = platform[r.ruleId]!.get(it.id);
    let label: string | undefined, from: string;
    if (p === "violate" || p === "allow") { label = p === "violate" ? r.question.violationOption : "none"; from = "platform"; }
    else if (p !== undefined) { from = "platform_uncertain"; }
    else if (s.basis === "boundary") { from = "boundary_unlabelled"; }
    else { label = s.cat === catOf[r.ruleId] ? r.question.violationOption : "none"; from = `source:${s.basis}`; }
    bump(`${r.ruleId}:${from}${label ? `:${label}` : ":dropped"}`);
    if (label) questions[key] = { ...(q as object), label };
  }
  if (!Object.keys(questions).length) { bump("skip:no_question"); continue; }
  lines.push(JSON.stringify({ state: { content: { text: it.text, scene: "comment" }, evidence: [] }, questions, _meta: { id: it.id } }));
  if (limitArg && lines.length >= Number(limitArg)) break;
}
writeFileSync(out, lines.join("\n") + "\n");
const manifest = { split, out, records: lines.length, exclude: process.env.EXCLUDE ?? "", excluded: exclude.size, rulesVer: bundle.rulesVer, sourceMap: "source-label-map-v1", outputSha: sha(readFileSync(out)), counts };
writeFileSync(`${out}.manifest.json`, JSON.stringify(manifest, null, 1));
console.log(JSON.stringify(manifest, null, 1));
