// G's HTTP (docs §6.1): health, metrics (JSON + SSE), reviews (redacted), restricted view (auth + audit), human queue, appeals, replay control, static pages.
// Console API (2026-10-09): content intake, per-content timeline (JSON + SSE), review / human-queue / appeal lists,
// stats, rules view, config; the built web console (packages/console/dist) is served at / when present.
import { existsSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import * as core from "@mod/core";
import type { Db, PolicyBundle } from "@mod/core";
import type { Gateway } from "./gateway.ts";
import { DASHBOARD_HTML, HUMAN_HTML } from "./pages.ts";
import { LiveHub } from "./live.ts";
import { ActionError, claimTask, pinnedBundle, humanRule, intakeContent, openAppeal, unclaimTask } from "./console-actions.ts";
import type { HarnessRecordStore } from "./harness-record.ts";
import { buildTimeline, humanQueue, listAppeals, listReviews, rulesInfo, stats, type CalibFileInfo, type TimelineImages } from "./console-api.ts";
import type { ConsoleConfig, DemoSampleInfo, ImageSampleInfo, TrafficStatus } from "./console-types.ts";
import { MAX_IMAGE_BYTES, decodeImage, storeImage } from "./demo-images.ts";
import { dirImageStore } from "./image.ts";

/** What the console needs beyond the core HTTP deps. All optional: without it the API still works, with real-mode defaults. */
export type ConsoleDeps = {
  mode: "demo" | "real";
  /** directory of the built console (index.html + assets/); absent or missing files: / serves the legacy dashboard */
  dir?: string;
  agentModel?: string | null;
  samples?: readonly DemoSampleInfo[];
  calibFiles?: readonly CalibFileInfo[];
  /** how often a timeline stream re-reads app.db (ms) */
  streamPollMs?: number;
  /** how often the global live stream (/api/events) reads app.db's counters (ms) */
  livePollMs?: number;
  /** demo mode only: the traffic generator behind /api/demo/traffic, and how its contents / reviewer are named */
  traffic?: { status(): TrafficStatus; set(o: { perSec?: number; paused?: boolean }): void };
  simPrefix?: string;
  simReviewer?: string;
  /** image intake: where images are stored (the image channel's IMAGE_DIR, or the demo data dir); absent: images are
   *  refused. Demo mode adds the preset screenshots (already stored under their refs) and a note for the timeline. */
  images?: { dir: string; samples?: (ImageSampleInfo & { ref: string; file: string })[]; note?: string };
  /** demo mode with DEMO_CORPUS: which judge run is replayed and how many real texts the traffic draws from */
  corpus?: { judge: string; items: number };
  /** HARNESS_RECORD_DB: a recorded real harness run (real judge, real agent model) the Agent page replays; read only */
  harnessRecord?: HarnessRecordStore;
};

export type HttpDeps = { db: Db; gateway: Gateway; bundle: PolicyBundle; humanAuth: core.HumanAuth; now: () => number; console?: ConsoleDeps };

/** Scenes the text intake accepts: every configured scene except the image-only one. */
const textScenes = (b: PolicyBundle): string[] => Object.keys(b.scenes).filter((s) => s !== "image");
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_TEXT = 2000;

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };

const gzCache = new Map<string, { mtime: number; body: Buffer }>();
/** gzip a text body once per file version (the demo is reached through a slow proxy: the 380 KB bundle is ~110 KB gzipped) */
function gzipped(full: string, raw: Buffer): Buffer {
  const mtime = statSync(full).mtimeMs;
  const hit = gzCache.get(full);
  if (hit && hit.mtime === mtime) return hit.body;
  const body = gzipSync(raw, { level: 9 });
  gzCache.set(full, { mtime, body });
  return body;
}
const acceptsGzip = (req: IncomingMessage | undefined): boolean => /\bgzip\b/.test(String(req?.headers["accept-encoding"] ?? ""));

/** Serve a file of the built console; false when it does not exist (path traversal is refused the same way). `inject`:
 *  text placed before </head> of index.html (the console config, so the page needs no extra round trip for it). */
