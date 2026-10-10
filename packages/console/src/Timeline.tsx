// One content's path through the system: stage summary, then each review (fast-path scores, route, agent steps,
// submit check, human task, ruling). Rendered from the /api/contents/:id timeline (live via SSE where it is shown).
import { useEffect, useState } from "react";
import { useConsole } from "./App.tsx";
import type { AgentStep, ContentTimeline, ImageInfo, JudgeRound, QuestionScore, ReviewTimeline } from "./api.ts";
import { localImages, restrictedImage } from "./images.ts";
import { ACTION, ACTOR, QUESTION, ROUTE, SCENE, TOOL, TRIGGER, reasonText } from "./labels.ts";
import { useInitialCount } from "./motion.tsx";
import { ActionBadge, Badge, Icon, Id, PhaseBadge, RouteBadge, SimTag, StateBadge, clock, duration, p2, p3, yuan, type Tone } from "./ui.tsx";

// ---------- probability rows ----------

const VERDICT: Record<QuestionScore["verdict"], { text: string; tone: Tone }> = {
  pass: { text: "低于放行线", tone: "good" }, block: { text: "达到处置线", tone: "bad" }, middle: { text: "中间带", tone: "warn" },
  flagged: { text: "命中", tone: "warn" }, clear: { text: "未命中", tone: "good" }, uncalibrated: { text: "未校准", tone: "neutral" }, missing: { text: "未作答", tone: "neutral" },
};

const pos = (x: number | null | undefined): string | undefined => (typeof x === "number" ? `${Math.min(100, Math.max(0, x * 100))}%` : undefined);

function ProbRow({ q }: { q: QuestionScore }) {
  const guard = q.kind === "guard";
  const v = VERDICT[q.verdict];
  const tip = (label: string, x: number | null | undefined): string => `${label} ${p3(x)}`;
  return (
    <div className="prob">
      <div className="q"><b>{QUESTION[q.key] ?? q.key}</b><span className="k">{q.key}</span></div>
      <div className="track" role="img" aria-label={`${q.key}：主问 ${p2(q.primary?.cal)}，复问 ${p2(q.confirm?.cal)}`}>
        <div className="rail" />
        {q.lines && !guard ? <div className="zone pass" style={{ left: 0, width: pos(q.lines.pass) }} title={`放行线 < ${q.lines.pass}`} /> : null}
        {q.lines ? <div className="zone block" style={{ left: pos(q.lines.block), right: 0 }} title={`${guard ? "命中线" : "处置线"} ≥ ${q.lines.block}`} /> : null}
        {typeof q.mean === "number" ? <div className="fill" style={{ width: pos(q.mean) }} /> : null}
        {q.lines && !guard ? <div className="line" style={{ left: pos(q.lines.pass) }} /> : null}
        {q.lines ? <div className="line" style={{ left: pos(q.lines.block) }} /> : null}
        {typeof q.primary?.raw === "number" ? <div className="mk raw" style={{ left: pos(q.primary.raw) }} title={tip("原始（主问）", q.primary.raw)} /> : null}
        {typeof q.confirm?.cal === "number" ? <div className="mk copy" style={{ left: pos(q.confirm.cal) }} title={tip("复问（校准后）", q.confirm.cal)} /> : null}
        {typeof q.primary?.cal === "number" ? <div className="mk" style={{ left: pos(q.primary.cal) }} title={tip("主问（校准后）", q.primary.cal)} /> : null}
      </div>
      <div className="nums">
        <span>主问 <b>{p2(q.primary?.cal)}</b></span>
        <span>复问 <b>{p2(q.confirm?.cal)}</b></span>
        <span title={q.temperature ? `温度 T=${q.temperature}` : undefined}>原始 {p3(q.primary?.raw)}</span>
      </div>
      <div><Badge tone={v.tone}>{v.text}</Badge></div>
    </div>
  );
}

