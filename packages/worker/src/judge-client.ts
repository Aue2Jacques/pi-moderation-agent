// Judge client used by the judge/confirm tools. Phase 2 uses a recorded client; phase 3 plugs in pi-ai classify().
import type { Question } from "@mod/core";

export type JudgeRequest = {
  contentId: string;
  text: string | null;
  scene: string;
  evidence: { evidenceId: string; kind: string; modelView: unknown }[];
  questions: Question[];
  shuffleSeed?: number;
};

export type JudgeAnswers = Record<string, { choice: string; probs: Record<string, number> }>;

export type JudgeResponse =
  | {
      status: "ok"; model: string; answers: JudgeAnswers; usage: { input: number; output: number }; latencyMs: number;
      /** in-call confirmation copy (shuffled options), recorded as a second judge_call that confirms the primary */
      variant?: { shuffleSeed: number; answers: JudgeAnswers };
    }
  | { status: "timeout" | "error" | "abstain"; model: string; latencyMs: number };

export interface JudgeClient {
  readonly provider: string;
  readonly api: string;
  classify(req: JudgeRequest): Promise<JudgeResponse>;
}

/** Scripted answers keyed by content id; `answer(req)` may inspect evidence to return different probabilities. */
export function recordedJudge(script: (req: JudgeRequest) => JudgeResponse | Promise<JudgeResponse>, model = "jev-recorded"): JudgeClient {
  return { provider: "recorded", api: "recorded", classify: async (req) => ({ ...(await script(req)), model }) as JudgeResponse };
}

/** Helper for scripts: answer every question with the same violation probability and a choice. */
export function uniform(questions: Question[], p: number, choice?: string): JudgeAnswers {
  const out: JudgeAnswers = {};
  for (const q of questions) {
    const c = choice ?? (q.kind === "exception" ? (p >= 0.5 ? (q.appliesChoice ?? "applies") : (q.notAppliesChoice ?? "not_applies")) : p >= 0.5 ? q.violationOption : (q.passChoices[0] ?? "none"));
    out[q.sha] = { choice: c, probs: { [q.violationOption]: p, [c === q.violationOption ? "none" : c]: 1 - p } };
  }
  return out;
}
