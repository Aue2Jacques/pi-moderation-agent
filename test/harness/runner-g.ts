// Child-process gateway for crash tests (H-05). Env: APP_DB, CRASH_AT (optional), NOW_OFFSET_MS (optional).
// Runs one intake pass (fast path) and one outbox dispatch pass, printing one JSON line per milestone.
import * as core from "../../packages/core/src/index.ts";
import { Gateway, DEFAULT_GATEWAY_CONFIG } from "../../packages/gateway/src/index.ts";
import { recordedJudge, uniform } from "../../packages/worker/src/index.ts";
import { BUNDLE } from "../helpers.ts";
import { PRICES, passThroughCalibrator } from "./setup.ts";

const log = (o: unknown): void => { process.stdout.write(`${JSON.stringify(o)}\n`); };
const db = core.openAppDb(process.env["APP_DB"]!, "gateway");
const offset = Number(process.env["NOW_OFFSET_MS"] ?? 0);
const now = (): number => Date.now() + offset;
const judge = recordedJudge((req) => {
  const a = uniform(req.questions, 0.02);
  return { status: "ok", model: "jev-recorded", answers: a, variant: { shuffleSeed: 17, answers: a }, usage: { input: 950, output: 568 }, latencyMs: 5 };
});
const g = new Gateway({ db, bundle: BUNDLE, judge, prices: PRICES, calibrator: passThroughCalibrator("calib@t1"), evidenceVer: "evidence@t1", judgeModel: "jev-recorded", cfg: { ...DEFAULT_GATEWAY_CONFIG }, now, gatewayId: `g-${process.pid}` });
const fast = await g.processIntakeOnce();
log({ milestone: "intake", decisions: fast.map((o) => o.decision) });
const n = g.dispatchOutbox();
log({ milestone: "dispatched", n });
process.exit(0);
