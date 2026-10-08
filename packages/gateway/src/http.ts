// G's HTTP (docs §6.1): health, metrics (JSON + SSE), reviews (redacted), restricted view (auth + audit), human queue, appeals, replay control, static pages.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as core from "@mod/core";
import type { Db, PolicyBundle } from "@mod/core";
import type { Gateway } from "./gateway.ts";
import { DASHBOARD_HTML, HUMAN_HTML } from "./pages.ts";

export type HttpDeps = { db: Db; gateway: Gateway; bundle: PolicyBundle; humanAuth: core.HumanAuth; now: () => number };

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const html = (res: ServerResponse, body: string): void => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
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
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const m = (re: RegExp): RegExpExecArray | null => re.exec(path);
      if (req.method === "GET" && path === "/") return html(res, DASHBOARD_HTML);
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
        const row = core.tx(db, () => {
          const r = db.prepare("SELECT review_id FROM human_queue WHERE closed_at IS NULL AND (claimed_by IS NULL OR claimed_by=?) ORDER BY severity DESC, due_at LIMIT 1").get(who.reviewerId) as { review_id: string } | undefined;
          if (r) db.prepare("UPDATE human_queue SET claimed_by=?, claimed_at=? WHERE review_id=?").run(who.reviewerId, d.now(), r.review_id);
          return r;
        });
        if (!row) return json(res, 200, { review: null });
        const r = core.readReview(db, row.review_id)!;
        return json(res, 200, { review: pick(r, REVIEW_PUBLIC), rules: core.rulesFor(d.bundle, core.readContent(db, r.content_id)!.scene).map((x) => ({ rule_id: x.ruleId, default_action: x.defaultAction })) });
      }
      if (req.method === "POST" && path === "/api/human/submit") {
        const who = auth(d, req);
        if (!who) return json(res, 401, { code: "E_HUMAN_AUTH" });
        const b = await readJson(req);
        const r = core.readReview(db, String(b["review_id"]));
        if (!r) return json(res, 404, { code: "E_REVIEW_NOT_FOUND" });
        try {
          const out = core.submitRuling(db, d.bundle, { reviewId: r.review_id, actor: "human", action: b["action"] as core.Action, evidenceIds: [], ruleIds: (b["rule_ids"] as string[] | undefined) ?? [], judgeCallIds: [],
            pins: { rulesVer: r.rules_ver, calibVer: r.calib_ver, evidenceVer: r.evidence_ver }, reason: String(b["reason"] ?? ""), humanAuth: { reviewerId: who.reviewerId, token: String(req.headers["authorization"]).slice(7) } }, d.now(), d.humanAuth);
          if (b["rule_id"] && typeof b["label"] === "string") core.tx(db, () => db.prepare("INSERT INTO feedback(feedback_id, review_id, rule_id, human_label, machine_prob, created_at) VALUES (?,?,?,?,?,?)").run(core.uuid(), r.review_id, String(b["rule_id"]), String(b["label"]), null, d.now()));
          return json(res, 200, { ruling: { action: out.ruling.action, duplicate: out.duplicate } });
        } catch (e) {
          if (core.isCoreError(e)) return json(res, e.http, { code: e.code, message: e.message, detail: e.detail });
          throw e;
        }
      }
      if (req.method === "POST" && path === "/api/appeals") {
        const b = await readJson(req);
        const contentId = String(b["content_id"]);
        const scene = core.readContent(db, contentId)?.scene;
        if (!scene) return json(res, 404, { code: "E_REVIEW_NOT_FOUND" });
        const sc = d.bundle.scenes[scene];
        try {
          const out = core.createFollowupReview(db, { contentId, trigger: "appeal", triggerRequestId: String(b["trigger_request_id"]), payloadSha: core.sha256(core.canonical({ reason_code: b["reason_code"] ?? null })), pins: gateway.pins, judgeModel: d.gateway.d.judgeModel, deadlineMs: sc.deadlineMs, budgetTools: d.gateway.d.cfg.budgetTools, budgetMicro: d.gateway.d.cfg.budgetMicro, pendingVisibility: sc.pendingVisibility }, d.now());
          return json(res, out.duplicate ? 200 : 201, { review_id: out.review.review_id, duplicate: out.duplicate });
        } catch (e) {
          if (core.isCoreError(e)) return json(res, e.http, { code: e.code, message: e.message });
          throw e;
        }
      }
      if (req.method === "POST" && path === "/api/replay/pause") { gateway.replayPaused = true; return json(res, 200, { paused: true }); }
      if (req.method === "POST" && path === "/api/replay/resume") { gateway.replayPaused = false; return json(res, 200, { paused: false }); }
      json(res, 404, { code: "NOT_FOUND" });
    } catch (e) {
      console.error("http error", core.redact(e));
      json(res, 500, { code: "INTERNAL" });
    }
  });
}
