// Contract-fixture plumbing shared by record-contract.ts, fixtures-check.ts and contract.ts (round-9 item 9).
// A fixture is the real judge's recorded answer to one pre-registered self-written sentence (fixtures/refs.yaml).
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import * as core from "../../packages/core/src/index.ts";
import type { PolicyBundle, Question, Scene } from "../../packages/core/src/index.ts";

export type RefEntry = { source: string; index: number; scene: Scene; required: boolean };
export type Refs = Record<string, RefEntry>;

export type FixtureAnswers = Record<string, { choice: string; probs: Record<string, number> }>;
export type Fixture = {
  ref: string; scene: Scene; source: string; index: number;
  /** sha256 of the sentence at record time: a changed sentence makes the fixture stale */
  text_sha: string;
  recorded_at: string;
  judge: { provider: string; api: string; model: string };
  rules_ver: string;
  /** question key (RULE/kind[/EXC]) → sha at record time: a changed question makes the fixture stale */
  questions: Record<string, string>;
  primary: FixtureAnswers;
  variant: { seed: number; answers: FixtureAnswers } | null;
  latency_ms: number;
  usage: { input: number; output: number };
};

export const REFS_FILE = "fixtures/refs.yaml";
export const fixturePath = (ref: string): string => `fixtures/contract/${ref.replace(/\//g, "_")}.json`;

export function loadRefs(): Refs {
  return (parse(readFileSync(REFS_FILE, "utf8")) as { refs: Refs }).refs;
}

export function sentence(e: RefEntry): string {
  const all = JSON.parse(readFileSync("fixtures/benign/sentences.json", "utf8")) as Record<string, unknown>;
  const list = all[e.source] as [string, string][] | undefined;
  const row = list?.[e.index];
  if (!row) throw new Error(`sentence ${e.source}[${e.index}] not found`);
  return row[0];
}

export const questionKey = (q: Question): string => [q.ruleId ?? "scene", q.kind, q.exceptionId].filter(Boolean).join("/");

/** Exactly the questions the fast path asks for this scene. */
/** Exactly what the fast path asks in a scene: rule and exception questions, plus the injection guard when configured. */
export function sceneQuestions(bundle: PolicyBundle, scene: Scene): Question[] {
  const guard = bundle.scenes[scene].injectionGuard;
  return [...core.rulesFor(bundle, scene).flatMap((r) => [r.question, ...r.exceptions.map((x) => x.question)]), ...(guard ? [guard.question] : [])];
}

export function readFixture(ref: string): Fixture | undefined {
  const p = fixturePath(ref);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Fixture) : undefined;
}

/** Why a fixture cannot be used against the current bundle/sentences; empty when it is usable. */
export function staleReasons(f: Fixture, e: RefEntry, bundle: PolicyBundle): string[] {
  const out: string[] = [];
  if (f.scene !== e.scene) out.push(`scene ${f.scene} ≠ ${e.scene}`);
  if (f.text_sha !== core.sha256(sentence(e))) out.push("sentence changed since recording");
  for (const q of sceneQuestions(bundle, e.scene)) {
    const k = questionKey(q);
    if (f.questions[k] !== q.sha) out.push(`question ${k} changed since recording`);
    if (!f.primary[q.sha]) out.push(`no recorded answer for ${k}`);
  }
  return out;
}
