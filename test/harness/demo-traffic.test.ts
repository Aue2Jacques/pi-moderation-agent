// Demo traffic through the real entry points: G and W run as child processes in demo mode with a fast traffic setting,
// the test only talks HTTP. Checks that every route shows up (fast pass / block, agent dispose, agent -> human), the
// simulated reviewer decides simulated tasks only, appeals happen, the human queue stays bounded and drains when the
// traffic is paused, a person's own submission is tracked as usual, and the control endpoint validates its input.
// Then G in real mode with DEMO_TRAFFIC_PER_MIN set: no content is ever generated and the control endpoint is absent.
// Real-mode G runs in a scratch directory holding only links to rules/, config/ and calib/ (no .env to read) with an
// unreachable judge address; nothing is submitted, so no judge call is made.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsoleConfig, ContentTimeline, HumanQueueItem, AppealItem, LiveFrame, Stats, TrafficStatus } from "../../packages/gateway/src/console-types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TOKEN = "test-token";
const CAP = 4;

const freePort = (): Promise<number> => new Promise((ok, fail) => {
  const s = createServer();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
});

function startProc(entry: string, env: NodeJS.ProcessEnv, ready: string, cwd = ROOT): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, entry)], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`${entry} not ready:\n${log.join("")}`)), 30_000);
    proc.stdout!.on("data", (d: Buffer) => { log.push(d.toString()); if (d.toString().includes(ready)) { clearTimeout(t); ok(proc); } });
    proc.stderr!.on("data", (d: Buffer) => log.push(d.toString()));
    proc.on("exit", (code) => { clearTimeout(t); fail(new Error(`${entry} exited ${code}:\n${log.join("")}`)); });
  });
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read `live` frames from GET /api/events for `ms` milliseconds. */
async function liveFrames(base: string, ms: number): Promise<LiveFrame[]> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const frames: LiveFrame[] = [];
  const t = setTimeout(() => ac.abort(), ms);
  let buf = "";
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += Buffer.from(chunk).toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").find((l) => l.startsWith("data: "));
        if (block.includes("event: live") && data) frames.push(JSON.parse(data.slice(6)) as LiveFrame);
      }
    }
  } catch { /* aborted */ } finally { clearTimeout(t); }
  return frames;
}

