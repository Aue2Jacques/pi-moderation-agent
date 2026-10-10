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
/** synthetic thread context and account history (scripts/synth-context.ts corpus): the demo traffic writes them next to
 *  the comment, so the agent's get_thread_context / get_account_history find real rows */
export type CorpusThread = { parent: string; replies: string[]; relation: string };
export type CorpusHistory = { action: string; rule_ids: string[]; offset_days: number };
export type CorpusItem = { id: string; kind: CorpusKind; slice: string; text: string; primary: Dists; copy: Dists; thread?: CorpusThread; history?: CorpusHistory[] };
export type DemoCorpus = {
  path: string;
  /** the judge run whose answers are replayed (DEMO_CORPUS_JUDGE), e.g. kev4b-v1 */
  judge: string;
  items: readonly CorpusItem[];
  byKind: Readonly<Record<CorpusKind, readonly CorpusItem[]>>;
  /** items by the top of their slice: everyday, safe, hard_negative, abuse, adversarial, marketing, injection */
  bySource: Readonly<Record<string, readonly CorpusItem[]>>;
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
    items.push({ id: r.id, kind: r.kind as CorpusKind, slice: r.slice ?? r.kind!, text: r.text, primary: r.primary, copy: r.copy ?? {},
      ...(r.thread?.parent ? { thread: { parent: r.thread.parent, replies: r.thread.replies ?? [], relation: r.thread.relation ?? "" } } : {}), ...(r.history?.length ? { history: r.history } : {}) });
  }
  if (!items.length) throw new Error(`demo corpus ${path} is empty`);
  const byKind = Object.fromEntries(KINDS.map((k) => [k, items.filter((x) => x.kind === k)])) as Record<CorpusKind, CorpusItem[]>;
  const byView = new Map(items.map((x) => [core.modelView(x.text), x]));
  const bySource: Record<string, CorpusItem[]> = {};
  for (const x of items) (bySource[x.slice.split("/")[0] ?? x.kind] ??= []).push(x);
  return { path, judge, items, byKind, bySource, lookup: (text) => byView.get(core.modelView(text)) };
}

/**
 * DEMO_FAST_LINES "pass/block" (e.g. 0.2/0.8): the replayed judge's own operating point for the fast path, set on every
 * rule of the demo bundle (the agent lines are left alone); the rules version gets a suffix, so every review shows it
 * ran under the override. Measured for Kev-4B v1 on the 3,002-item test set (platform labels): 0.10/0.90 decides 61% of
 * it (2.0% violations passed, 0.3% allowed actioned), 0.20/0.80 77% (3.2% / 2.0%); on everyday comments 85% / 91%.
 */
export function withFastLines(bundle: core.PolicyBundle, spec: string): core.PolicyBundle {
  const [pass, block] = spec.split("/").map(Number);
  if (!(pass! > 0 && block! > pass! && block! < 1)) throw new Error(`DEMO_FAST_LINES must be pass/block with 0 < pass < block < 1, got ${spec}`);
  return { ...bundle, rulesVer: `${bundle.rulesVer}+lines-${pass}-${block}`, rules: bundle.rules.map((r) => ({ ...r, thresholds: { ...r.thresholds, pass: pass!, block: block! } })) };
}

/** The showcase category of a corpus item (same six as scripts/build-harness-set.py): normal, hard_negative, abuse,
 *  adversarial, marketing, injection. */
export function corpusCategory(item: CorpusItem): string {
  const top = item.slice.split("/")[0] ?? "";
  if (top === "everyday" || top === "safe") return "normal";
  return ["hard_negative", "abuse", "adversarial", "marketing", "injection"].includes(top) ? top : item.kind;
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