export function JudgeRoundView({ round, compact }: { round: JudgeRound; compact?: boolean }) {
  return (
    <div>
      {!compact ? <div className="scale-row" aria-hidden="true"><div /><div className="ticks"><span>0</span><span>0.5</span><span>1</span></div><div>校准后概率</div><div /></div> : null}
      <div className="probs">{round.questions.map((q) => <ProbRow key={q.question_sha} q={q} />)}</div>
      <div className="meta-line">
        <span>{round.channel === "image" ? "图片通道" : round.stage === "fast" ? "快判" : round.explicit_confirm_of ? "复问" : "复判"} · {round.model}</span>
        <span>{round.status === "ok" ? "成功" : round.status}</span>
        <span>耗时 {duration(round.latency_ms)}</span>
        <span>费用 {yuan(round.cost_micro, 6)}</span>
        {round.copy_call_id ? <span>同次请求带打乱选项复问</span> : null}
        <span>{round.channel === "image" ? "看图片" : round.evidence_ids.length ? `证据 ${round.evidence_ids.map((e) => e.split("#").pop()).join("、")}` : "只看文本"}</span>
      </div>
    </div>
  );
}

const Legend = () => (
  <span className="mk-legend"><span><i className="f" />主问</span><span><i className="h" />复问</span><span><i className="r" />原始</span><span><i className="zp" />放行区</span><span><i className="zb" />处置区</span></span>
);

// ---------- agent steps ----------

const VISIBILITY: Record<string, string> = { visible: "对外可见", self_only: "仅作者可见", hidden: "已隐藏" };
const REL: Record<string, string> = { parent: "父评论", ancestor: "更早回复", reply: "回复", mentioned: "被@者发言", before: "此前", after: "此后" };

export function stepText(s: AgentStep): string {
  const r = (s.result ?? {}) as Record<string, unknown>;
  if (s.status === "blocked") return `被拦下：${s.block_reason ?? ""}`;
  if (s.status === "pending") return "进行中…";
  if (s.status === "rejected") return `提交检查拒绝：${String(r["code"] ?? "")}（第 ${String(r["step"] ?? "?")} 步）`;
  switch (s.tool) {
    case "load_rule": {
      const t = r["thresholds"] as { block?: number; pass?: number } | undefined;
      return `${String(s.args["rule_id"] ?? "")}：默认${ACTION[String(r["default_action"]) as keyof typeof ACTION] ?? ""}，处置线 ${t?.block ?? "—"}，放行线 ${t?.pass ?? "—"}`;
    }
    case "get_thread_context": {
      if (s.status === "reused") return "已取过，返回已有证据";
      const ns = (r["neighbors"] as { relation: string; text_len: number }[] | undefined) ?? [];
      return ns.length ? ns.map((n) => `${REL[n.relation] ?? n.relation}（${n.text_len} 字）`).join("、") : "没有可用的上下文";
    }
    case "get_account_history": {
      if (s.status === "reused") return "已取过，返回已有证据";
      const c = (r["counts"] as Record<string, number> | undefined) ?? {};
      const parts = Object.entries(c).map(([k, n]) => `${ACTION[k as keyof typeof ACTION] ?? k} ${n}`);
      const extra = [Number(r["warnings"] ?? 0) ? `警告 ${String(r["warnings"])}` : "", Number(r["appeals"] ?? 0) ? `申诉 ${String(r["appeals"])}` : ""].filter(Boolean);
      return parts.length || extra.length ? `近 7 天：${[...parts, ...extra].join(" · ")}` : "近 7 天没有处置记录";
    }
    case "judge":
    case "confirm": {
      if (s.status === "reused") return "同一请求已判过，返回上次结果";
      const sc = (r["scores"] as { key: string; mean: number | null; verdict: string }[] | undefined) ?? [];
      return sc.map((x) => `${QUESTION[x.key] ?? x.key} ${p2(x.mean)}`).join(" · ");
    }
    case "dispose": return `处置：${ACTION[String(s.args["action"]) as keyof typeof ACTION] ?? String(s.args["action"])}${(s.args["rule_ids"] as string[] | undefined)?.length ? `，依据 ${(s.args["rule_ids"] as string[]).join("、")}` : ""}；提交检查通过`;
    case "release": return `原因：${reasonText(String(s.args["reason"] ?? ""))}`;
    default: return "";
  }
}