describe("demo traffic with real G and W", () => {
  let base = "";
  const procs: ChildProcess[] = [];
  const get = async <T>(p: string): Promise<T> => (await (await fetch(base + p)).json()) as T;
  const post = (p: string, body: unknown): Promise<Response> => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-traffic-"));
    const gp = await freePort(), wp = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env, DEMO: "1", APP_DB: join(dir, "app.db"), SESSION_DB: join(dir, "session.sqlite"), W_LOCK: join(dir, "w.lock.db"),
      G_PORT: String(gp), W_PORT: String(wp), CONSOLE_DIR: join(dir, "none"), HUMAN_REVIEW_TOKEN: TOKEN,
      DEMO_JUDGE_MS: "15", DEMO_AGENT_MS: "30", INTAKE_MS: "100", ADMIT_MS: "100", ADMIT_MAX: "20",
      DEMO_TRAFFIC_PER_SEC: "5", DEMO_TRAFFIC_SEED: "5", DEMO_APPEAL_PCT: "12", DEMO_KEEP_CONTENTS: "0",
      DEMO_SIM_REVIEWS_PER_MIN: "60", DEMO_SIM_MIN_AGE_MS: "3000", DEMO_SIM_THINK_MS: "400", DEMO_HUMAN_CAP: String(CAP),
    };
    procs.push(await startProc("packages/gateway/src/main.ts", env, "gateway up"));
    procs.push(await startProc("packages/worker/src/main.ts", env, "worker up"));
    base = `http://127.0.0.1:${gp}`;
  }, 60_000);
  afterAll(() => { for (const p of procs) p.kill("SIGTERM"); });

  it("covers every route, keeps the human queue bounded, appeals, and leaves a person's task alone", async () => {
    const cfg = await get<ConsoleConfig>("/api/config");
    expect(cfg.demo_traffic).toEqual({ sim_prefix: "sim-", sim_reviewer: "sim-reviewer" });
    expect(cfg.reviewers).toContain("sim-reviewer");
    // a person's submission alongside the traffic: the sample that ends with a person
    const s = cfg.samples.find((x) => x.id === "to-human")!;
    const mine = ((await (await post("/api/contents", { text: s.text, scene: s.scene, account_id: s.account_id })).json()) as { content_id: string }).content_id;

    let maxOpenSim = 0;
    let st: Stats | undefined, tr: TrafficStatus | undefined;
    const end = Date.now() + 40_000;
    const done = (): boolean => !!st && !!tr && st.routes.fast_pass > 0 && st.routes.fast_block > 0 && st.agent.disposed > 0 && st.agent.released > 0
      && tr.sim_reviewer.decided >= 2 && st.appeals.total >= 1 && st.contents >= 60;
    while (Date.now() < end) {
      [st, tr] = await Promise.all([get<Stats>("/api/stats"), get<TrafficStatus>("/api/demo/traffic")]);
      maxOpenSim = Math.max(maxOpenSim, tr.sim_reviewer.open_sim_tasks);
      if (done()) break;
      await sleep(500);
    }
    expect(done(), JSON.stringify({ routes: st?.routes, agent: st?.agent, appeals: st?.appeals, contents: st?.contents, sim: tr?.sim_reviewer })).toBe(true);
    expect(tr!.generated).toBeGreaterThanOrEqual(60);
    expect(Object.values(tr!.by_kind).filter((n) => n > 0).length).toBeGreaterThanOrEqual(5);
    // bounded: inflow is about 0.4 tasks/s against a reviewer at 1/s; the cap plus what arrives within the minimum age
    expect(maxOpenSim).toBeLessThanOrEqual(CAP + 6);

    const closed = await get<HumanQueueItem[]>("/api/human/queue?status=closed");
    const bySim = closed.filter((x) => x.closed_by === "sim-reviewer");
    expect(bySim.length).toBeGreaterThanOrEqual(2);
    expect(bySim.every((x) => x.content_id.startsWith("sim-"))).toBe(true);
    const appeals = await get<AppealItem[]>("/api/appeals");
    expect(appeals.every((a) => a.content_id.startsWith("sim-") && a.prior !== null && a.prior.action !== "pass")).toBe(true);

    // the person's own content: tracked as usual, waiting for a person (never taken by the simulated reviewer)
    const t = await get<ContentTimeline>(`/api/contents/${encodeURIComponent(mine)}`);
    expect(t.phase).toBe("human");
    expect(t.reviews[0]!.human?.claimed_by ?? null).toBeNull();

    // pause: no new content, and the simulated queue drains to empty
    const paused = (await (await post("/api/demo/traffic", { paused: true })).json()) as TrafficStatus;
    expect(paused.paused).toBe(true);
    await sleep(300);
    const before = (await get<Stats>("/api/stats")).contents;
    const drainEnd = Date.now() + 30_000;
    let open = -1;
    while (Date.now() < drainEnd) {
      open = (await get<TrafficStatus>("/api/demo/traffic")).sim_reviewer.open_sim_tasks;
      if (open === 0) break;
      await sleep(500);
    }
    expect(open).toBe(0);
    expect((await get<Stats>("/api/stats")).contents).toBe(before);
    const mineAfter = await get<HumanQueueItem[]>("/api/human/queue?status=open");
    expect(mineAfter.some((x) => x.content_id === mine)).toBe(true);
  }, 90_000);

  it("the global live stream pushes stats, changed reviews and traffic status while the traffic runs", async () => {
    await (await post("/api/demo/traffic", { paused: false, per_sec: 4 })).json();
    const frames = await liveFrames(base, 5000);
    expect(frames[0]?.snapshot).toBe(true);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    const later = frames.slice(1);
    expect(later.every((f) => !f.snapshot)).toBe(true);
    expect(later.some((f) => f.changed.length > 0)).toBe(true);
    expect(frames.at(-1)!.stats.contents).toBeGreaterThan(frames[0]!.stats.contents);
    expect(frames.at(-1)!.traffic?.generated).toBeGreaterThan(frames[0]!.traffic!.generated);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.seq).toBeGreaterThan(frames[i - 1]!.seq);
    // fast-path throughput rides along: 300 per-second buckets, recent ones non-empty
    const flow = frames.at(-1)!.flow!;
    expect(flow.series).toHaveLength(300);
    expect(flow.series.slice(-5).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(flow.per_sec).toBeGreaterThan(0);
    // a changed row carries the list fields the console shows
    const row = later.flatMap((f) => f.changed)[0]!;
    expect(row).toMatchObject({ review_id: expect.any(String), content_id: expect.stringMatching(/^sim-/), route: expect.any(String), state: expect.any(String) });
    await post("/api/demo/traffic", { paused: true });
  }, 30_000);

  it("the control endpoint validates its input and changes the rate", async () => {
    expect((await post("/api/demo/traffic", { per_sec: -1 })).status).toBe(400);
    expect((await post("/api/demo/traffic", { per_sec: 51 })).status).toBe(400);   // above the measured ceiling
    expect((await post("/api/demo/traffic", { per_sec: "fast" })).status).toBe(400);
    expect((await post("/api/demo/traffic", { per_min: -1 })).status).toBe(400);
    expect((await post("/api/demo/traffic", { per_sec: 5, per_min: 300 })).status).toBe(400);
    expect((await post("/api/demo/traffic", { paused: "no" })).status).toBe(400);
    expect((await post("/api/demo/traffic", "{oops")).status).toBe(400);
    const r = (await (await post("/api/demo/traffic", { per_sec: 20, paused: false })).json()) as TrafficStatus;
    expect(r).toMatchObject({ per_sec: 20, per_min: 1200, paused: false, max_per_sec: 50, tiers: [1, 5, 10, 20, 50] });
    const m = (await (await post("/api/demo/traffic", { per_min: 90 })).json()) as TrafficStatus;   // the older per-minute form
    expect(m.per_sec).toBe(1.5);
    expect((await post("/api/demo/traffic", { per_sec: 0 })).status).toBe(200);
    expect(r.retention ?? null).toBeNull();   // DEMO_KEEP_CONTENTS=0 in this run
  });
});

