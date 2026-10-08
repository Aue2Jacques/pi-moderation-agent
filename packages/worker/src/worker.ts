// Worker process W: startup barrier (§7.3), admission (§8.2), host loop (§8.4), /sessions data (§6.2).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { Harness, createRegistry, type Conversation, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import * as core from "@mod/core";
import type { Db, ReviewRow } from "@mod/core";
import { buildModerationExtension, type ExtensionDeps } from "./extension.ts";
import { crashAt } from "./crash.ts";
import { UsageDoc } from "@earendil-works/pi-durable";
import { Grants, type Grant } from "./grants.ts";
import { taskBrief } from "./brief.ts";
import { HostLoop } from "./host-loop.ts";

const ctx = BACKGROUND_CONTEXT;
// durable ids are numbers; app.db stores them as text
const convId = (s: string): ConversationId => Number(s) as unknown as ConversationId;
const subId = (s: string): SubmissionId => Number(s) as unknown as SubmissionId;

export type WorkerOptions = Omit<ExtensionDeps, "grants" | "hostLoop" | "db"> & {
  db: Db;
  storage: Storage;
  models: Models;
  admitMax: number;
  /** model to run each review with (tests use per-review faux providers) */
  modelFor: (review: ReviewRow) => { provider: string; modelId: string };
  instructions: string;
  /** test hook: wait function so tests can advance virtual time */
  sleep?: (ms: number) => Promise<void>;
};

export type SessionInfo = { conversationId: string; reviewId: string; mode: Grant["mode"]; liveTasks: number; submission: string | null };

export class Worker {
  readonly grants = new Grants();
  readonly hostLoop = new HostLoop();
  readonly harness: Harness;
  readonly #o: WorkerOptions;
  readonly #deps: ExtensionDeps;
  #started = false;
  /** wall clock of harness.resume(); null until started (H-27) */
  resumedAt: number | null = null;

  private constructor(o: WorkerOptions, harness: Harness, deps: ExtensionDeps) {
    this.#o = o;
    this.harness = harness;
    this.#deps = deps;
  }

  /** Step 1: open without starting the scheduler. */
  static async open(o: WorkerOptions): Promise<Worker> {
    const grants = new Grants();
    const hostLoop = new HostLoop();
    const deps: ExtensionDeps = { ...o, grants, hostLoop };
    const registry = createRegistry();
    registry.install(buildModerationExtension(deps));
    const harness = await Harness.open(o.storage, {
      models: o.models, registry,
      settings: { stream: { timeoutMs: 15_000, maxRetries: 0 }, retry: { maxRetries: 1, baseDelayMs: 2000 }, toolExecution: "sequential", compaction: { enabled: false } },
      onReport: (e) => console.error("extension failure", core.redact(e)),
    }, ctx);
    core.storeBundle(o.db, o.bundle, o.ruleTexts, o.now());   // this worker's own version is always continuable
    const w = new Worker(o, harness, deps);
    (w as { grants: Grants }).grants = grants;
    (w as { hostLoop: HostLoop }).hostLoop = hostLoop;
    return w;
  }

  get workerId(): string {
    return this.#o.workerId;
  }