export function StepRow({ s, t0, i }: { s: AgentStep; t0: number; i: number }) {
  const final = (s.tool === "dispose" || s.tool === "release") && s.status === "ok";
  const tone = s.status === "rejected" || s.status === "blocked" ? "bad" : s.status === "pending" ? "pending" : s.tool === "release" ? "warn" : final ? "final" : "ok";
  const chips: string[] = [];
  if (s.tool === "judge" || s.tool === "confirm" || s.tool === "dispose") for (const e of (s.args["evidence_ids"] as string[] | undefined) ?? []) chips.push(e.split("#").pop() ?? e);
  const evId = (s.result as { evidence_id?: string } | null)?.evidence_id;
  return (
    <div className={`step ${tone}`} style={{ ["--i" as string]: i }}>
      <div className="node"><i /></div>
      <div className="st">
        <b>{TOOL[s.tool] ?? s.tool}</b><span className="tool">{s.tool}</span>
        {s.status === "reused" ? <Badge>复用</Badge> : null}
        {s.attempt > 1 ? <Badge tone="warn">第 {s.attempt} 代</Badge> : null}
      </div>
      <div className="sx">+{((s.at - t0) / 1000).toFixed(1)}s</div>
      <div className="sd">{stepText(s)}</div>
      {chips.length || evId ? <div className="chips">{evId ? <span className="chip" title={evId}>→ {evId.split("#").pop()}</span> : null}{chips.map((c) => <span className="chip" key={c}>{c}</span>)}</div> : null}
    </div>
  );
}

/** Steps present when the card opened stagger in one after another; steps arriving live appear as they come. */
function Steps({ r }: { r: ReviewTimeline }) {
  const n0 = useInitialCount(r.steps.length);
  return <div className="steps">{r.steps.map((s, i) => <StepRow key={s.call_id} s={s} t0={r.created_at} i={i < n0 ? Math.min(i, 8) : 0} />)}</div>;
}

// ---------- review card ----------

