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
export type CorpusItem = { id: string; kind: CorpusKind; text: string; primary: Dists; copy: Dists };
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
    items.push({ id: r.id, kind: r.kind as CorpusKind, text: r.text, primary: r.primary, copy: r.copy ?? {} });
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
