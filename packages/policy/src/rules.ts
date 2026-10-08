// Policy bundle loading: rules/*.yaml + config/scenes.yaml → core PolicyBundle. docs §10.
// Bundle version = sha256 over the sorted file names and contents (rules dir + scenes.yaml), so any edit to either changes rules_ver.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { questionSha, sha256, type Action, type PolicyBundle, type Question, type Rule, type Scene, type SceneConfig } from "@mod/core";

export type RuleYaml = {
  rule_id: string; version: number; category: string; scenes: Scene[]; severity: number;
  default_action: "limit" | "takedown"; text: string;
  exceptions?: { id: string; text: string; question: QuestionYaml }[];
  question: QuestionYaml;
  thresholds: { block: number; pass: number; keyed_by_option_count?: boolean };
  contract_tests?: ContractTestYaml[];
};
export type QuestionYaml = { id: string; instructions: string; options: Record<string, string>; violation_option: string; pass_choices?: string[]; applies_choice?: string; not_applies_choice?: string };
export type ContractTestYaml = { id: string; kind: string; ref: string; expect: "violate" | "pass" | "release"; required?: boolean };

export type ScenesYaml = Record<Scene, {
  required_categories: string[]; allowed_actions: Action[]; pending_visibility: "visible" | "self_only" | "hidden";
  deadline_ms: number; human_sla_ms: number; default_severity: number;
  image_check: { thresholds: { block: number; pass: number }; question: QuestionYaml };
}>;

/**
 * The text a judge sees = the YAML question + the definition it must apply (rule text with its exclusions; for an
 * exception, the exception text and the rule it belongs to). Without the definition the judge only sees a one-line
 * question and cannot know the rule's boundaries (round-9 follow-up, 2026-10-09). The sha covers the full text, so
 * editing a rule's definition changes its question sha and invalidates recorded fixtures and calibration buckets.
 */
export function composeInstructions(q: QuestionYaml, definition?: { rule?: string; exception?: string }): string {
  const parts = [q.instructions];
  if (definition?.rule) parts.push(`规则定义：${definition.rule}`);
  if (definition?.exception) parts.push(`例外定义：${definition.exception}`);
  return parts.join("\n");
}

function toQuestion(kind: Question["kind"], q: QuestionYaml, ruleId?: string, exceptionId?: string, definition?: { rule?: string; exception?: string }): Question {
  if (q.pass_choices?.includes("unknown")) throw new Error(`question ${q.id}: unknown can never be a pass choice`);
  if (!(q.violation_option in q.options)) throw new Error(`question ${q.id}: violation_option not in options`);
  const instructions = composeInstructions(q, definition);
  return {
    sha: questionSha({ kind, ...(ruleId ? { rule_id: ruleId } : {}), ...(exceptionId ? { exception_id: exceptionId } : {}), instructions, criteria: q.options }),
    key: kind === "image_check" ? "image_check" : exceptionId ? `${ruleId}.${exceptionId}` : ruleId!,
    kind,
    instructions,
    criteria: q.options,
    ...(ruleId ? { ruleId } : {}),
    ...(exceptionId ? { exceptionId } : {}),
    violationOption: q.violation_option,
    passChoices: q.pass_choices ?? [],
    ...(q.applies_choice ? { appliesChoice: q.applies_choice } : {}),
    ...(q.not_applies_choice ? { notAppliesChoice: q.not_applies_choice } : {}),
  };
}

export function ruleFromYaml(y: RuleYaml): Rule {
  if (!(y.thresholds.pass < y.thresholds.block)) throw new Error(`rule ${y.rule_id}: pass threshold must be below block threshold`);
  return {
    ruleId: y.rule_id, category: y.category, scenes: y.scenes, severity: y.severity, defaultAction: y.default_action,
    thresholds: { block: y.thresholds.block, pass: y.thresholds.pass },
    question: toQuestion("rule", y.question, y.rule_id, undefined, { rule: y.text }),
    exceptions: (y.exceptions ?? []).map((x) => ({ id: x.id, question: toQuestion("exception", x.question, y.rule_id, x.id, { rule: y.text, exception: x.text }) })),
  };
}

export function sceneFromYaml(y: ScenesYaml[Scene]): SceneConfig {
  return {
    requiredCategories: y.required_categories, allowedActions: y.allowed_actions, pendingVisibility: y.pending_visibility,
    deadlineMs: y.deadline_ms, humanSlaMs: y.human_sla_ms, defaultSeverity: y.default_severity,
    imageCheck: { thresholds: y.image_check.thresholds, question: toQuestion("image_check", y.image_check.question) },
  };
}

export type LoadedBundle = { bundle: PolicyBundle; contractTests: Record<string, ContractTestYaml[]>; texts: Record<string, string> };

export function loadBundle(rulesDir: string, scenesFile: string): LoadedBundle {
  const files = readdirSync(rulesDir).filter((f) => /^[A-Z]+-\d+\.yaml$/.test(f)).sort();   // rule files only (mapping.yaml, wordlist.yaml are not rules)
  const parts: string[] = [];
  const rules: Rule[] = [];
  const contractTests: Record<string, ContractTestYaml[]> = {};
  const texts: Record<string, string> = {};
  for (const f of files) {
    const raw = readFileSync(join(rulesDir, f), "utf8");
    parts.push(`${f}\n${raw}`);
    const y = parse(raw) as RuleYaml;
    rules.push(ruleFromYaml(y));
    contractTests[y.rule_id] = y.contract_tests ?? [];
    texts[y.rule_id] = y.text;
  }
  const scenesRaw = readFileSync(scenesFile, "utf8");
  parts.push(`scenes.yaml\n${scenesRaw}`);
  const scenesY = parse(scenesRaw) as ScenesYaml;
  const scenes = Object.fromEntries(Object.entries(scenesY).map(([k, v]) => [k, sceneFromYaml(v)])) as Record<Scene, SceneConfig>;
  const rulesVer = `rules@${sha256(parts.join("\n---\n")).slice(0, 12)}`;
  return { bundle: { rulesVer, rules, scenes }, contractTests, texts };
}