export function ReviewCard({ r, restricted, t }: { r: ReviewTimeline; restricted: boolean; t?: ContentTimeline }) {
  const fast = r.judge_rounds.filter((j) => j.stage === "fast" && j.channel !== "image");
  const vision = r.judge_rounds.filter((j) => j.channel === "image");
  const agentRounds = r.judge_rounds.filter((j) => j.stage === "agent");
  const showAgent = r.route.kind === "agent" || r.route.kind === "appeal" || r.steps.length > 0;
  return (
    <article className="review">
      <header className="review-h">
        <span className="seq">第 {r.seq} 审次</span>
        <span className="faint">{TRIGGER[r.trigger] ?? r.trigger}</span>
        <RouteBadge route={r.route.kind} />
        <StateBadge state={r.state} />
        <Id value={r.review_id} className="faint" />
        <span className="when">{clock(r.created_at)}</span>
      </header>

      {r.appeal ? (
        <section className="sec"><div className="sec-h"><h3>申诉</h3></div>
          <div className="small">理由代码 <span className="mono">{r.appeal.reason_code ?? "—"}</span>。重审由 agent 重新取证判断，原裁决在新裁决形成前继续有效。</div></section>
      ) : null}

      {fast.length ? (
        <section className="sec">
          <div className="sec-h"><h3>快判打分</h3><span className="sub">{vision.length && t?.image_note ? "一次请求问全部规则（演示：脚本判官按截图的已知内容和附带文字打分），主问与打乱选项的复问都要过线" : "一次请求问全部规则，主问与打乱选项的复问都要过线"}</span><span className="end"><Legend /></span></div>
          {fast.map((j) => <JudgeRoundView key={j.judge_call_id} round={j} />)}
        </section>
      ) : null}

      {vision.length ? (
        <section className="sec">
          <div className="sec-h"><h3>视觉编码</h3><span className="sub">图片经视觉编码后回答图片检查题（武器、血腥、惊悚、二维码或联系方式），同样主问 + 复问</span></div>
          <div className="vision">
            {t?.content.images.length ? <div className="vision-img">{t.content.images.map((im) => <ImageThumb key={im.n} contentId={t.content.content_id} img={im} restricted={t.restricted} small />)}</div> : null}
            <div className="vision-b">
              {vision.map((j) => <JudgeRoundView key={j.judge_call_id} round={j} compact />)}
              {t?.image_note ? <div className="note-demo">{t.image_note}</div> : null}
            </div>
          </div>
        </section>
      ) : null}

      <section className="sec"><div className="sec-h"><h3>分流</h3></div>
        <div className="row"><RouteBadge route={r.route.kind} /><span className="muted">{routeLine(r)}</span></div></section>

      {showAgent ? (
        <section className="sec">
          <div className="sec-h"><h3>agent 调查</h3>
            <span className="sub">工具 {r.tools_used}/{r.budget_tools} 次 · 费用 {yuan(r.used_micro)}{r.cost_status === "estimated" ? "（估计）" : ""} · 模型 {r.agent_model ?? "—"}</span></div>
          {r.steps.length === 0 ? (
            <div className="small muted row">{r.state === "queued" ? <><span className="dot pulse" style={{ background: "var(--info)" }} />排队中，等待 worker 领取</> : r.state === "investigating" ? <><span className="dot pulse" style={{ background: "var(--info)" }} />已领取，agent 正在读任务说明</> : "没有工具调用"}</div>
          ) : <Steps r={r} />}
          {r.state === "investigating" && r.steps.length ? <div className="small muted row" style={{ marginTop: 6 }}><span className="dot pulse" style={{ background: "var(--info)" }} />等待下一步…</div> : null}
          {agentRounds.length ? (
            <details className="more" style={{ marginTop: 10 }}><summary>带证据复判明细（{agentRounds.length} 次）</summary>
              <div style={{ marginTop: 8, display: "grid", gap: 12 }}>{agentRounds.map((j) => <JudgeRoundView key={j.judge_call_id} round={j} compact />)}</div></details>
          ) : null}
        </section>
      ) : null}

      {r.rejections.length ? (
        <section className="sec"><div className="sec-h"><h3 style={{ color: "var(--bad)" }}>提交检查拒绝</h3></div>
          {r.rejections.map((x, i) => <div key={i} className="small">{clock(x.at)} · {ACTOR[x.actor] ?? x.actor} 提交 {x.action ? ACTION[x.action as keyof typeof ACTION] ?? x.action : ""} 被拒：<span className="mono">{x.code}</span>（第 {x.step} 步）</div>)}</section>
      ) : null}

      {r.human ? (
        <section className="sec"><div className="sec-h"><h3>人工</h3></div>
          <dl className="kv">
            <dt>转入原因</dt><dd>{reasonText(r.human.reason)}</dd>
            <dt>时限</dt><dd>{clock(r.human.due_at)} 前</dd>
            <dt>领取</dt><dd>{r.human.claimed_by ? <>{r.human.claimed_by}{r.human.claimed_by.startsWith("sim-") ? <> <SimTag title="模拟审核员（演示流量）" /></> : null}（{clock(r.human.claimed_at ?? 0)}）</> : "未领取"}</dd>
            {r.human.closed_at ? <><dt>完成</dt><dd>{r.human.closed_by}（{clock(r.human.closed_at)}）{r.human.label ? `，标注 ${r.human.label}` : ""}</dd></> : null}
          </dl></section>
      ) : null}

      {r.ruling ? (
        <section className="sec"><div className="sec-h"><h3>裁决</h3></div>
          <div className="verdict">
            <ActionBadge action={r.ruling.action} big />
            <span>由 <b>{ACTOR[r.ruling.actor] ?? r.ruling.actor}</b> 作出</span>
            {r.ruling.rule_ids.length ? <span>依据 <span className="mono">{r.ruling.rule_ids.join("、")}</span></span> : null}
            <span className="muted small">提交检查允许：{r.ruling.allowed_actions.map((a) => (a === "human" ? "人工" : ACTION[a as keyof typeof ACTION] ?? a)).join("、") || "—"}</span>
            <span className="faint small">{clock(r.ruling.created_at)} · 用时 {duration(r.ruling.created_at - r.created_at)}</span>
          </div>
          <div className="small muted" style={{ marginTop: 8, overflowWrap: "anywhere" }}>
            {r.ruling.reason_code ? <>理由：{reasonText(r.ruling.reason_code)}</> : r.ruling.reason !== null ? <>理由：{r.ruling.reason}</> : r.ruling.reason_len ? <span className="row" style={{ gap: 4 }}><Icon name="lock" size={12} />理由 {r.ruling.reason_len} 字，属受限内容{restricted ? "" : "，在受限视图中查看"}</span> : null}
          </div>
        </section>
      ) : null}
    </article>
  );
}