describe("demo retention with real G and W", () => {
  let base = "", wBase = "";
  const procs: ChildProcess[] = [];
  const get = async <T>(p: string): Promise<T> => (await (await fetch(base + p)).json()) as T;
  const post = (p: string, body: unknown): Promise<Response> => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let appDb = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-retention-"));
    const gp = await freePort(), wp = await freePort();
    appDb = join(dir, "app.db");
    const env: NodeJS.ProcessEnv = {
      ...process.env, DEMO: "1", APP_DB: appDb, SESSION_DB: join(dir, "session.sqlite"), W_LOCK: join(dir, "w.lock.db"),
      G_PORT: String(gp), W_PORT: String(wp), CONSOLE_DIR: join(dir, "none"), HUMAN_REVIEW_TOKEN: TOKEN,
      DEMO_JUDGE_MS: "15", DEMO_AGENT_MS: "30", INTAKE_MS: "100", ADMIT_MS: "100",
      DEMO_TRAFFIC_PER_SEC: "25", DEMO_TRAFFIC_SEED: "8", DEMO_APPEAL_PCT: "5",
      DEMO_SIM_MIN_AGE_MS: "500", DEMO_SIM_THINK_MS: "200", DEMO_HUMAN_CAP: "2",
      DEMO_KEEP_CONTENTS: "60", DEMO_PRUNE_MS: "700", DEMO_PRUNE_QUIET_MS: "300",
    };
    procs.push(await startProc("packages/gateway/src/main.ts", env, "gateway up"));
    procs.push(await startProc("packages/worker/src/main.ts", env, "worker up"));
    base = `http://127.0.0.1:${gp}`;
    wBase = `http://127.0.0.1:${wp}`;
  }, 60_000);
  afterAll(() => { for (const p of procs) p.kill("SIGTERM"); });

  it("keeps the newest simulated contents, removes the rest with their agent sessions, and the totals stay continuous", async () => {
    // a person's own content: never removed
    const mine = ((await (await post("/api/contents", { text: "这期讲得很清楚，收藏了", scene: "comment" })).json()) as { content_id: string }).content_id;
    const seen: number[] = [];
    const end = Date.now() + 30_000;
    let st: Stats | undefined, tr: TrafficStatus | undefined;
    while (Date.now() < end) {
      [st, tr] = await Promise.all([get<Stats>("/api/stats"), get<TrafficStatus>("/api/demo/traffic")]);
      seen.push(st.contents);
      if ((tr.retention?.pruned ?? 0) >= 200) break;
      await sleep(500);
    }
    expect(tr!.retention!.pruned, JSON.stringify(tr!.retention)).toBeGreaterThanOrEqual(200);
    // the contents counter never went down while rows were being removed
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    // pause, let the queues drain, and compare the totals with what was generated
    await post("/api/demo/traffic", { paused: true });
    const drain = Date.now() + 20_000;
    for (;;) {
      st = await get<Stats>("/api/stats");
      tr = await get<TrafficStatus>("/api/demo/traffic");
      if ((st.agent.open === 0 && tr.sim_reviewer.open_sim_tasks === 0) || Date.now() > drain) break;
      await sleep(400);
    }
    expect(st.contents).toBe(tr.generated + 1);
    expect(st.judged).toBe(st.contents);
    const routeSum = Object.values(st.routes).reduce((a, b) => a + b, 0);
    expect(routeSum).toBe(st.reviews);
    expect(st.human.closed).toBeGreaterThan(0);
    // what is left in app.db: about `keep` simulated contents (plus anything that was still moving)
    const listed = await get<{ total: number }>("/api/review-list?limit=1");
    expect(listed.total).toBeLessThan(st.reviews);
    expect(listed.total).toBeLessThanOrEqual(60 * 2 + 40);
    expect((await get<ContentTimeline>(`/api/contents/${encodeURIComponent(mine)}`)).content.content_id).toBe(mine);
    // W removed the agent sessions of removed reviews
    const wEnd = Date.now() + 10_000;
    let pruned = 0;
    while (Date.now() < wEnd && pruned === 0) { pruned = ((await (await fetch(`${wBase}/health`)).json()) as { sessions_pruned?: number }).sessions_pruned ?? 0; if (!pruned) await sleep(500); }
    expect(pruned).toBeGreaterThan(0);
  }, 90_000);
});

