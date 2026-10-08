// Calibration input from the platform's model-assisted labels (dev plan 2026-10-08 §0.1 decision 2): replaces the
// public-label input of scripts/build-calib-input.py. Reads data/eval/labels-<standard>.jsonl written by
// `label-pilot.ts adjudicate` for every frozen standard, maps each standard to the runtime question it labels, and writes
// data/calib/platform-input.jsonl ({id, text, labels}) for `fit-calib.ts collect`. Prints counts only.
// - text is the eval model view (what the runtime judge sees, E5)
// - violate -> 1, allow -> 0; "uncertain" is left out of the fit for that question (it is not a "no")
// - rows whose label was computed on another text (textSha in the label rows, E5) are skipped
// - ids in the exclude files (the case pool and its text families) never enter the fit
// usage: node --experimental-strip-types scripts/build-calib-platform.ts [exclude.txt ...]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FROZEN } from "./lib/labeling.ts";

/** frozen standard -> runtime question key (core.questionKey) */
const KEY: Record<string, string> = { "abuse-v4.3": "ABUSE-001", "marketing-v2": "MARKETING-003", "guard-v1": "injection_guard" };
const exclude = new Set(process.argv.slice(2).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean)));
const items = new Map(readFileSync("data/eval/eval20k.jsonl", "utf8").split("\n").filter(Boolean).map((l) => {
  const r = JSON.parse(l) as { id: string; text: string; split: string; group: string };
  return [r.id, r] as const;
}));
const out = new Map<string, { id: string; text: string; labels: Record<string, number> }>();
const counts: Record<string, Record<string, number>> = {};
for (const f of FROZEN) {
  const key = KEY[f.standard];
  const file = `data/eval/labels-${f.standard}.jsonl`;
  if (!key) throw new Error(`no question key for frozen standard ${f.standard}`);
  if (!existsSync(file)) { counts[key] = { missingFile: 1 }; continue; }
  const c: Record<string, number> = (counts[key] = { violate: 0, allow: 0, uncertain: 0, excluded: 0, notDev: 0 });
  for (const l of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(l) as { id: string; label: string; promptSha: string; textSha?: string };
    const it = items.get(r.id);
    if (!it || r.promptSha !== f.promptSha) continue;
    if (r.textSha !== createHash("sha256").update(it.text).digest("hex").slice(0, 16)) { c.staleText = (c.staleText ?? 0) + 1; continue; }
    if (exclude.has(r.id)) { c.excluded = (c.excluded ?? 0) + 1; continue; }
    if (it.split !== "dev") { c.notDev = (c.notDev ?? 0) + 1; continue; }   // the test split is never used for fitting
    c[r.label] = (c[r.label] ?? 0) + 1;
    if (r.label !== "violate" && r.label !== "allow") continue;
    const row = out.get(r.id) ?? out.set(r.id, { id: r.id, text: it.text, labels: {} }).get(r.id)!;
    row.labels[key] = r.label === "violate" ? 1 : 0;
  }
}
mkdirSync("data/calib", { recursive: true });
const rows = [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
writeFileSync("data/calib/platform-input.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const sha = createHash("sha256").update(readFileSync("data/calib/platform-input.jsonl")).digest("hex").slice(0, 16);
console.log(JSON.stringify({ rows: rows.length, excludedIds: exclude.size, perQuestion: counts, fileSha: sha }));
