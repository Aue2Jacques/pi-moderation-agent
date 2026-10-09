// End-to-end run of the core interaction in demo mode, over HTTP only: `scripts/console.ts --demo` starts G + W
// (and builds the console if needed); then submit -> timeline -> human decision -> appeal, checking each state change,
// with the demo traffic running alongside; then the global live stream (/api/events) while the traffic runs.
// usage: node --experimental-strip-types --no-warnings test/e2e/console-demo.ts   (pnpm run e2e:console)
// Exit code 0 = every check passed; the checks print as they run.
import type { ConsoleConfig, ContentTimeline, HumanQueueItem, AppealItem, LiveFrame, ReviewListItem, Stats, TrafficStatus } from "../../packages/gateway/src/console-types.ts";
import { launchDemo } from "./launch.ts";

let failed = 0, passed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}

const app = await launchDemo({ DEMO_AGENT_MS: "150", DEMO_JUDGE_MS: "80" });
const { base } = app;
const get = async <T>(p: string, h: Record<string, string> = {}): Promise<T> => (await (await fetch(base + p, { headers: h })).json()) as T;
const post = (p: string, body: unknown, h: Record<string, string> = {}): Promise<Response> => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(body) });
const timeline = (id: string): Promise<ContentTimeline> => get<ContentTimeline>(`/api/contents/${encodeURIComponent(id)}`);
/** Read `live` frames from GET /api/events for `ms` milliseconds. */
async function liveFrames(ms: number): Promise<LiveFrame[]> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: ac.signal });
  const out: LiveFrame[] = [];
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
        if (block.includes("event: live") && data) out.push(JSON.parse(data.slice(6)) as LiveFrame);
      }
    }
  } catch { /* aborted */ } finally { clearTimeout(t); }
  return out;
}
async function until(id: string, ok: (t: ContentTimeline) => boolean, ms = 30_000): Promise<ContentTimeline> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await timeline(id);
    if (ok(t) || Date.now() > end) return t;
    await new Promise((r) => setTimeout(r, 150));
  }
}

