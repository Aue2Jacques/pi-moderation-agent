// Console API through the real entry points: G (packages/gateway/src/main.ts) and W (packages/worker/src/main.ts) run
// as child processes in demo mode (DEMO=1: scripted judge and agent, no .env, no key) on a fresh app.db; the test only
// talks HTTP. Covers: every demo route (fast pass, fast block, agent pass / takedown, agent -> human, injection guard),
// the timeline contents (judge scores, agent steps, redaction), the SSE stream, the human desk, appeals, the read
// models (lists, stats, rules), static serving of the console, and failure paths (bad scene / text / JSON, duplicate
// content, unknown or closed human task, missing auth, appeal on an open review).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConsoleConfig, ContentTimeline, HumanQueueItem, AppealItem, Stats, RulesInfo, ReviewListItem } from "../../packages/gateway/src/console-types.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TOKEN = "test-token";
const H = { authorization: `Bearer ${TOKEN}`, "x-reviewer": "rev1", "content-type": "application/json" };

const freePort = (): Promise<number> => new Promise((ok, fail) => {
  const s = createServer();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
});

function startProc(entry: string, env: NodeJS.ProcessEnv, ready: string): Promise<{ proc: ChildProcess; log: string[] }> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const log: string[] = [];
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`${entry} not ready:\n${log.join("")}`)), 30_000);
    proc.stdout!.on("data", (d: Buffer) => { log.push(d.toString()); if (d.toString().includes(ready)) { clearTimeout(t); ok({ proc, log }); } });
    proc.stderr!.on("data", (d: Buffer) => log.push(d.toString()));
    proc.on("exit", (code) => { clearTimeout(t); fail(new Error(`${entry} exited ${code}:\n${log.join("")}`)); });
  });
}

let base = "";
let g: ChildProcess | undefined, w: ChildProcess | undefined;
let cfg: ConsoleConfig;

const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Promise<Response> =>
  fetch(`${base}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const getJson = async <T>(path: string, headers: Record<string, string> = {}): Promise<T> => (await (await fetch(`${base}${path}`, { headers })).json()) as T;
const timeline = (id: string): Promise<ContentTimeline> => getJson<ContentTimeline>(`/api/contents/${encodeURIComponent(id)}`);

async function waitFor(id: string, ok: (t: ContentTimeline) => boolean, ms = 20_000): Promise<ContentTimeline> {
  const end = Date.now() + ms;
  let t = await timeline(id);
  while (!ok(t)) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${id}: phase ${t.phase}, reviews ${t.reviews.map((r) => `${r.review_id}:${r.state}`).join(",")}`);
    await new Promise((r) => setTimeout(r, 100));
    t = await timeline(id);
  }
  return t;
}
const settled = (t: ContentTimeline): boolean => t.phase === "done" || t.phase === "human";

async function submitSample(id: string, extra: Record<string, unknown> = {}): Promise<string> {
  const s = cfg.samples.find((x) => x.id === id)!;
  const res = await post("/api/contents", { text: s.text, scene: s.scene, account_id: s.account_id, ...(s.parent ? { parent: s.parent } : {}), ...extra });
  expect(res.status).toBe(201);
  return ((await res.json()) as { content_id: string }).content_id;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "console-api-"));
  const consoleDir = join(dir, "console");
  mkdirSync(join(consoleDir, "assets"), { recursive: true });
  writeFileSync(join(consoleDir, "index.html"), "<!doctype html><title>console-test</title>");
  writeFileSync(join(consoleDir, "assets", "app.js"), "console.log(1)");
  const gp = await freePort(), wp = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env, DEMO: "1", APP_DB: join(dir, "app.db"), SESSION_DB: join(dir, "session.sqlite"), W_LOCK: join(dir, "w.lock.db"),
    G_PORT: String(gp), W_PORT: String(wp), CONSOLE_DIR: consoleDir, HUMAN_REVIEW_TOKEN: TOKEN,
    DEMO_JUDGE_MS: "20", DEMO_AGENT_MS: "40", INTAKE_MS: "100", ADMIT_MS: "150", STREAM_POLL_MS: "100",
    DEMO_TRAFFIC_PER_MIN: "0",   // exact counts below: no generated traffic (test/harness/demo-traffic.test.ts covers it)
  };
  g = (await startProc("packages/gateway/src/main.ts", env, "gateway up")).proc;
  w = (await startProc("packages/worker/src/main.ts", env, "worker up")).proc;
  base = `http://127.0.0.1:${gp}`;
  cfg = await getJson<ConsoleConfig>("/api/config");
}, 60_000);