function routeLine(r: ReviewTimeline): string {
  switch (r.route.kind) {
    case "fast_pass": return "快判直接放行，没有进入 agent。";
    case "fast_block": return `快判直接处置（${reasonText(r.route.reason)}）。`;
    case "agent": return `转 agent 查证据：${reasonText(r.suspect_reason)}。`;
    case "human_direct": return `系统原因，直接转人工：${reasonText(r.release_reason)}。`;
    case "appeal": return "申诉开出的新审次，交 agent 重审。";
    default: return ROUTE[r.route.kind];
  }
}

// ---------- whole content ----------

type Stage = { t: string; d: string; s: "done" | "active" | "skip" | "todo" };

function stages(t: ContentTimeline): Stage[] {
  const first = t.reviews[0];
  const last = t.reviews[t.reviews.length - 1];
  const fast = first?.judge_rounds.find((j) => j.stage === "fast");
  const agentReviews = t.reviews.filter((r) => r.route.kind === "agent" || r.route.kind === "appeal");
  const agentLive = agentReviews.some((r) => r.state === "queued" || r.state === "investigating");
  const steps = agentReviews.reduce((n, r) => n + r.steps.length, 0);
  const vision = first?.judge_rounds.find((j) => j.channel === "image");
  const imgs = t.content.images.length;
  return [
    { t: "接入", d: `${SCENE[t.content.scene] ?? t.content.scene} · ${t.content.text_len} 字${imgs ? ` · ${imgs} 张图` : ""}`, s: "done" },

    { t: "快判", d: fast ? `${fast.questions.length} 题 · ${duration(fast.latency_ms)}` : first ? "未调用判官" : "等待中", s: fast || first ? "done" : "active" },
    ...(imgs ? [{ t: "视觉编码", d: vision ? `图片检查 ${p2(vision.questions[0]?.mean)}` : first ? "未调用" : "等待中", s: (vision || first ? "done" : fast ? "active" : "todo") as Stage["s"] }] : []),
    { t: "分流", d: first ? ROUTE[first.route.kind] : "—", s: first ? "done" : "todo" },
    { t: "agent 调查", d: agentReviews.length ? (agentLive ? `进行中 · ${steps} 步` : `${steps} 步`) : "未进入", s: !agentReviews.length ? (first ? "skip" : "todo") : agentLive ? "active" : "done" },
    { t: "结论", d: last?.ruling ? `${ACTION[last.ruling.action]} · ${ACTOR[last.ruling.actor] ?? last.ruling.actor}` : t.phase === "human" ? "等待人工" : "—", s: last?.ruling && t.phase === "done" ? "done" : t.phase === "human" ? "active" : "todo" },
  ];
}

export function Pipeline({ t }: { t: ContentTimeline }) {
  const st = stages(t);
  return (
    <div className="pipeline" style={{ ["--stages" as string]: st.length }}>
      {st.map((s) => <div key={s.t} className={`stage ${s.s}`}><div className="bar" /><div className="t">{s.t}</div><div className="d">{s.d}</div></div>)}
    </div>
  );
}