function serveStatic(res: ServerResponse, dir: string, urlPath: string, req?: IncomingMessage, inject?: string): boolean {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const full = join(dir, rel || "index.html");
  if (!full.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return false;
  try {
    if (!existsSync(full) || !statSync(full).isFile()) return false;
    let body = readFileSync(full);
    if (inject && full.endsWith("index.html")) body = Buffer.from(body.toString("utf8").replace("</head>", `${inject}</head>`));
    const text = /\.(js|css|html|svg|json)$/.test(full);
    const gz = text && acceptsGzip(req) && body.length > 1024;
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream", "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      ...(gz ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}) });
    res.end(gz ? (inject ? gzipSync(body) : gzipped(full, body)) : body);
    return true;
  } catch {
    return false;
  }
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const html = (res: ServerResponse, body: string): void => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};
class BadRequest extends Error {}
class TooLarge extends Error {}
/** Request bodies above this are refused (413); an image upload (base64, at most MAX_IMAGE_BYTES) fits. */
const MAX_BODY = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw new TooLarge(`request body larger than ${MAX_BODY} bytes`);
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new BadRequest("body is not JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("body must be a JSON object");
  return v as Record<string, unknown>;
}

const REVIEW_PUBLIC = ["review_id", "content_id", "seq", "trigger", "state", "attempt", "lease_owner", "lease_until", "deadline_at", "snapshot_seq", "budget_tools", "budget_micro", "used_micro", "cost_status", "over_budget_micro", "rules_ver", "calib_ver", "judge_model", "agent_model", "release_reason", "created_at", "updated_at"] as const;
const pick = <T extends object>(row: T, keys: readonly (keyof T)[]): Partial<T> => Object.fromEntries(keys.filter((k) => k in row).map((k) => [k, row[k]])) as Partial<T>;

function auth(d: HttpDeps, req: IncomingMessage): { reviewerId: string } | undefined {
  const h = req.headers["authorization"];
  const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
  const reviewerId = String(req.headers["x-reviewer"] ?? "");
  try {
    core.verifyHumanAuth(d.humanAuth, { reviewerId, token });
    return { reviewerId };
  } catch {
    return undefined;
  }
}

