// Stage ③ image channel probe: self-made test images (data/images/probe/, generated with Pillow by
// scripts/make-probe-images.py) through (1) the temporary relay image checker directly — raw answers, twice each — and
// (2) the real gateway fast path (Jev for the text, the checker for the image, strict calibration) to see the routing.
// usage: node --experimental-strip-types scripts/probe-images.ts [model=gemini-3.8-flash]
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { createModels } from "@earendil-works/pi-ai/models";
import * as core from "../packages/core/src/index.ts";
import { DEFAULT_GATEWAY_CONFIG, Gateway, dirImageStore, relayImageChecker } from "../packages/gateway/src/index.ts";
import { jevModel, jevProvider, loadCalibrator } from "../packages/judges/src/index.ts";
import { loadBundle } from "../packages/policy/src/index.ts";
import { piJudge, relayProvider } from "../packages/worker/src/index.ts";

for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
}
const env = (k: string, d?: string): string => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing ${k}`); return v; };
const MODEL = process.argv[2] ?? "gemini-3.8-flash";
const DIR = "data/images/probe";
const meta = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8")) as Record<string, { expected: string; what: string }>;
const { bundle, texts } = loadBundle("rules", "config/scenes.yaml");
const ic = relayImageChecker({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY"), model: MODEL });
const store = dirImageStore(DIR);
const q = bundle.scenes.comment.imageCheck.question;
// 1) the checker alone
const direct = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".png")).sort()) {
  const im = store.load(f);
  if ("error" in im) { direct.push({ image: f, error: im.error }); continue; }
  const a = await ic.check({ contentId: f, images: [im], question: q });
  const b = await ic.check({ contentId: f, images: [im], question: q });
  const show = (x: typeof a) => (x.status === "ok" ? { choice: x.choice, p_violate: +x.probs.violate!.toFixed(2), ms: x.latencyMs } : { status: x.status });
  direct.push({ image: f, expected: meta[f]?.expected, what: meta[f]?.what, first: show(a), second: show(b) });
}
// 2) the real fast path with the channel on (strict calibration: no image_check bucket exists yet)
const db = core.openAppDb(":memory:", "tool");
core.ensureSchema(db);
const models = createModels();
models.setProvider(relayProvider({ baseUrl: env("RELAY_BASE_URL"), apiKey: env("RELAY_API_KEY") }));
models.setProvider(jevProvider({ baseUrl: env("JEV_BASE_URL"), apiKey: env("JEV_API_KEY"), modelId: env("JEV_MODEL", "jev-latest") }));
const pricesRaw = readFileSync("config/prices.yaml", "utf8");
const prices: core.PriceTable = { pricesVer: `prices@${core.sha256(pricesRaw).slice(0, 12)}`, perMillion: (parse(pricesRaw) as { models: core.PriceTable["perMillion"] }).models };
const gw = new Gateway({ db, bundle, ruleTexts: texts, judge: piJudge(models, jevModel(models, env("JEV_MODEL", "jev-latest")), { inCallConfirm: true, timeoutMs: 20_000 }), prices,
  calibrator: loadCalibrator(env("CALIB_DIR", "calib"), env("JEV_MODEL", "jev-latest")), evidenceVer: "evidence@probe", judgeModel: env("JEV_MODEL", "jev-latest"), cfg: DEFAULT_GATEWAY_CONFIG, now: () => Date.now(), gatewayId: "g-img",
  imageStore: store, imageChecker: ic });
const files = Object.keys(meta).sort();
files.forEach((f, k) => core.intakeInsert(db, { contentId: `img-${k}`, scene: "comment", text: "看看这张图", imageRefs: [f], eventTime: Date.now() }, Date.now()));
core.intakeInsert(db, { contentId: "img-missing", scene: "comment", text: "看看这张图", imageRefs: ["not-there.png"], eventTime: Date.now() }, Date.now());
for (let i = 0; i < 5; i++) await gw.processIntakeOnce();
const routed = [...files.map((f, k) => [f, `img-${k}`] as const), ["not-there.png", "img-missing"] as const].map(([f, id]) => {
  const r = db.prepare("SELECT state, release_reason FROM review WHERE content_id=?").get(id) as { state: string; release_reason: string | null } | undefined;
  const calls = (db.prepare("SELECT COUNT(*) AS n FROM judge_call WHERE content_id=? AND api='image'").get(id) as { n: number }).n;
  return { image: f, state: r?.state, reason: r?.release_reason, image_calls: calls };
});
console.log(JSON.stringify({ model: MODEL, direct, routed }, null, 1));