/** 1x1 PNG */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("real mode never generates traffic", () => {
  let g: ChildProcess | undefined;
  afterAll(() => { g?.kill("SIGTERM"); });

  it("with DEMO_TRAFFIC_PER_MIN set, no content appears and /api/demo/traffic is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-g-"));
    for (const x of ["rules", "config", "calib"]) symlinkSync(join(ROOT, x), join(dir, x));
    const gp = await freePort();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"], HOME: process.env["HOME"], G_PORT: String(gp), APP_DB: join(dir, "app.db"), CONSOLE_DIR: join(dir, "none"),
      JEV_BASE_URL: "http://127.0.0.1:9", JEV_API_KEY: "unused", HUMAN_REVIEW_TOKEN: TOKEN,
      DEMO_TRAFFIC_PER_MIN: "600", DEMO_TRAFFIC_PER_SEC: "50", DEMO_KEEP_CONTENTS: "10", DEMO_SIM_REVIEWS_PER_MIN: "600", INTAKE_MS: "100",
    };
    g = await startProc("packages/gateway/src/main.ts", env, "gateway up", dir);
    const base = `http://127.0.0.1:${gp}`;
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as ConsoleConfig;
    expect(cfg.mode).toBe("real");
    expect(cfg.demo_traffic).toBeNull();
    expect(cfg.reviewers).not.toContain("sim-reviewer");
    await sleep(2500);
    const st = (await (await fetch(`${base}/api/stats`)).json()) as Stats;
    expect(st.contents).toBe(0);
    expect((await fetch(`${base}/api/demo/traffic`)).status).toBe(404);
    expect((await fetch(`${base}/api/demo/traffic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ per_min: 60 }) })).status).toBe(404);
    expect((await fetch(`${base}/api/demo/traffic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ per_sec: 20 }) })).status).toBe(404);
    await sleep(500);
    expect(((await (await fetch(`${base}/api/stats`)).json()) as Stats).contents).toBe(0);
    // images: refused without an image store (IMAGE_DIR); no demo presets
    const img = await fetch(`${base}/api/contents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: "comment", image: { data: PNG_1PX } }) });
    expect(img.status).toBe(400);
    expect(((await img.json()) as { code: string }).code).toBe("E_IMAGE_DISABLED");
    expect(cfg.images).toMatchObject({ enabled: false, samples: [], note: null });
    expect((await fetch(`${base}/api/demo/image-samples/img-normal`)).status).toBe(404);
    // no demo retention in real mode: the rollup table is never created
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(join(dir, "app.db"), { readOnly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='console_rollup'").get()).toBeUndefined();
    db.close();
  }, 40_000);
});

describe("real mode with an image store: images take the existing image channel", () => {
  let g: ChildProcess | undefined;
  afterAll(() => { g?.kill("SIGTERM"); });

  it("IMAGE_DIR set, no image model: the image is stored and the content goes to a person (image_unsupported), no judge call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "real-img-"));
    for (const x of ["rules", "config", "calib"]) symlinkSync(join(ROOT, x), join(dir, x));
    const gp = await freePort();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"], HOME: process.env["HOME"], G_PORT: String(gp), APP_DB: join(dir, "app.db"), CONSOLE_DIR: join(dir, "none"),
      JEV_BASE_URL: "http://127.0.0.1:9", JEV_API_KEY: "unused", HUMAN_REVIEW_TOKEN: TOKEN, IMAGE_DIR: join(dir, "images"), INTAKE_MS: "100",
    };
    g = await startProc("packages/gateway/src/main.ts", env, "gateway up", dir);
    const base = `http://127.0.0.1:${gp}`;
    const cfg = (await (await fetch(`${base}/api/config`)).json()) as ConsoleConfig;
    expect(cfg.images).toMatchObject({ enabled: true, samples: [] });
    const r = await fetch(`${base}/api/contents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: "comment", image: { data: PNG_1PX } }) });
    expect(r.status).toBe(201);
    const id = ((await r.json()) as { content_id: string }).content_id;
    const sample = await fetch(`${base}/api/contents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: "comment", image_sample: "img-normal" }) });
    expect(sample.status).toBe(400);
    let t: ContentTimeline | undefined;
    for (let i = 0; i < 40; i++) { t = (await (await fetch(`${base}/api/contents/${encodeURIComponent(id)}`)).json()) as ContentTimeline; if (t.reviews.length) break; await sleep(150); }
    expect(t!.reviews[0]).toMatchObject({ trigger: "suspicious", release_reason: "image_unsupported", judge_rounds: [] });
    expect(t!.image_note).toBeNull();
    expect(readdirSync(join(dir, "images"))).toEqual([t!.content.images[0]!.ref]);
  }, 40_000);
});