export function createHttpServer(d: HttpDeps): Server {
  const { db, gateway } = d;
  // dev plan R7: human work on a review uses the rules version the review is pinned to — the gateway's own bundle, or
  // the copy stored when that version was in use. undefined: that version was never stored here.
  const bundleOf = (r: core.ReviewRow): core.PolicyBundle | undefined => pinnedBundle(d, r);
  const stored = new Map<string, PolicyBundle>();
  const bundleByVer = (v: string): PolicyBundle | undefined => {
    if (v === d.bundle.rulesVer) return d.bundle;
    if (gateway.d.candidate && v === gateway.d.candidate.bundle.rulesVer) return gateway.d.candidate.bundle;
    let b = stored.get(v);
    if (!b) { b = core.loadStoredBundle(db, v)?.bundle as PolicyBundle | undefined; if (b) stored.set(v, b); }
    return b;
  };
  const cons: ConsoleDeps = d.console ?? { mode: "real" };
  const consoleDir = cons.dir && existsSync(join(cons.dir, "index.html")) ? cons.dir : undefined;
  const bad = (res: ServerResponse, message: string, code = "E_BAD_REQUEST"): void => json(res, 400, { code, message });
  const imgs = cons.images;
  const imageStore = imgs ? dirImageStore(imgs.dir) : undefined;
  const presetByRef = new Map((imgs?.samples ?? []).map((x) => [x.ref, x] as const));
  const consoleConfig = (): ConsoleConfig => {
    const cfg: ConsoleConfig = {
      mode: cons.mode, rules_ver: d.bundle.rulesVer, calib_ver: gateway.d.calibrator.calibVer, calib_mode: gateway.d.calibrator.mode, prices_ver: gateway.d.prices.pricesVer,
      judge_model: gateway.d.judgeModel, agent_model: cons.agentModel ?? null,
      scenes: textScenes(d.bundle).map((k) => ({ scene: k, allowed_actions: [...d.bundle.scenes[k as core.Scene].allowedActions] })),
      reviewers: [...d.humanAuth.reviewers],
      demo_auth: cons.mode === "demo" ? { reviewer: d.humanAuth.reviewers[0] ?? "rev1", token: d.humanAuth.token } : null,
      samples: [...(cons.samples ?? [])],
      demo_traffic: cons.mode === "demo" && cons.traffic ? { sim_prefix: cons.simPrefix ?? "sim-", sim_reviewer: cons.simReviewer ?? "sim-reviewer" } : null,
      demo_corpus: cons.mode === "demo" && cons.corpus ? { judge: cons.corpus.judge, items: cons.corpus.items } : null,
      images: { enabled: !!imgs, max_bytes: MAX_IMAGE_BYTES, samples: (imgs?.samples ?? []).map(({ ref: _r, file: _f, ...x }) => x), note: imgs?.note ?? null },
    };
    return cfg;
  };
  /** the harness record plus the newest session's timeline, so the Agent page can show something without another trip */
  const recordWithFirst = (): unknown => {
    if (!cons.harnessRecord) return { available: false };
    const r = cons.harnessRecord.summary();
    const first = r.sessions[0] ? cons.harnessRecord.timeline(r.sessions[0].content_id) ?? null : null;
    return { ...r, first_timeline: first };
  };
  /** script injected into index.html: config and record ride along with the page (the demo sits behind a proxy that costs
   *  ~1.5 s per request) */
  const preload = (): string => `<script>window.__CONSOLE_CONFIG__=${JSON.stringify(consoleConfig()).replace(/</g, "\\u003c")};window.__HARNESS_RECORD__=${JSON.stringify(recordWithFirst()).replace(/</g, "\\u003c")};</script>`;
  const timelineImages: TimelineImages = { preset: (ref) => { const x = presetByRef.get(ref); return x ? { id: x.id, title: x.title, url: x.url } : null; }, note: imgs?.note ?? null };
  const live = new LiveHub({ db, now: d.now, pollMs: cons.livePollMs ?? 500, flow: () => gateway.flow(), ...(cons.traffic ? { traffic: () => cons.traffic!.status() } : {}) });
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const m = (re: RegExp): RegExpExecArray | null => re.exec(path);
      let mm0: RegExpExecArray | null;
      if (req.method === "GET" && path === "/") return consoleDir && serveStatic(res, consoleDir, "index.html", req, preload()) ? undefined : html(res, DASHBOARD_HTML);
      if (req.method === "GET" && path === "/legacy") return html(res, DASHBOARD_HTML);
      if (req.method === "GET" && consoleDir && (path.startsWith("/assets/") || path === "/favicon.svg") && serveStatic(res, consoleDir, path, req)) return;
      if (req.method === "GET" && path === "/human") return html(res, HUMAN_HTML);
      if (req.method === "GET" && path === "/api/health") return json(res, 200, { ok: true, version: "0.0.0", queues: core.control.backpressure(db), replay_paused: gateway.replayPaused, rules_ver: gateway.d.bundle.rulesVer, calib_ver: gateway.d.calibrator.calibVer, calib_mode: gateway.d.calibrator.mode, completion: core.reconcile.completion(db) });
      if (req.method === "GET" && path === "/api/metrics") {
        if ((req.headers["accept"] ?? "").includes("text/event-stream")) {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const send = () => res.write(`data: ${JSON.stringify(gateway.metrics())}\n\n`);
          send();
          const t = setInterval(send, 1000);
          req.on("close", () => clearInterval(t));
          return;
        }
        return json(res, 200, gateway.metrics());
      }
      if (req.method === "GET" && path === "/api/reviews") {
        const state = url.searchParams.get("state");
        const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
        const rows = (state ? db.prepare("SELECT * FROM review WHERE state=? ORDER BY created_at DESC LIMIT ?").all(state, limit) : db.prepare("SELECT * FROM review ORDER BY created_at DESC LIMIT ?").all(limit)) as core.ReviewRow[];
        return json(res, 200, rows.map((r) => pick(r, REVIEW_PUBLIC)));
      }
      // ---- console API ----
      if (req.method === "GET" && path === "/api/config") return json(res, 200, consoleConfig());
      if (req.method === "GET" && path === "/api/events") {
        // the console's global live stream: stats, changed reviews, list counters, demo traffic (see live.ts)
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        const off = live.subscribe((f) => res.write(`event: live\nid: ${f.seq}\ndata: ${JSON.stringify(f)}\n\n`));
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        req.on("close", () => { off(); clearInterval(beat); });
        return;
      }
      if (req.method === "GET" && path === "/api/review-list") {
        const g = (k: string): string | undefined => url.searchParams.get(k) || undefined;
        const limit = Math.max(1, Math.min(200, Number(g("limit") ?? 50) || 50));
        const offset = Math.max(0, Number(g("offset") ?? 0) || 0);
        return json(res, 200, listReviews(db, { ...(g("state") ? { state: g("state")! } : {}), ...(g("trigger") ? { trigger: g("trigger")! } : {}), ...(g("route") ? { route: g("route")! } : {}),
          ...(g("scene") ? { scene: g("scene")! } : {}), ...(g("action") ? { action: g("action")! } : {}), ...(g("actor") ? { actor: g("actor")! } : {}), ...(g("q") ? { q: g("q")! } : {}), limit, offset,
          ...(g("updated_since") !== undefined && Number.isFinite(Number(g("updated_since"))) ? { updatedSince: Number(g("updated_since")) } : {}) }));
      }
      if (req.method === "GET" && path === "/api/stats") return json(res, 200, stats(db, d.now()));
      if (req.method === "GET" && path === "/api/harness/record") return json(res, 200, recordWithFirst());
      if (req.method === "GET" && (mm0 = m(/^\/api\/harness\/record\/contents\/([^/]+)$/))) {
        const t = cons.harnessRecord?.timeline(decodeURIComponent(mm0[1]!));
        return t ? json(res, 200, t) : json(res, 404, { code: "E_CONTENT_NOT_FOUND" });
      }
      if (req.method === "GET" && path === "/api/rules") {
        return json(res, 200, rulesInfo(db, d.bundle, gateway.d.ruleTexts ?? {}, { calibVer: gateway.d.calibrator.calibVer, calibMode: gateway.d.calibrator.mode, calibFiles: [...(cons.calibFiles ?? [])], ...(gateway.d.candidate ? { candidate: gateway.d.candidate.bundle } : {}) }));
      }
      if (req.method === "GET" && path === "/api/human/queue") {
        const st = url.searchParams.get("status") ?? "open";
        if (st !== "open" && st !== "closed" && st !== "all") return bad(res, "status must be open|closed|all");
        return json(res, 200, humanQueue(db, st));
      }
      if (req.method === "GET" && path === "/api/appeals") return json(res, 200, listAppeals(db));
      if (req.method === "POST" && path === "/api/contents") {
        const b = await readJson(req);
        const text = typeof b["text"] === "string" ? b["text"].trim() : "";
        const scene = String(b["scene"] ?? "");
        const wantsImage = b["image"] !== undefined || b["image_sample"] !== undefined;
        if (!text && !wantsImage) return bad(res, "text is required (or an image)");
        if (text.length > MAX_TEXT) return bad(res, `text longer than ${MAX_TEXT} characters`);
        if (!textScenes(d.bundle).includes(scene)) return bad(res, `scene must be one of ${textScenes(d.bundle).join(", ")}`, "E_SCENE_INVALID");
        const opt = (k: string): string | undefined => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
        for (const k of ["content_id", "account_id", "thread_id", "reply_to"]) if (opt(k) !== undefined && !ID_RE.test(opt(k)!)) return bad(res, `${k} must match ${ID_RE.source}`);
        const parent = b["parent"] && typeof b["parent"] === "object" ? (b["parent"] as Record<string, unknown>) : undefined;
        const parentText = parent && typeof parent["text"] === "string" ? parent["text"].trim() : "";
        if (parent && (!parentText || parentText.length > MAX_TEXT)) return bad(res, "parent.text must be 1..2000 characters");
        const parentAccount = parent && typeof parent["account_id"] === "string" && parent["account_id"] ? String(parent["account_id"]) : undefined;
        if (parentAccount !== undefined && !ID_RE.test(parentAccount)) return bad(res, `parent.account_id must match ${ID_RE.source}`);
        if (parent && opt("reply_to")) return bad(res, "give either parent or reply_to, not both");
        // an image: uploaded (base64) or a demo preset; stored in the image store under its content hash
        let imageRefs: string[] | undefined;
        if (wantsImage) {
          if (!imgs) return json(res, 400, { code: "E_IMAGE_DISABLED", message: "image intake is off (no image store configured: IMAGE_DIR)" });
          if (b["image"] !== undefined && b["image_sample"] !== undefined) return bad(res, "give either image or image_sample, not both");
          if (b["image_sample"] !== undefined) {
            const x = (imgs.samples ?? []).find((y) => y.id === b["image_sample"]);
            if (!x) return bad(res, "unknown image_sample", "E_IMAGE_SAMPLE");
            imageRefs = [x.ref];
          } else {
            const img = b["image"] && typeof b["image"] === "object" ? (b["image"] as Record<string, unknown>) : {};
            const dec = decodeImage(img["data"]);
            if ("code" in dec) return json(res, dec.status, { code: dec.code, message: dec.message });
            imageRefs = [storeImage(imgs.dir, dec.bytes, dec.ext)];
          }
        }
        const out = intakeContent(d, { text, scene: scene as core.Scene, ...(imageRefs ? { imageRefs } : {}), ...(opt("content_id") ? { contentId: opt("content_id")! } : {}), ...(opt("account_id") ? { accountId: opt("account_id")! } : {}),
          ...(opt("thread_id") ? { threadId: opt("thread_id")! } : {}), ...(opt("reply_to") ? { replyTo: opt("reply_to")! } : {}), ...(parent ? { parent: { text: parentText, ...(parentAccount ? { accountId: parentAccount } : {}) } } : {}) });
        if (out.status === 409 || out.status === 429) return json(res, out.status, { code: out.code, message: out.message });
        const contentId = out.contentId;
        if (out.duplicate) return json(res, 200, { content_id: contentId, duplicate: true });
        return json(res, 201, { content_id: contentId, duplicate: false, timeline: `/api/contents/${encodeURIComponent(contentId)}`, stream: `/api/contents/${encodeURIComponent(contentId)}/stream`, ...(imageRefs ? { images: imageRefs.length } : {}) });
      }
      // demo preset screenshots: made-up comment cards, public like the console's own assets
      if (req.method === "GET" && (mm0 = m(/^\/api\/demo\/image-samples\/([\w-]+)$/)) && cons.mode === "demo") {
        const x = (imgs?.samples ?? []).find((y) => y.id === mm0![1]);
        const loaded = x && imageStore ? imageStore.load(x.ref) : undefined;
        if (!loaded || "error" in loaded) return json(res, 404, { code: "NOT_FOUND" });
        res.writeHead(200, { "content-type": loaded.mime, "cache-control": "public, max-age=3600" });
        return void res.end(loaded.bytes);
      }
      // a content's image: content like its text, so only for a signed-in reviewer who confirms, and audited
      if (req.method === "GET" && (mm0 = m(/^\/api\/contents\/([^/]+)\/images\/(\d+)$/))) {
        const who = auth(d, req);
        if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
        if (req.headers["x-confirm"] !== "yes") return json(res, 400, { code: "E_CONFIRM_REQUIRED" });
        const id = decodeURIComponent(mm0[1]!);
        const c = core.readContent(db, id);
        const ref = c?.image_refs ? (JSON.parse(c.image_refs) as string[])[Number(mm0[2])] : undefined;
        if (!c || !ref) return json(res, 404, { code: "E_IMAGE_NOT_FOUND" });
        const loaded = imageStore?.load(ref);
        if (!loaded || "error" in loaded) return json(res, 404, { code: "E_IMAGE_NOT_FOUND" });
        core.tx(db, () => core.appendAudit(db, "restricted_view", id, who.reviewerId, { path, view: "image" }, d.now()));
        res.writeHead(200, { "content-type": loaded.mime, "cache-control": "private, no-store" });
        return void res.end(loaded.bytes);
      }
      if (req.method === "GET" && (mm0 = m(/^\/api\/contents\/([^/]+)\/stream$/))) {
        const id = decodeURIComponent(mm0[1]!);
        if (!core.readContent(db, id)) return json(res, 404, { code: "E_CONTENT_NOT_FOUND" });
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
        let last = "";
        const push = (): void => {
          try {
            const t = buildTimeline(db, id, bundleByVer, { images: timelineImages });
            if (t && t.version !== last) { last = t.version; res.write(`event: timeline\nid: ${t.version}\ndata: ${JSON.stringify(t)}\n\n`); }
          } catch (e) {
            console.error("timeline stream", core.redact(e));
          }
        };
        push();
        const poll = setInterval(push, cons.streamPollMs ?? 250);
        const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
        req.on("close", () => { clearInterval(poll); clearInterval(beat); });
        return;
      }
      if (req.method === "GET" && (mm0 = m(/^\/api\/contents\/([^/]+)$/))) {
        const id = decodeURIComponent(mm0[1]!);
        const wantRestricted = url.searchParams.get("view") === "restricted";
        if (wantRestricted) {
          const who = auth(d, req);
          if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
          if (req.headers["x-confirm"] !== "yes") return json(res, 400, { code: "E_CONFIRM_REQUIRED" });
          if (core.readContent(db, id)) core.tx(db, () => core.appendAudit(db, "restricted_view", id, who.reviewerId, { path, view: "timeline" }, d.now()));
        }
        const t = buildTimeline(db, id, bundleByVer, { restricted: wantRestricted, images: timelineImages });
        return t ? json(res, 200, t) : json(res, 404, { code: "E_CONTENT_NOT_FOUND" });
      }
      let mm: RegExpExecArray | null;
      if (req.method === "GET" && (mm = m(/^\/api\/reviews\/([^/]+)\/restricted$/))) {
        const who = auth(d, req);
        if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
        if (req.headers["x-confirm"] !== "yes") return json(res, 400, { code: "E_CONFIRM_REQUIRED" });
        const id = decodeURIComponent(mm[1]!);
        const r = core.readReview(db, id);
        if (!r) return json(res, 404, { code: "E_REVIEW_NOT_FOUND" });
        core.tx(db, () => core.appendAudit(db, "restricted_view", id, who.reviewerId, { path }, d.now()));
        const content = core.readContent(db, r.content_id);
        return json(res, 200, { review: r, content_text: content?.text ?? null, ruling: core.readRuling(db, id) ?? null,
          evidence: db.prepare("SELECT evidence_id, kind, source_ref, snapshot_seq, body_sha, body, model_view, created_at FROM evidence WHERE review_id=? ORDER BY created_at").all(id) });
      }
      if (req.method === "GET" && (mm = m(/^\/api\/reviews\/([^/]+)$/))) {
        const id = decodeURIComponent(mm[1]!);
        const r = core.readReview(db, id);
        if (!r) return json(res, 404, { code: "E_REVIEW_NOT_FOUND" });
        const rul = core.readRuling(db, id);
        return json(res, 200, {
          review: pick(r, REVIEW_PUBLIC),
          ruling: rul ? { action: rul.action, actor: rul.actor, attempt: rul.attempt, allowed_actions: rul.allowed_actions, rule_ids: rul.rule_ids, created_at: rul.created_at } : null,
          evidence: db.prepare("SELECT evidence_id, kind, source_ref, snapshot_seq, body_sha, created_at FROM evidence WHERE review_id=? ORDER BY created_at").all(id),
          judge_calls: db.prepare("SELECT judge_call_id, model, status, confirms_call_id, latency_ms, cost_micro, created_at FROM judge_call WHERE review_id=? ORDER BY created_at").all(id),
          judge_answers: db.prepare("SELECT a.judge_call_id, a.rule_id, a.question_kind, a.choice, a.calibrated_probs FROM judge_answer a JOIN judge_call c ON c.judge_call_id=a.judge_call_id WHERE c.review_id=?").all(id),
          tool_slots: db.prepare("SELECT call_id, tool, status, block_reason, created_at FROM tool_slot WHERE review_id=? ORDER BY created_at").all(id),
        });
      }
      if (req.method === "POST" && path === "/api/human/claim") {
        const who = auth(d, req);
        if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
        const b = await readJson(req);
        // with review_id: claim that item (console); without: the next one by severity and due time (original behaviour)
        const wanted = b["review_id"] === undefined ? undefined : String(b["review_id"]);
        const row = claimTask(d, who.reviewerId, wanted);
        if (!row) return json(res, 200, { review: null });
        const r = core.readReview(db, row.reviewId)!;
        const pinned = bundleOf(r);
        if (!pinned) return json(res, 409, { code: "E_BUNDLE_MISSING", message: `rules ${r.rules_ver} not stored` });
        return json(res, 200, { review: pick(r, REVIEW_PUBLIC), rules: core.rulesFor(pinned, core.readContent(db, r.content_id)!.scene).map((x) => ({ rule_id: x.ruleId, default_action: x.defaultAction })) });
      }
      if (req.method === "POST" && path === "/api/human/unclaim") {
        const who = auth(d, req);
        if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
        const b = await readJson(req);
        return unclaimTask(d, who.reviewerId, String(b["review_id"] ?? "")) ? json(res, 200, { released: true }) : json(res, 409, { code: "E_STATE_INVALID", message: "not claimed by you or already closed" });
      }
      if (req.method === "POST" && path === "/api/human/submit") {
        const who = auth(d, req);
        if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
        const b = await readJson(req);
        try {
          const out = humanRule(d, { reviewId: String(b["review_id"]), reviewerId: who.reviewerId, token: String(req.headers["authorization"]).slice(7), action: b["action"] as core.Action,
            ruleIds: (b["rule_ids"] as string[] | undefined) ?? [], reason: String(b["reason"] ?? ""), ...(b["rule_id"] && typeof b["label"] === "string" ? { feedback: { ruleId: String(b["rule_id"]), label: b["label"] } } : {}) });
          return json(res, 200, { ruling: out });
        } catch (e) {
          if (e instanceof ActionError) return json(res, e.status, { code: e.code, ...(e.message !== e.code ? { message: e.message } : {}) });
          if (core.isCoreError(e)) return json(res, e.http, { code: e.code, message: e.message, detail: e.detail });
          throw e;
        }
      }
      if (req.method === "POST" && path === "/api/appeals") {
        const b = await readJson(req);
        if (typeof b["content_id"] !== "string" || typeof b["trigger_request_id"] !== "string" || !b["trigger_request_id"]) return bad(res, "content_id and trigger_request_id are required");
        if (b["reason_code"] !== undefined && b["reason_code"] !== null && (typeof b["reason_code"] !== "string" || !/^[a-z_]{1,32}$/.test(b["reason_code"]))) return bad(res, "reason_code must match ^[a-z_]{1,32}$");
        try {
          const out = openAppeal(d, { contentId: String(b["content_id"]), triggerRequestId: String(b["trigger_request_id"]), reasonCode: (b["reason_code"] as string | null | undefined) ?? null });
          if (!out) return json(res, 404, { code: "E_REVIEW_NOT_FOUND" });
          return json(res, out.duplicate ? 200 : 201, { review_id: out.reviewId, duplicate: out.duplicate });
        } catch (e) {
          if (core.isCoreError(e)) return json(res, e.http, { code: e.code, message: e.message });
          throw e;
        }
      }
      // demo traffic: status and control (rate, pause); absent outside demo mode
      if (path === "/api/demo/traffic" && cons.mode === "demo" && cons.traffic) {
        if (req.method === "GET") return json(res, 200, cons.traffic.status());
        if (req.method === "POST") {
          // per_sec (the console's unit) or per_min (the older form); at most one of them
          const b = await readJson(req);
          const max = cons.traffic.status().max_per_sec;
          const num = (k: string, hi: number): number | undefined | null => {
            const v = b[k];
            if (v === undefined) return undefined;
            return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= hi ? v : null;
          };
          const perSec = num("per_sec", max), perMin = num("per_min", max * 60);
          if (perSec === null) return bad(res, `per_sec must be a number in 0..${max}`);
          if (perMin === null) return bad(res, `per_min must be a number in 0..${max * 60}`);
          if (perSec !== undefined && perMin !== undefined) return bad(res, "give per_sec or per_min, not both");
          if (b["paused"] !== undefined && typeof b["paused"] !== "boolean") return bad(res, "paused must be a boolean");
          const rate = perSec ?? (perMin !== undefined ? perMin / 60 : undefined);
          cons.traffic.set({ ...(rate !== undefined ? { perSec: rate } : {}), ...(b["paused"] !== undefined ? { paused: b["paused"] as boolean } : {}) });
          return json(res, 200, cons.traffic.status());
        }
      }
      if (req.method === "POST" && path === "/api/replay/pause") { gateway.replayPaused = true; return json(res, 200, { paused: true }); }
      if (req.method === "POST" && path === "/api/replay/resume") { gateway.replayPaused = false; return json(res, 200, { paused: false }); }
      json(res, 404, { code: "NOT_FOUND" });
    } catch (e) {
      if (e instanceof BadRequest) return bad(res, e.message, "E_BAD_JSON");
      if (e instanceof TooLarge) { res.setHeader("connection", "close"); return json(res, 413, { code: "E_BODY_TOO_LARGE", message: e.message }); }
      if (e instanceof ActionError) return json(res, e.status, { code: e.code, message: e.message });
      console.error("http error", core.redact(e));
      json(res, 500, { code: "INTERNAL" });
    }
  });
}
