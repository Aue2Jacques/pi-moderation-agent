// Stage ③ minimal image channel: the image reaches the checker, its answer lands on the content's judge calls as
// image_check (primary + confirming copy) and enters the same decision; anything unsure goes to a person.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../packages/core/src/index.ts";
import { DEFAULT_GATEWAY_CONFIG, Gateway, dirImageStore, parseImageAnswer, type ImageChecker } from "../../packages/gateway/src/index.ts";
import { recordedJudge, uniform } from "../../packages/worker/src/index.ts";
import { BUNDLE, freshDb, seedContent } from "../helpers.ts";
import { PRICES, passThroughCalibrator } from "./setup.ts";

const lowJudge = recordedJudge((req) => { const a = uniform(req.questions, 0.01); return { status: "ok", model: "jev-recorded", answers: a, variant: { shuffleSeed: 3, answers: a }, usage: { input: 10, output: 1 }, latencyMs: 5 }; });
const checker = (p: number, status: "ok" | "error" = "ok"): ImageChecker & { calls: number } => {
  const c = { provider: "fake-image", model: "fake-vision", calls: 0, async check() { c.calls++; return status === "ok" ? { status: "ok" as const, model: "fake-vision", choice: p >= 0.5 ? "violate" : "none", probs: { violate: p, none: 1 - p, unknown: 0 }, usage: { input: 100, output: 5 }, latencyMs: 3 } : { status: "error" as const, model: "fake-vision", latencyMs: 3 }; } };
  return c;
};
function setup(ic: ImageChecker, calibrator: core.Calibrator = passThroughCalibrator("calib@t1")) {
  const dir = mkdtempSync(join(tmpdir(), "img-"));
  writeFileSync(join(dir, "ok.png"), Buffer.from("89504e470d0a1a0a", "hex"));
  writeFileSync(join(dir, "doc.pdf"), "x");
  const db = freshDb();
  const gw = new Gateway({ db, bundle: BUNDLE, judge: lowJudge, prices: PRICES, calibrator, evidenceVer: "evidence@t1", judgeModel: "jev-recorded", cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g1", imageStore: dirImageStore(dir), imageChecker: ic });
  return { db, gw };
}
const reviewOf = (db: core.Db, id: string) => db.prepare("SELECT state, release_reason FROM review WHERE content_id=?").get(id) as { state: string; release_reason: string | null };

describe("stage ③ image channel", () => {
  it("missing file or unsupported type -> image_unsupported, no checker call", async () => {
    const ic = checker(0.01);
    const { db, gw } = setup(ic);
    seedContent(db, "m1", "comment", { text: "normal", imageRefs: ["nope.png"] });
    seedContent(db, "m2", "comment", { text: "normal", imageRefs: ["doc.pdf"] });
    seedContent(db, "m3", "comment", { text: "normal", imageRefs: ["../etc/passwd"] });
    await gw.processIntakeOnce();
    for (const id of ["m1", "m2", "m3"]) expect(reviewOf(db, id)).toEqual({ state: "human_queue", release_reason: "image_unsupported" });
    expect(ic.calls).toBe(0);
  });
  it("low risk image + low risk text -> auto pass; two image judge calls recorded as image_check (copy confirms primary)", async () => {
    const ic = checker(0.02);
    const { db, gw } = setup(ic);
    seedContent(db, "p1", "comment", { text: "normal", imageRefs: ["ok.png"] });
    await gw.processIntakeOnce();
    expect(reviewOf(db, "p1").state).toBe("disposed");
    expect((db.prepare("SELECT action FROM ruling WHERE content_id='p1'").get() as { action: string }).action).toBe("pass");
    const calls = db.prepare("SELECT judge_call_id, confirms_call_id, api FROM judge_call WHERE content_id='p1' AND api='image' ORDER BY created_at").all() as { judge_call_id: string; confirms_call_id: string | null }[];
    expect(calls).toHaveLength(2);
    expect(calls[1]!.confirms_call_id).toBe(calls[0]!.judge_call_id);
    expect((db.prepare("SELECT COUNT(*) AS n FROM judge_answer a JOIN judge_call c ON c.judge_call_id=a.judge_call_id WHERE c.content_id='p1' AND a.question_kind='image_check'").get() as { n: number }).n).toBe(2);
  });
  it("violating image -> a person looks (image_review); checker error -> judge_down", async () => {
    const { db, gw } = setup(checker(0.97));
    seedContent(db, "v1", "comment", { text: "normal", imageRefs: ["ok.png"] });
    await gw.processIntakeOnce();
    expect(reviewOf(db, "v1")).toEqual({ state: "human_queue", release_reason: "image_review" });
    const e = setup(checker(0.1, "error"));
    seedContent(e.db, "e1", "comment", { text: "normal", imageRefs: ["ok.png"] });
    await e.gw.processIntakeOnce();
    expect(reviewOf(e.db, "e1")).toEqual({ state: "human_queue", release_reason: "judge_down" });
  });
  it("strict calibration without an image_check bucket -> calib_missing, never an auto pass", async () => {
    const strict: core.Calibrator = { calibVer: "calib@t1", mode: "strict", apply: (b, raw) => (b.question === "image_check" ? null : { probs: { ...raw }, temperature: 1 }) };
    const { db, gw } = setup(checker(0.01), strict);
    seedContent(db, "c1", "comment", { text: "normal", imageRefs: ["ok.png"] });
    await gw.processIntakeOnce();
    expect(reviewOf(db, "c1")).toEqual({ state: "human_queue", release_reason: "calib_missing" });
  });
});

describe("image answer parsing", () => {
  it("normalises probabilities over the options; rejects unknown choices and empty probs", () => {
    const a = parseImageAnswer('```json\n{"choice":"none","probs":{"violate":0.1,"none":0.3,"unknown":0}}\n```', ["violate", "none", "unknown"])!;
    expect(a.choice).toBe("none");
    expect(a.probs.violate).toBeCloseTo(0.25);
    expect(a.probs.none).toBeCloseTo(0.75);
    expect(parseImageAnswer('{"choice":"maybe","probs":{"violate":1}}', ["violate", "none", "unknown"])).toBeUndefined();
    expect(parseImageAnswer('{"choice":"none","probs":{}}', ["violate", "none", "unknown"])).toBeUndefined();
  });
});
