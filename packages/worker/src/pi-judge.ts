// JudgeClient backed by pi-ai classify() (Jev or any registered classifier model). Phase 3a.
import type { ClassifierModel, ClassifierApi, JsonObject, Models } from "@earendil-works/pi-ai";
import { CONFIRM_SUFFIX, buildQuestions } from "@mod/judges";
import type { JudgeClient, JudgeRequest, JudgeResponse } from "./judge-client.ts";

export type PiJudgeOptions = { inCallConfirm: boolean; timeoutMs?: number; shuffleSeed?: number };

export function piJudge(models: Models, model: ClassifierModel<ClassifierApi>, o: PiJudgeOptions): JudgeClient {
  const seed = o.shuffleSeed ?? 17;
  return {
    provider: model.provider,
    api: model.api,
    classify: async (req: JudgeRequest): Promise<JudgeResponse> => {
      const t0 = Date.now();
      // an explicit confirm call (req.shuffleSeed set) sends only the shuffled copy; a primary call sends original (+ in-call copy)
      const explicitConfirm = req.shuffleSeed !== undefined;
      const questions = explicitConfirm
        ? Object.fromEntries(Object.entries(buildQuestions(req.questions, true, req.shuffleSeed)).filter(([k]) => k.endsWith(CONFIRM_SUFFIX)).map(([k, v]) => [k.slice(0, -CONFIRM_SUFFIX.length), v]))
        : buildQuestions(req.questions, o.inCallConfirm, seed);
      const state = JSON.parse(JSON.stringify({ content: { text: req.text, scene: req.scene }, evidence: req.evidence.map((e) => ({ evidence_id: e.evidenceId, kind: e.kind, untrusted: true, model_view: e.modelView })) })) as JsonObject;
      const result = await models.classify(model, { state, questions }, { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
      const latencyMs = Date.now() - t0;
      if (result.stopReason !== "stop") {
        const timeout = /timed out/i.test(result.errorMessage ?? "");
        return { status: timeout ? "timeout" : "error", model: result.model, latencyMs };
      }
      const answers: NonNullable<Extract<JudgeResponse, { status: "ok" }>["answers"]> = {};
      const variant: typeof answers = {};
      for (const [key, a] of Object.entries(result.answers)) {
        if (a.type !== "choice") continue;
        if (key.endsWith(CONFIRM_SUFFIX)) variant[key.slice(0, -CONFIRM_SUFFIX.length)] = { choice: a.choice, probs: a.probabilities };
        else answers[key] = { choice: a.choice, probs: a.probabilities };
      }
      const usage = { input: result.usage?.input ?? 0, output: result.usage?.output ?? 0 };
      const out: JudgeResponse = { status: "ok", model: result.model, answers, usage, latencyMs };
      if (!explicitConfirm && o.inCallConfirm && Object.keys(variant).length) out.variant = { shuffleSeed: seed, answers: variant };
      return out;
    },
  };
}