export function ContentHeader({ t, text, sim }: { t: ContentTimeline; text?: string | null; sim?: boolean }) {
  const demo = useConsole().config.mode === "demo";
  const shown = t.content.text ?? text ?? null;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: "6px 10px" }}>
        <Id value={t.content.content_id} />
        {sim ? <SimTag /> : null}
        <Badge>{SCENE[t.content.scene] ?? t.content.scene}</Badge>
        <PhaseBadge phase={t.phase} />
        <span className="row" style={{ gap: 6 }}><span className="small faint">当前有效处置</span><ActionBadge action={t.effective?.action ?? null} /></span>
        <span className="small faint">{VISIBILITY[t.effective?.visibility ?? ""] ?? "—"}</span>
      </div>
      {shown !== null ? (
        t.content.text !== null ? (
          demo ? <div className="content-text">{shown}</div>
            : <div className="restricted"><div className="lbl"><Icon name="lock" size={12} />受限视图：原文（本次查看已写审计）</div><div className="content-text">{shown}</div></div>
        ) : <div className="content-text">{shown}</div>
      ) : t.content.text_len || !t.content.images.length ? <div className="hidden-text"><Icon name="lock" size={12} />原文默认不展示（{t.content.text_len} 字，sha {t.content.text_sha ?? "—"}）</div> : null}
      {t.content.images.length ? <div className="thumbs">{t.content.images.map((im) => <ImageThumb key={im.n} contentId={t.content.content_id} img={im} restricted={t.restricted} />)}</div> : null}
    </div>
  );
}

/** One attached image: a preset sample or this tab's own upload is shown; anything else only through the restricted
 *  view (in it, loaded right away; otherwise behind a button that asks first). */
export function ImageThumb({ contentId, img, restricted, small }: { contentId: string; img: ImageInfo; restricted: boolean; small?: boolean }) {
  const { reviewer } = useConsole();
  const direct = img.preset?.url ?? (img.n === 0 ? localImages.get(contentId) : undefined) ?? null;
  const [url, setUrl] = useState<string | null>(direct);
  const [err, setErr] = useState<string | null>(null);
  const load = (): void => { if (reviewer) restrictedImage(contentId, img.n, reviewer).then(setUrl).catch((e) => setErr(String(e))); };
  useEffect(() => { if (!url && restricted && reviewer) load(); }, [restricted]);   // eslint-disable-line react-hooks/exhaustive-deps
  const label = img.preset ? `预置示例：${img.preset.title}` : `图片 ${img.n + 1}`;
  if (url) return <a className={`thumb ${small ? "sm" : ""}`} href={url} target="_blank" rel="noreferrer" title={label}><img src={url} alt={label} /><span className="cap">{label}</span></a>;
  return (
    <div className={`thumb locked ${small ? "sm" : ""}`}>
      <span className="row" style={{ gap: 6 }}><Icon name="lock" size={12} />{label}属受限内容</span>
      {err ? <span className="small" style={{ color: "var(--bad)" }}>{err}</span> : null}
      <button className="btn sm" disabled={!reviewer} onClick={() => { if (window.confirm("查看图片会写入审计记录，继续？")) load(); }}>查看图片</button>
    </div>
  );
}

const STEP_STATUS: Record<string, string> = { ok: "完成", reused: "复用", blocked: "被拦下", rejected: "被拒", pending: "进行中" };

export function EventFeed({ t }: { t: ContentTimeline }) {
  const evs = [...t.events].reverse();
  return (
    <div className="events" aria-live="polite">
      {evs.map((e) => (
        <div className="ev" key={e.id}><span className="tm">{clock(e.at)}</span>
          <span className="tx"><b>{e.title}</b>{e.detail ? <span className="muted"> · {e.kind === "route" || e.kind === "human_queue" ? reasonText(e.detail) : e.kind === "tool" ? STEP_STATUS[e.detail] ?? e.detail : e.detail}</span> : null}</span></div>
      ))}
    </div>
  );
}

export function ReviewCards({ t }: { t: ContentTimeline }) {
  if (t.reviews.length === 0) return <div className="review"><div className="empty"><span className="dot pulse" style={{ background: "var(--info)", marginRight: 8 }} />已进入接入队列，等待快判…</div></div>;
  return <div>{t.reviews.map((r) => <ReviewCard key={r.review_id} r={r} restricted={t.restricted} t={t} />)}</div>;
}
