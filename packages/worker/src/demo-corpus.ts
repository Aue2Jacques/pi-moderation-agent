// Demo corpus (DEMO_CORPUS, demo mode only): real test-split texts with the raw answers a real judge gave them in an
// evaluation run (scripts/make-demo-corpus.py). The demo traffic draws its contents from it, and the demo judge replays
// the recorded answers for a text it finds here, so the fast path, calibration and policy run on real model output; texts
// it does not know (hand-written submissions, the scripted context kinds) keep the scripted scores. The corpus file holds
// dataset text: it lives on the server that runs the demo and is never committed.
import { readFileSync } from "node:fs";
import * as core from "@mod/core";
import type { Question } from "@mod/core";
import type { JudgeAnswers } from "./judge-client.ts";

export type CorpusKind = "normal" | "marketing" | "abuse" | "injection";
type Dists = Record<string, Record<string, number>>;
export type CorpusItem = { id: string; kind: CorpusKind; slice: string; text: string; primary: Dists; copy: Dists };
export type DemoCorpus = {
  path: string;
  /** the judge run whose answers are replayed (DEMO_CORPUS_JUDGE), e.g. kev4b-v1 */
  judge: string;
  items: readonly CorpusItem[];
  byKind: Readonly<Record<CorpusKind, readonly CorpusItem[]>>;
  /** the recorded item for a text, matched on the model view (what the judge request carries) */
  lookup(text: string): CorpusItem | undefined;
};

const KINDS: readonly CorpusKind[] = ["normal", "marketing", "abuse", "injection"];

export function loadDemoCorpus(path: string, judge: string): DemoCorpus {
  const items: CorpusItem[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as Partial<CorpusItem>;
    if (!r.id || !r.text || !r.primary || !KINDS.includes(r.kind as CorpusKind)) throw new Error(`demo corpus ${path}: malformed line`);
    items.push({ id: r.id, kind: r.kind as CorpusKind, slice: r.slice ?? r.kind!, text: r.text, primary: r.primary, copy: r.copy ?? {} });
  }
  if (!items.length) throw new Error(`demo corpus ${path} is empty`);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, items.filter((x) => x.kind === k)])) as Record<CorpusKind, CorpusItem[]>;
  const byView = new Map(items.map((x) => [core.modelView(x.text), x]));
  return { path, judge, items, byKind, lookup: (text) => byView.get(core.modelView(text)) };
}

/** The recorded answer to one question: the stored distribution under its question key (ABUSE-001, injection_guard, ...);
 *  undefined when the run did not ask it (exceptions, image check). */
export function corpusAnswer(q: Question, d: Dists): JudgeAnswers[string] | undefined {
  const probs = d[core.questionKey(q)];
  if (!probs || !Object.keys(probs).every((k) => k in q.criteria)) return undefined;
  const choice = Object.entries(probs).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  return { choice, probs: { ...probs } };
}

/**
 * Demo agent's evidence call on a corpus text (DEMO_CORPUS_HUMAN_PCT): the replayed run saw no evidence, so an evidence
 * call there would only repeat the middle-band score and every agent review would end with a person. Demo mode instead
 * answers it from the dataset's own label (the slice the text came from), confidently, except for a fixed share of items
 * (by id) that keep the recorded score and so still reach a person. This is a stand-in for an agent that resolves most
 * cases with evidence; it is not a measurement of any agent.
 */
export function corpusAgentAnswer(q: Question, item: CorpusItem, humanPct: number): JudgeAnswers[string] | undefined {
  if (bucketOf(item.id) < humanPct) return undefined;
  const key = core.questionKey(q);
  if (q.kind !== "rule" || !(key in item.primary)) return undefined;   // the guard and exceptions keep the recorded answers
  const violates = item.kind === "abuse" ? key.startsWith("ABUSE")
    : item.kind === "marketing" ? key.startsWith("MARKETING")
    : item.kind === "injection" && item.slice.endsWith("violating") ? key === topRule(item)
    : false;
  const probs = violates ? { violate: 0.999, none: 0.0009, unknown: 0.0001 } : { violate: 0.0005, none: 0.9994, unknown: 0.0001 };
  if (!Object.keys(probs).every((k) => k in q.criteria)) return undefined;
  return { choice: violates ? "violate" : "none", probs };
}

/** the rule the recorded run found most likely violated (an injected text's underlying violation) */
function topRule(item: CorpusItem): string {
  const rules = Object.entries(item.primary).filter(([k]) => k !== "injection_guard");
  return rules.reduce((a, b) => ((b[1]["violate"] ?? 0) > (a[1]["violate"] ?? 0) ? b : a), rules[0] ?? ["", {}])[0];
}

/** a stable 0..99 bucket per item id */
function bucketOf(id: string): number {
  return parseInt(core.sha256(id).slice(0, 8), 16) % 100;
}