  /** Steps 2–8 of §7.3. */
  async start(): Promise<{ active: string[]; finalize: string[]; revoked: string[]; deferred: string[]; waitedMs: number }> {
    if (this.#started) throw new Error("already started");
    const db = this.#o.db;
    const now = this.#o.now;
    const ins = await this.harness.inspect(ctx);
    if (ins.scheduling !== "paused") throw new Error(`expected paused scheduler, got ${ins.scheduling}`);
    const liveByConv = new Map<string, number>();
    for (const t of ins.tasks) liveByConv.set(String(t.record.conversationId), (liveByConv.get(String(t.record.conversationId)) ?? 0) + 1);
    const rows = db.prepare("SELECT * FROM review WHERE conversation_id IS NOT NULL AND state IN ('queued','investigating','human_queue','disposed','human_disposed')").all() as ReviewRow[];
    const candidates = rows.filter((r) => !core.isTerminal(r.state) || liveByConv.has(r.conversation_id!))
      .sort((a, b) => a.created_at - b.created_at);   // R3: oldest first, the same order as admitOnce
    // step 4: wait for live leases held by a dead instance
    const liveLeases = candidates.filter((r) => r.state === "investigating" && (r.lease_until ?? 0) >= now());
    const waitUntil = Math.max(0, ...liveLeases.map((r) => r.lease_until ?? 0));
    const waitedMs = waitUntil > now() ? waitUntil - now() + 1 : 0;
    if (waitedMs > 0) await (this.#o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(waitedMs);
    const out = { active: [] as string[], finalize: [] as string[], revoked: [] as string[], deferred: [] as string[], waitedMs };
    for (const r0 of candidates) {
      const r = core.requireReview(db, r0.review_id);
      const conv = r.conversation_id!;
      if (core.isTerminal(r.state)) { this.grants.set(conv, this.#grant("finalize", r)); out.finalize.push(r.review_id); continue; }
      if (r.state === "human_queue") { this.grants.set(conv, this.#grant("revoked", r)); out.revoked.push(r.review_id); continue; }
      if (out.active.length >= this.#o.admitMax) {
        // R3: recovery obeys the same limit as admission. Over the limit, take no lease; a session whose task Pi is
        // about to resume gets a revoked grant (its tools refuse) and is aborted after resume — the conversation and
        // its evidence stay, and admitOnce picks the review up as the next generation when a slot frees.
        if (liveByConv.has(conv)) this.grants.set(conv, this.#grant("revoked", r));
        out.deferred.push(r.review_id);
        continue;
      }
      try {
        const leased = core.acquireLease(db, r.review_id, this.#o.workerId, this.#o.cfg, now());
        if (!this.#bundleFor(leased)) {   // pinned version unavailable here: hand to human, never run under another bundle
          this.#releaseBundleMissing(leased);
          this.grants.set(conv, this.#grant("revoked", core.requireReview(db, r.review_id)));
          out.revoked.push(r.review_id);
          continue;
        }
        this.grants.set(conv, this.#grant("active", leased));
        out.active.push(r.review_id);
      } catch (e) {
        if (!core.isCoreError(e)) throw e;
        const again = core.requireReview(db, r.review_id);
        if (core.isTerminal(again.state)) { this.grants.set(conv, this.#grant("finalize", again)); out.finalize.push(r.review_id); }
        else { this.grants.set(conv, this.#grant("revoked", again)); out.revoked.push(r.review_id); }
      }
    }
    // step 7
    this.resumedAt = now();
    this.harness.resume();
    this.#started = true;
    // step 8: submission gaps of the current generation, idempotent by requestId (R2: a submission bound by an
    // earlier generation does not count — that generation's task may have ended, leaving this lease without work).
    // A conversation whose earlier task was just resumed already has its work; submitting again would only add a turn.
    const live = new Set((await this.harness.inspect(ctx)).tasks.map((t) => String(t.record.conversationId)));
    for (const id of out.active) {
      const r = core.requireReview(db, id);
      if (r.submission_id && r.submission_attempt === r.attempt) continue;
      if (live.has(r.conversation_id!)) continue;
      const conv = await this.harness.conversation(convId(r.conversation_id!), ctx);
      if (!conv) continue;
      const sub = await conv.submit({ type: "input", ...this.#generationInput(r) }, ctx);
      core.bindSubmission(db, r.review_id, r.attempt, String(sub.id));
    }
    // revoked: abort now; deferred (over the admission limit): stop the resumed task, keep the session for later
    for (const id of out.revoked) {
      const conv = this.grants.conversationOf(id);
      if (conv) this.hostLoop.request({ conversationId: conv, kind: "abort", reason: "revoked" });
    }
    for (const id of out.deferred) {
      const conv = this.grants.conversationOf(id);
      if (conv) this.hostLoop.request({ conversationId: conv, kind: "abort", reason: "deferred" });
    }
    await this.pumpHost();
    return out;
  }

  /** The input that starts a generation: one requestId per generation, so re-submitting after a crash is idempotent. */
  #generationInput(r: ReviewRow): { content: string; requestId: string } {
    // closeout fix 5: the confirmation rule the agent is told follows this review's pinned scene config (deterministic
    // for a given review, so a resubmission after a crash carries the same text under the same requestId)
    const bundle = this.#bundleFor(r)?.bundle;
    const note = confirmNote(bundle?.scenes[core.readContent(this.#o.db, r.content_id)!.scene as core.Scene]);
    // dev plan §3: the review's own task (why suspicious, where it is stuck, what to verify, evidence, budget, stop rule)
    const brief = bundle ? taskBrief(this.#o.db, r, bundle) : "";
    return r.attempt === 1
      ? { content: `${this.#o.instructions}\n${brief}\n${note}`, requestId: r.review_id }
      : { content: `上一代次已中止；已有证据仍可引用。继续审核。\n${note}`, requestId: `${r.review_id}#a${r.attempt}` };
  }

  readonly #bundles = new Map<string, core.StoredBundle>();
  /** The bundle a review is pinned to: this worker's own, or one stored by G (round-9 item 12). undefined → not continuable here. */
  #bundleFor(r: ReviewRow): core.StoredBundle | undefined {
    if (r.rules_ver === this.#o.bundle.rulesVer) return { bundle: this.#o.bundle, texts: this.#o.ruleTexts };
    const cached = this.#bundles.get(r.rules_ver);
    if (cached) return cached;
    const stored = core.loadStoredBundle(this.#o.db, r.rules_ver);
    if (stored) this.#bundles.set(r.rules_ver, stored);
    return stored;
  }

  #releaseBundleMissing(leased: ReviewRow): void {
    const scene = core.readContent(this.#o.db, leased.content_id)!.scene;
    const sc = this.#o.bundle.scenes[scene];
    try {
      core.releaseToHuman(this.#o.db, leased.review_id, { kind: "agent", workerId: this.#o.workerId, attempt: leased.attempt, usedMicro: 0, costStatus: "settled" }, "bundle_missing", sc.defaultSeverity, sc.humanSlaMs, this.#o.now());
    } catch (e) {
      if (!core.isCoreError(e)) throw e;
    }
  }

  #grant(mode: Grant["mode"], r: ReviewRow): Grant {
    const b = this.#bundleFor(r) ?? { bundle: this.#o.bundle, texts: this.#o.ruleTexts };   // non-active grants only finalize/abort; the bundle is not consulted
    return { mode, reviewId: r.review_id, contentId: r.content_id, attempt: r.attempt, pins: { rulesVer: r.rules_ver, calibVer: r.calib_ver, evidenceVer: r.evidence_ver, pricesVer: r.prices_ver },
      bundle: b.bundle, ruleTexts: b.texts,
      modelId: r.agent_model ?? this.#o.modelFor(r).modelId, budgetTools: r.budget_tools, budgetMicro: r.budget_micro, roundStartedAt: this.#o.now(), modelCalls: 0 };
  }

  /** Admit queued (or lease-expired) reviews up to admitMax. */
  async admitOnce(): Promise<string[]> {
    if (!this.#started) throw new Error("start() first");
    const db = this.#o.db;
    const free = this.#o.admitMax - this.grants.count("active");
    if (free <= 0) return [];
    const now = this.#o.now();
    const rows = db.prepare("SELECT * FROM review WHERE (state='queued' OR (state='investigating' AND lease_until < ?)) AND deadline_at > ? ORDER BY created_at LIMIT ?").all(now, now, free) as ReviewRow[];
    const admitted: string[] = [];
    for (const r of rows) {
      if (this.grants.conversationOf(r.review_id)) continue;   // still held in this process (lease lost mid-run): host loop must abort first
      let leased: ReviewRow;
      try {
        leased = core.acquireLease(db, r.review_id, this.#o.workerId, this.#o.cfg, this.#o.now());
      } catch (e) {
        if (core.isCoreError(e)) continue;
        throw e;
      }
      if (!this.#bundleFor(leased)) { this.#releaseBundleMissing(leased); continue; }
      const model = this.#o.modelFor(leased);
      let conv: Conversation;
      if (leased.conversation_id) {
        conv = (await this.harness.conversation(convId(leased.conversation_id), ctx))!;
      } else {
        conv = await this.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, instructions: this.#o.instructions } }, ctx);
        if (!core.bindConversation(db, leased.review_id, String(conv.id))) {
          const again = core.requireReview(db, leased.review_id);
          conv = (await this.harness.conversation(convId(again.conversation_id!), ctx))!;
        }
      }
      const g = this.#grant("active", leased);
      g.modelId = model.modelId;
      this.grants.set(String(conv.id), g);
      crashAt("S1", leased.attempt);
      const sub = await conv.submit({ type: "input", ...this.#generationInput(leased), whenBusy: "reject" }, ctx);
      crashAt("S2", leased.attempt);
      core.bindSubmission(db, leased.review_id, leased.attempt, String(sub.id));
      admitted.push(leased.review_id);
    }
    return admitted;
  }

  /** Process host-loop requests: release (T5 by agent) then abort; abort; finished → abort + waitForIdle. */
  async pumpHost(): Promise<number> {
    const db = this.#o.db;
    let n = 0;
    for (const r of this.hostLoop.take()) {
      n++;
      const g = this.grants.get(r.conversationId);
      const conv = await this.harness.conversation(convId(r.conversationId), ctx);
      if (r.kind === "release" && g && g.mode === "active" && !core.hasTerminal(db, g.reviewId)) {
        const scene = core.readContent(db, g.contentId)!.scene;
        const sp = core.spentFromLedger(db, this.#o.prices, g.reviewId);   // round-9 item 7: real cost at host-triggered release
        try {
          core.releaseToHuman(db, g.reviewId, { kind: "agent", workerId: this.#o.workerId, attempt: g.attempt, usedMicro: sp.spent, costStatus: sp.settled ? "settled" : "estimated" },
            r.reason as core.ReleaseReason, g.bundle.scenes[scene].defaultSeverity, g.bundle.scenes[scene].humanSlaMs, this.#o.now());
        } catch (e) {
          if (!core.isCoreError(e)) throw e;
        }
      }
      if (conv) {
        await conv.abort(ctx);
        await conv.waitForIdle(ctx);
      }
      if (g) {
        const review = core.readReview(db, g.reviewId);
        if (review && (core.isTerminal(review.state) || review.state === "human_queue")) this.#settleCost(g);
      }
      this.grants.delete(r.conversationId);
    }
    return n;
  }

  /** Final cost from the ledger (model_call + tool_request), replacing whatever the release/dispose path wrote (round-9 item 7). */
  #settleCost(g: Grant): void {
    const db = this.#o.db;
    const r = core.readReview(db, g.reviewId);
    if (!r) return;
    const sp = core.spentFromLedger(db, this.#o.prices, g.reviewId);
    core.updateReviewCost(db, g.reviewId, sp.spent, sp.settled ? "settled" : "estimated", r.over_budget_micro, this.#o.now());
  }

  /** Poll worker_command (abort) for reviews this process holds. */
  async pollCommands(): Promise<number> {
    const db = this.#o.db;
    const rows = db.prepare("SELECT command_id, review_id, attempt FROM worker_command WHERE status='pending'").all() as { command_id: string; review_id: string; attempt: number }[];
    let n = 0;
    for (const c of rows) {
      const conv = this.grants.conversationOf(c.review_id);
      const g = conv ? this.grants.get(conv) : undefined;
      const match = !!g && g.attempt === c.attempt;
      if (match) this.hostLoop.request({ conversationId: conv!, kind: "abort", reason: "revoked" });
      core.tx(db, () => db.prepare("UPDATE worker_command SET status=?, done_at=? WHERE command_id=?").run(match ? "done" : "ignored", this.#o.now(), c.command_id));
      n++;
    }
    await this.pumpHost();
    return n;
  }

  async heartbeat(): Promise<void> {
    for (const [conv, g] of this.grants.entries()) {
      if (g.mode !== "active") continue;
      try {
        core.renewLease(this.#o.db, g.reviewId, this.#o.workerId, g.attempt, this.#o.cfg, this.#o.now());
      } catch (e) {
        if (core.isCoreError(e)) this.hostLoop.request({ conversationId: conv, kind: "abort", reason: "revoked" });
        else throw e;
      }
    }
    await this.pumpHost();
  }

  async waitIdle(): Promise<void> {
    await this.harness.waitForIdle(ctx);
    await this.pumpHost();
  }

  async sessions(): Promise<SessionInfo[]> {
    const ins = await this.harness.inspect(ctx);
    const live = new Map<string, number>();
    for (const t of ins.tasks) live.set(String(t.record.conversationId), (live.get(String(t.record.conversationId)) ?? 0) + 1);
    const out: SessionInfo[] = [];
    for (const [conv, g] of this.grants.entries()) {
      const r = core.readReview(this.#o.db, g.reviewId);
      let submission: string | null = null;
      if (r?.submission_id) {
        const s = await this.harness.submission(subId(r.submission_id), ctx);
        submission = s ? (await s.status(ctx)).status : null;
      }
      out.push({ conversationId: conv, reviewId: g.reviewId, mode: g.mode, liveTasks: live.get(conv) ?? 0, submission });
    }
    return out;
  }

  /**
   * Stage-① known gap: reconcile the cost ledger with Pi's own usage record. For every conversation the ledger has model
   * calls for, Pi's pi.usage document (read-only snapshot, no scheduling) is summed per model and compared with the
   * ledger's model_call rows of the same conversations. Conversations this store does not hold are counted, not compared.
   */
  async usageReconcile(): Promise<{ conversations: number; notInStore: number; pi: core.UsageTotals; ledger: core.UsageTotals; diffs: ReturnType<typeof core.compareUsage> }> {
    const convs = (this.#o.db.prepare("SELECT DISTINCT conversation_id FROM model_call").all() as { conversation_id: string }[]).map((r) => r.conversation_id);
    const pi: Record<string, core.Usage> = {};
    const held: string[] = [];
    for (const c of convs) {
      const u = await this.harness.snapshot(UsageDoc, convId(c), ctx);
      if (!u) continue;
      held.push(c);
      for (const [k, x] of Object.entries(u.models as Record<string, core.Usage>)) {
        const t = (pi[k] ??= { input: 0, output: 0, cacheRead: 0 });
        t.input += x.input ?? 0; t.output += x.output ?? 0; t.cacheRead = (t.cacheRead ?? 0) + (x.cacheRead ?? 0);
      }
    }
    const ledger = core.ledgerUsageByModel(this.#o.db, held);
    const piTotals: core.UsageTotals = Object.fromEntries(Object.entries(pi).map(([k, x]) => [k, { input: x.input, output: x.output, cacheRead: x.cacheRead ?? 0 }]));
    return { conversations: held.length, notInStore: convs.length - held.length, pi: piTotals, ledger, diffs: core.compareUsage(pi, ledger) };
  }

  #timers: NodeJS.Timeout[] = [];
  /** Real-run loops: heartbeat (T3'), host pump, command poll. Tests drive these by hand instead. */
  startLoops(o: { heartbeatMs?: number; pumpMs?: number } = {}): void {
    const guardAsync = (fn: () => Promise<unknown>) => () => { fn().catch((e) => console.error("loop error", core.redact(e))); };
    this.#timers.push(setInterval(guardAsync(() => this.heartbeat()), o.heartbeatMs ?? 5_000));
    this.#timers.push(setInterval(guardAsync(async () => { await this.pollCommands(); await this.pumpHost(); }), o.pumpMs ?? 500));
    for (const t of this.#timers) t.unref();
  }
  stopLoops(): void {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
  }

  async close(): Promise<void> {
    this.stopLoops();
    await this.harness.close(ctx);
  }
}

/** What the agent is told about confirmation for one review (closeout fix 5): required when the scene config of the
 *  review's pinned rules version requires it (the default), otherwise an optional re-check. */
export function confirmNote(scene: core.SceneConfig | undefined): string {
  return scene?.confirmPass === false
    ? "本审次放行不需要 confirm：confirm 是可选复核，不是放行的前提。"
    : "本审次放行前必须先用 confirm 对同一证据复问一次。";
}