try {
  const cfg = await get<ConsoleConfig>("/api/config");
  check("demo mode is on, reviewer credentials provided", cfg.mode === "demo" && !!cfg.demo_auth);
  const H = { authorization: `Bearer ${cfg.demo_auth!.token}`, "x-reviewer": cfg.demo_auth!.reviewer };
  check("the built console is served at /", (await (await fetch(base + "/")).text()).includes("内容审核控制台"));

  // 1. submit every sample; each ends on its route
  const ids: Record<string, string> = {};
  for (const s of cfg.samples) {
    const r = await post("/api/contents", { text: s.text, scene: s.scene, account_id: s.account_id, ...(s.parent ? { parent: s.parent } : {}) });
    ids[s.id] = ((await r.json()) as { content_id: string }).content_id;
    check(`submit ${s.id} -> 201`, r.status === 201);
  }
  const expectations: Record<string, (t: ContentTimeline) => boolean> = {
    "fast-pass": (t) => t.reviews[0]?.route.kind === "fast_pass" && t.effective?.action === "pass",
    "fast-block": (t) => t.reviews[0]?.route.kind === "fast_block" && t.effective?.action === "limit",
    "agent-pass": (t) => t.reviews[0]?.ruling?.actor === "agent" && t.effective?.action === "pass",
    "agent-takedown": (t) => t.reviews[0]?.ruling?.actor === "agent" && t.effective?.action === "takedown",
    "to-human": (t) => t.phase === "human" && t.reviews[0]?.release_reason === "evidence_gap",
    "injection": (t) => t.reviews[0]?.suspect_reason === "injection_suspected" && t.effective?.action === "limit",
  };
  for (const [k, ok] of Object.entries(expectations)) {
    const t = await until(ids[k]!, (x) => x.phase === "done" || x.phase === "human");
    check(`${k}: ${t.reviews.map((r) => `${r.route.kind}/${r.state}/${r.ruling?.action ?? "-"}`).join(" ")}`, ok(t));
  }
  const ap = await timeline(ids["agent-pass"]!);
  check("agent steps are on the timeline in order", ap.reviews[0]!.steps.map((s) => s.tool).join(",") === "load_rule,get_thread_context,get_account_history,judge,dispose");
  check("fast-path scores carry primary and shuffled-copy answers", ap.reviews[0]!.judge_rounds[0]!.questions.every((q) => q.primary?.cal !== null && q.confirm?.cal !== null));

  // 2. human decision on the released one
  const humanId = ids["to-human"]!;
  const rid = (await timeline(humanId)).reviews[0]!.review_id;
  const q = await get<HumanQueueItem[]>("/api/human/queue");
  check("the released review is in the human queue", q.some((x) => x.review_id === rid));
  const claim = await post("/api/human/claim", { review_id: rid }, H);
  check("claim -> 200", claim.status === 200);
  check("timeline shows the claim", (await timeline(humanId)).reviews[0]!.human?.claimed_by === cfg.demo_auth!.reviewer);
  const sub = await post("/api/human/submit", { review_id: rid, action: "pass", rule_ids: [], reason: "e2e" }, H);
  check("human ruling -> 200", sub.status === 200);
  const th = await timeline(humanId);
  check("content is done, human ruling effective", th.phase === "done" && th.reviews[0]!.ruling?.actor === "human" && th.effective?.action === "pass");

  // 3. appeal on the agent takedown: a new review, re-judged by the agent
  const appealed = ids["agent-takedown"]!;
  const a = await post("/api/appeals", { content_id: appealed, trigger_request_id: "e2e-appeal-1", reason_code: "disagree" });
  check("appeal -> 201", a.status === 201);
  const during = await timeline(appealed);
  check("the old ruling stays effective while the appeal runs", during.effective?.action === "takedown" && during.reviews.length === 2);
  const ta = await until(appealed, (t) => t.reviews.length === 2 && t.phase !== "agent");
  check(`appeal review decided: ${ta.reviews[1]?.state}/${ta.reviews[1]?.ruling?.action ?? "-"}`, ta.reviews[1]?.trigger === "appeal" && !!ta.reviews[1]?.ruling);
  const list = await get<AppealItem[]>("/api/appeals");
  check("appeal listed with prior and result", list.some((x) => x.content_id === appealed && x.prior?.action === "takedown" && !!x.result));

  // 4. a failure path through the same running system
  const bad = await post("/api/contents", { text: "hello", scene: "forum" });
  check("invalid scene -> 400", bad.status === 400);
  const missing = await post("/api/human/claim", { review_id: "nope#suspicious#1" }, H);
  check("claim of an unknown task -> 404", missing.status === 404);

  // the demo traffic runs alongside (default rate): count only this script's contents, then check the traffic itself
  const all = await get<{ items: ReviewListItem[] }>("/api/review-list?limit=200");
  const own = all.items.filter((r) => !r.content_id.startsWith(cfg.demo_traffic!.sim_prefix));
  const humanClosed = (await get<HumanQueueItem[]>("/api/human/queue?status=closed")).filter((x) => !x.content_id.startsWith(cfg.demo_traffic!.sim_prefix));
  const ownAppeals = (await get<AppealItem[]>("/api/appeals")).filter((x) => !x.content_id.startsWith(cfg.demo_traffic!.sim_prefix));
  check(`own reviews add up (reviews ${own.length}, human closed ${humanClosed.length}, appeals ${ownAppeals.length})`, own.length === 7 && humanClosed.length === 1 && ownAppeals.length === 1);
  let tr = await get<TrafficStatus>("/api/demo/traffic");
  for (let i = 0; i < 60 && tr.generated === 0; i++) { await new Promise((r) => setTimeout(r, 250)); tr = await get<TrafficStatus>("/api/demo/traffic"); }
  const s = await get<Stats>("/api/stats");
  check(`demo traffic is running (${tr.per_min}/min, generated ${tr.generated})`, tr.per_min > 0 && !tr.paused && tr.generated > 0 && s.contents > 6);

  // 5. the global live stream: with the traffic turned up, frames arrive on their own with new reviews and moving counts
  await post("/api/demo/traffic", { per_min: 120 });
  const frames = await liveFrames(6000);
  const later = frames.slice(1);
  check(`live stream: snapshot then ${later.length} frames without polling`, frames[0]?.snapshot === true && later.length >= 2);
  check("live stream: new reviews arrive as changed rows", later.some((f) => f.changed.some((r) => r.content_id.startsWith(cfg.demo_traffic!.sim_prefix))));
  check(`live stream: content count moves (${frames[0]?.stats.contents} -> ${frames.at(-1)?.stats.contents})`, (frames.at(-1)?.stats.contents ?? 0) > (frames[0]?.stats.contents ?? 0));
  check("live stream: traffic status rides along", (frames.at(-1)?.traffic?.generated ?? 0) > (frames[0]?.traffic?.generated ?? 0));
} catch (e) {
  failed++;
  console.error("FAIL unexpected error", e);
} finally {
  await app.stop();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