afterAll(() => {
  w?.kill("SIGKILL");
  g?.kill("SIGKILL");
});

describe("console API on real G + W processes (demo mode)", () => {
  it("config describes demo mode; the built console is served at / and /assets, the legacy dashboard at /legacy", async () => {
    expect(cfg).toMatchObject({ mode: "demo", judge_model: "jev-scripted", agent_model: "scripted-agent", calib_mode: "strict", demo_auth: { reviewer: "rev1", token: TOKEN } });
    expect(cfg.samples.map((s) => s.id)).toEqual(["fast-pass", "fast-block", "agent-pass", "agent-takedown", "to-human", "injection"]);
    expect(cfg.scenes.map((s) => s.scene)).toEqual(expect.arrayContaining(["comment", "danmaku", "nickname"]));
    expect(cfg.scenes.map((s) => s.scene)).not.toContain("image");
    expect(await (await fetch(`${base}/`)).text()).toContain("console-test");
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${base}/assets/..%2f..%2fapp.db`)).status).toBe(404);
    expect(await (await fetch(`${base}/legacy`)).text()).toContain("仪表盘");
  });

  it("each preset sample takes its route through the real fast path, agent and submit check", async () => {
    const ids: Record<string, string> = {};
    for (const s of cfg.samples) ids[s.id] = await submitSample(s.id);
    const t: Record<string, ContentTimeline> = {};
    for (const [k, id] of Object.entries(ids)) t[k] = await waitFor(id, settled);

    // fast pass: one fast review, every question asked twice (primary + shuffled copy) and calibrated
    const fp = t["fast-pass"]!;
    expect(fp.phase).toBe("done");
    expect(fp.reviews.map((r) => r.route.kind)).toEqual(["fast_pass"]);
    expect(fp.reviews[0]!.ruling).toMatchObject({ action: "pass", actor: "fastpath", reason_code: "all_required_covered_and_confirmed" });
    const q = fp.reviews[0]!.judge_rounds[0]!;
    expect(q.stage).toBe("fast");
    expect(q.questions.map((x) => x.key).sort()).toEqual(["ABUSE-001", "MARKETING-003", "injection_guard"]);
    for (const x of q.questions) {
      expect(x.primary?.raw).toBeTypeOf("number");
      expect(x.confirm?.cal).toBeTypeOf("number");
      expect(x.temperature).toBeGreaterThan(0);
    }
    expect(fp.effective).toEqual({ action: "pass", visibility: "visible" });

    expect(t["fast-block"]!.reviews[0]!).toMatchObject({ route: { kind: "fast_block" }, ruling: { action: "limit", actor: "fastpath", rule_ids: ["MARKETING-003"] } });
    expect(t["fast-block"]!.reviews[0]!.judge_rounds[0]!.questions.find((x) => x.key === "MARKETING-003")!.verdict).toBe("block");

    // agent clears it with context: the steps the scripted agent took, reconstructed from the ledger
    const ap = t["agent-pass"]!.reviews[0]!;
    expect(ap.route.kind).toBe("agent");
    expect(ap.steps.map((s) => `${s.tool}:${s.status}`)).toEqual(["load_rule:ok", "get_thread_context:ok", "get_account_history:ok", "judge:ok", "dispose:ok"]);
    expect(ap.ruling).toMatchObject({ action: "pass", actor: "agent", reason: null });   // free text is restricted
    expect(ap.ruling!.reason_len).toBeGreaterThan(0);
    const ctx = ap.steps[1]!.result as { neighbors: { relation: string; text_len: number; text?: string }[] };
    expect(ctx.neighbors[0]).toMatchObject({ relation: "parent" });
    expect(ctx.neighbors[0]!.text_len).toBeGreaterThan(0);
    expect(ctx.neighbors[0]!.text).toBeUndefined();
    expect(ap.judge_rounds.map((r) => r.stage)).toEqual(["fast", "agent"]);
    expect(ap.judge_rounds[1]!.questions.find((x) => x.key === "ABUSE-001")!.verdict).toBe("pass");
    expect(ap.judge_rounds[1]!.evidence_ids.length).toBe(2);

    expect(t["agent-takedown"]!.reviews[0]!.ruling).toMatchObject({ action: "takedown", actor: "agent", rule_ids: ["ABUSE-001"] });

    // the agent cannot decide: release, the review waits in the human queue
    const th = t["to-human"]!;
    expect(th.phase).toBe("human");
    const thr = th.reviews[0]!;
    expect(thr.state).toBe("human_queue");
    expect(thr.steps[thr.steps.length - 1]).toMatchObject({ tool: "release", status: "ok", args: { reason: "evidence_gap" } });
    expect(thr.human).toMatchObject({ reason: "evidence_gap", claimed_by: null, closed_at: null });

    // injection guard: no automatic decision; the agent still limits the marketing content
    const inj = t["injection"]!.reviews[0]!;
    expect(inj.suspect_reason).toBe("injection_suspected");
    expect(inj.judge_rounds[0]!.questions.find((x) => x.key === "injection_guard")!.verdict).toBe("flagged");
    expect(inj.ruling).toMatchObject({ action: "limit", actor: "agent" });

    // events are ordered and end with the ruling
    const evs = t["agent-takedown"]!.events;
    expect(evs[0]!.kind).toBe("intake");
    expect(evs[evs.length - 1]!.kind).toBe("ruling");
    expect(evs.map((e) => e.at)).toEqual([...evs.map((e) => e.at)].sort((a, b) => a - b));
  }, 60_000);

  it("the SSE stream sends a new snapshot whenever the timeline changes, through to the final ruling", async () => {
    const id = await submitSample("agent-pass");
    const res = await fetch(`${base}/api/contents/${encodeURIComponent(id)}/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const snaps: ContentTimeline[] = [];
    let buf = "";
    const end = Date.now() + 20_000;
    while (Date.now() < end && snaps[snaps.length - 1]?.phase !== "done") {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (chunk.includes("event: timeline") && data) snaps.push(JSON.parse(data.slice(6)) as ContentTimeline);
      }
    }
    await reader.cancel();
    expect(snaps.length).toBeGreaterThanOrEqual(3);
    expect(new Set(snaps.map((s) => s.version)).size).toBe(snaps.length);   // only changes are sent
    expect(snaps[snaps.length - 1]!.phase).toBe("done");
    // steps appear one by one: the step count never goes down and grows across snapshots
    const steps = snaps.map((s) => s.reviews[0]?.steps.length ?? 0);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(new Set(steps).size).toBeGreaterThan(2);
    expect((await fetch(`${base}/api/contents/nope/stream`)).status).toBe(404);
  }, 30_000);

  it("human desk: queue -> claim a chosen task -> ruling; appeal opens a new review the agent decides", async () => {
    const id = await submitSample("to-human");
    const t0 = await waitFor(id, (t) => t.phase === "human");
    const rid = t0.reviews[0]!.review_id;
    const queue = await getJson<HumanQueueItem[]>("/api/human/queue");
    expect(queue.find((x) => x.review_id === rid)).toMatchObject({ reason: "evidence_gap", claimed_by: null, scene: "comment" });
    expect((await post("/api/human/claim", { review_id: rid }, {})).status).toBe(401);
    const claim = await post("/api/human/claim", { review_id: rid }, H);
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { review: { review_id: string }; rules: { rule_id: string }[] }).rules.map((r) => r.rule_id).sort()).toEqual(["ABUSE-001", "MARKETING-003"]);
    expect((await timeline(id)).reviews[0]!.human).toMatchObject({ claimed_by: "rev1" });
    // a takedown that cites no rule is refused by the submit check (and audited); then the decision goes through
    expect((await post("/api/human/submit", { review_id: rid, action: "takedown", rule_ids: [], reason: "x" }, H)).status).toBe(422);
    const ok = await post("/api/human/submit", { review_id: rid, action: "pass", rule_ids: [], reason: "看过上下文，不针对个人", rule_id: "ABUSE-001", label: "none" }, H);
    expect(ok.status).toBe(200);
    const t1 = await timeline(id);
    expect(t1.phase).toBe("done");
    expect(t1.reviews[0]!).toMatchObject({ state: "human_disposed", ruling: { action: "pass", actor: "human" }, human: { closed_by: "rev1", label: "none" } });
    expect(t1.reviews[0]!.rejections).toEqual([expect.objectContaining({ actor: "human", code: "E_ACTION_NOT_ALLOWED", action: "takedown" })]);
    expect((await getJson<HumanQueueItem[]>("/api/human/queue")).some((x) => x.review_id === rid)).toBe(false);
    expect((await getJson<HumanQueueItem[]>("/api/human/queue?status=closed")).some((x) => x.review_id === rid)).toBe(true);

    // appeal on a fast-path limit: a new review (seq 2) that the agent re-judges; the old ruling stays effective meanwhile
    const blocked = await submitSample("fast-block");
    await waitFor(blocked, (t) => t.phase === "done");
    const a = await post("/api/appeals", { content_id: blocked, trigger_request_id: `appeal-${blocked}`, reason_code: "disagree" });
    expect(a.status).toBe(201);
    const again = await post("/api/appeals", { content_id: blocked, trigger_request_id: `appeal-${blocked}`, reason_code: "disagree" });
    expect(again.status).toBe(200);
    const ta = await waitFor(blocked, (t) => t.reviews.length === 2 && settled(t));
    expect(ta.reviews[1]!).toMatchObject({ trigger: "appeal", route: { kind: "appeal" }, appeal: { reason_code: "disagree" }, ruling: { action: "limit", actor: "agent" } });
    expect(ta.events.some((e) => e.kind === "appeal")).toBe(true);
    const appeals = await getJson<AppealItem[]>("/api/appeals");
    expect(appeals.find((x) => x.content_id === blocked)).toMatchObject({ reason_code: "disagree", prior: { action: "limit", actor: "fastpath" }, result: { action: "limit", actor: "agent" } });
  }, 60_000);

  it("failure paths: invalid input, duplicates, unknown or closed tasks, missing auth, appeal on an open review", async () => {
    const bad = async (body: unknown, code: string, status = 400): Promise<void> => {
      const r = await post("/api/contents", body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(((await r.json()) as { code: string }).code).toBe(code);
    };
    await bad({ text: "hello", scene: "forum" }, "E_SCENE_INVALID");
    await bad({ text: "hello", scene: "image" }, "E_SCENE_INVALID");
    await bad({ text: "   ", scene: "comment" }, "E_BAD_REQUEST");
    await bad({ text: "x".repeat(2001), scene: "comment" }, "E_BAD_REQUEST");
    await bad({ text: "hello", scene: "comment", content_id: "has#hash" }, "E_BAD_REQUEST");
    await bad({ text: "hello", scene: "comment", parent: { text: "" } }, "E_BAD_REQUEST");
    await bad("{not json", "E_BAD_JSON");

    // the same content id: same payload is a duplicate, a different one a conflict
    const first = await post("/api/contents", { content_id: "dup-1", text: "这期讲得很清楚，收藏了", scene: "danmaku" });
    expect(first.status).toBe(201);
    const dup = await post("/api/contents", { content_id: "dup-1", text: "这期讲得很清楚，收藏了", scene: "danmaku" });
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as { duplicate: boolean }).duplicate).toBe(true);
    expect((await post("/api/contents", { content_id: "dup-1", text: "另一段内容", scene: "danmaku" })).status).toBe(409);
    const td = await waitFor("dup-1", settled);
    expect(td.reviews.length).toBe(1);   // one intake, one review
    expect(td.content.scene).toBe("danmaku");

    // human tasks: unknown, closed; submit without auth
    const claimMissing = await post("/api/human/claim", { review_id: "nope#suspicious#1" }, H);
    expect(claimMissing.status).toBe(404);
    expect(((await claimMissing.json()) as { code: string }).code).toBe("E_REVIEW_NOT_FOUND");
    const closed = (await getJson<HumanQueueItem[]>("/api/human/queue?status=closed"))[0]!;
    expect((await post("/api/human/claim", { review_id: closed.review_id }, H)).status).toBe(409);
    expect((await post("/api/human/submit", { review_id: closed.review_id, action: "pass" }, { "content-type": "application/json" })).status).toBe(401);
    const resend = await post("/api/human/submit", { review_id: closed.review_id, action: "pass", rule_ids: [], reason: "again" }, H);
    expect(resend.status).toBe(200);   // a decided review keeps its one ruling: a resend is reported as a duplicate
    expect(((await resend.json()) as { ruling: { duplicate: boolean } }).ruling.duplicate).toBe(true);
    expect((await post("/api/human/claim", "{", H)).status).toBe(400);

    // appeals: unknown content, missing request id, a review still open
    expect((await post("/api/appeals", { content_id: "nope", trigger_request_id: "r1" })).status).toBe(404);
    expect((await post("/api/appeals", { content_id: "dup-1" })).status).toBe(400);
    const open = await submitSample("to-human");
    await waitFor(open, (t) => t.phase === "human");
    const busy = await post("/api/appeals", { content_id: open, trigger_request_id: "r-open", reason_code: "disagree" });
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { code: string }).code).toBe("E_STATE_INVALID");

    // timelines: unknown content; the restricted view needs auth + confirmation and is audited
    expect((await fetch(`${base}/api/contents/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/contents/dup-1?view=restricted`)).status).toBe(401);
    expect((await fetch(`${base}/api/contents/dup-1?view=restricted`, { headers: H })).status).toBe(400);
    const r = await getJson<ContentTimeline>("/api/contents/dup-1?view=restricted", { ...H, "x-confirm": "yes" });
    expect(r.restricted).toBe(true);
    expect(r.content.text).toBe("这期讲得很清楚，收藏了");
    expect((await timeline("dup-1")).content.text).toBeNull();
  }, 60_000);

  it("read models: review list filters, stats, rules", async () => {
    const all = await getJson<{ items: ReviewListItem[]; total: number }>("/api/review-list?limit=200");
    expect(all.total).toBe(all.items.length);
    const agent = await getJson<{ items: ReviewListItem[]; total: number }>("/api/review-list?route=agent&limit=200");
    expect(agent.items.length).toBeGreaterThan(0);
    expect(agent.items.every((x) => x.route === "agent")).toBe(true);
    const human = await getJson<{ items: ReviewListItem[] }>("/api/review-list?actor=human");
    expect(human.items.every((x) => x.actor === "human")).toBe(true);
    const dm = await getJson<{ items: ReviewListItem[] }>("/api/review-list?scene=danmaku");
    expect(dm.items.map((x) => x.content_id)).toEqual(["dup-1"]);
    const paged = await getJson<{ items: ReviewListItem[] }>("/api/review-list?limit=2&offset=1");
    expect(paged.items.map((x) => x.review_id)).toEqual(all.items.slice(1, 3).map((x) => x.review_id));
    expect(JSON.stringify(all)).not.toContain("这期讲得很清楚");   // lists carry no text
    // incremental read: changed at or after a time, newest change first
    const newest = Math.max(...all.items.map((x) => x.updated_at));
    const inc = await getJson<{ items: ReviewListItem[] }>(`/api/review-list?updated_since=${newest}`);
    expect(inc.items.length).toBeGreaterThanOrEqual(1);
    expect(inc.items.every((x) => x.updated_at >= newest)).toBe(true);
    expect((await getJson<{ items: ReviewListItem[] }>(`/api/review-list?updated_since=${newest + 1}`)).items).toEqual([]);

    const s = await getJson<Stats>("/api/stats");
    expect(s.routes.fast_pass).toBeGreaterThanOrEqual(1);
    expect(s.routes.fast_block).toBeGreaterThanOrEqual(2);
    expect(s.routes.agent).toBeGreaterThanOrEqual(5);
    expect(s.routes.appeal).toBe(1);
    expect(s.agent.disposed).toBeGreaterThanOrEqual(4);
    expect(s.agent.released).toBeGreaterThanOrEqual(2);
    expect(s.human.closed).toBe(1);
    expect(s.human.open).toBeGreaterThanOrEqual(2);
    expect(s.cost.fast_micro).toBeGreaterThan(0);
    expect(s.cost.review_micro).toBeGreaterThan(0);
    expect(s.series).toHaveLength(30);
    expect(s.series.reduce((a, b) => a + b.fast_pass + b.fast_block + b.agent + b.human_direct + b.appeal, 0)).toBe(s.reviews);

    const rules = await getJson<RulesInfo>("/api/rules");
    expect(rules.current.rules_ver).toBe(cfg.rules_ver);
    expect(rules.current.rules.map((r) => r.rule_id).sort()).toEqual(["ABUSE-001", "MARKETING-003"]);
    expect(rules.current.rules.find((r) => r.rule_id === "MARKETING-003")!.agent_thresholds).toEqual({ block: 0.65, pass: 0.1 });
    expect(rules.versions.find((v) => v.current)).toMatchObject({ rules_ver: cfg.rules_ver });
    expect(rules.versions.find((v) => v.current)!.reviews).toBe(s.reviews);
    expect(rules.calibration.files.length).toBeGreaterThan(0);
    expect(rules.current.scenes.find((x) => x.scene === "nickname")!.allowed_actions).toEqual(["pass", "takedown"]);
  });
});
