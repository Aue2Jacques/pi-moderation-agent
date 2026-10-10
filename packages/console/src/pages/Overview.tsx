// Overview: the live pipeline and throughput (Flow.tsx), cumulative numbers and the latest reviews from the global live
// stream (/api/events), G's in-memory window metrics from /api/metrics (SSE). Nothing here polls.
import { useEffect, useRef, useState } from "react";
import { TOUR, useConsole } from "../App.tsx";
import type { ReviewListItem, Stats, TrafficKind, TrafficStatus } from "../api.ts";
import { useEventSource } from "../hooks.ts";
import { ACTION, ROUTE, ROUTES, demoJudgeNote, reasonText } from "../labels.ts";
import { useLive } from "../live.tsx";
import { FlowPipeline, Throughput, flowSummary } from "../Flow.tsx";
import { AnimatedNumber, useFreshIds } from "../motion.tsx";
import { ActionBadge, Alert, Empty, Id, Kpi, PageHead, Panel, RouteBadge, SimTag, StateBadge, clock, duration, pad2, pct, yuan } from "../ui.tsx";

type Metrics = { intake_rate: number; fast_rate: number; queue_intake: number; queue_agent: number; queue_human: number; outstanding_total: number; replay_paused: boolean;
  p50_fast: number; p95_fast: number; p50_agent: number; p95_agent: number; cost_micro_per_1k: number; release_pct: number; judge_abstain_pct: number; outbox_pending: number; pass_pct: number; block_pct: number; suspicious_pct: number };

type Bucket = Stats["series"][number];
const total = (b: Bucket): number => ROUTES.reduce((n, r) => n + (b[r as keyof Bucket] as number), 0);
const big = (x: number): string => Math.round(x).toLocaleString("en-US");
const hhmm = (m: number): string => { const d = new Date(m * 60_000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

/** Reviews created per minute, stacked by route (HTML bars: heights animate when a minute fills up). */
function MinuteBars({ series }: { series: Stats["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(4, ...series.map(total));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const hb = hover !== null ? series[hover] : undefined;
  return (
    <div className="bars" style={{ ["--cols" as string]: series.length }} onMouseLeave={() => setHover(null)} role="img" aria-label="每分钟新建审次，按路径堆叠">
      <div className="y">{[0, 1, 2, 3, 4].map((i) => <span key={i} style={{ top: `${100 - (i * 100) / 4}%` }}>{i * step}</span>)}</div>
      <div className="plot">
        {[1, 2, 3, 4].map((i) => <div key={i} className="gl" style={{ top: `${100 - (i * 100) / 4}%` }} />)}
        <div className="cols">
          {series.map((b, i) => (
            <div key={b.minute} className="col" onMouseEnter={() => setHover(i)}>
              {ROUTES.map((r) => {
                const v = b[r as keyof Bucket] as number;
                return <div key={r} className="bseg" style={{ height: `${(100 * v) / top}%`, background: `var(--route-${r})` }} />;
              })}
            </div>
          ))}
        </div>
        {hb ? (
          <div className="chart-tip" style={{ left: `clamp(0px, calc(${((hover! + 1) / series.length) * 100}% + 6px), calc(100% - 168px))`, top: 4 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{hhmm(hb.minute)} · 共 {total(hb)}</div>
            {ROUTES.map((r) => <div className="row" key={r}><span className="route"><span className="sw" style={{ background: `var(--route-${r})` }} />{ROUTE[r]}</span><span className="num">{hb[r as keyof Bucket]}</span></div>)}
          </div>
        ) : null}
      </div>
      <div className="x" aria-hidden="true">{series.map((b, i) => i % 5 === 4 ? <span key={b.minute} className={i === series.length - 1 ? "end" : ""} style={{ left: i === series.length - 1 ? "100%" : `${((i + 0.5) / series.length) * 100}%` }}>{hhmm(b.minute)}</span> : null)}</div>
    </div>
  );
}

const Legend = () => <div className="legend">{ROUTES.map((r) => <span key={r}><span className="sw" style={{ background: `var(--route-${r})` }} />{ROUTE[r]}</span>)}</div>;

function Meter({ rows, total: t }: { rows: [string, number][]; total: number }) {
  if (!rows.length) return <Empty>暂无</Empty>;
  return (
    <div className="meter">
      {rows.map(([k, n]) => (
        <div className="item" key={k}><span className="l">{k}</span><span className="n">{n.toLocaleString("en-US")}<span className="faint"> · {pct(n, t)}</span></span>
          <div className="track"><div className="fill" style={{ width: `${t ? (100 * n) / t : 0}%` }} /></div></div>
      ))}
    </div>
  );
}

/** `value`, but replaced at most every `ms` (a busy stream would otherwise turn a short list into a blur). */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    const wait = Math.max(0, ms - (Date.now() - last.current));
    const t = setTimeout(() => { last.current = Date.now(); setShown(latest.current); }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}

/** The latest reviews as they arrive on the live stream (at most one refresh every 1.5 s). */
function LiveFeed({ items: all }: { items: ReviewListItem[] }) {
  const { go, isSim } = useConsole();
  const items = useThrottled(all, 1500);
  const fresh = useFreshIds(items.map((r) => r.review_id), "feed");
  if (!items.length) return <Empty>暂无审核记录</Empty>;
  return (
    <div className="feed-list" aria-live="polite">
      {items.map((r) => (
        <div key={r.review_id} className={`feed-row ${fresh.has(r.review_id) ? "fresh" : ""}`} role="link" tabIndex={0} onClick={() => go(`/contents/${encodeURIComponent(r.content_id)}`)} onKeyDown={(e) => { if (e.key === "Enter") go(`/contents/${encodeURIComponent(r.content_id)}`); }}>
          <span className="tm">{clock(r.created_at)}</span>
          <span className="what"><RouteBadge route={r.route} />{isSim(r.content_id) ? <SimTag /> : <Id value={r.content_id} short className="faint" />}</span>
          <span className="out">{r.action ? <ActionBadge action={r.action} /> : <StateBadge state={r.state} />}</span>
        </div>
      ))}
    </div>
  );
}

const KIND: Record<TrafficKind, string> = { normal: "正常", marketing: "营销", abuse: "辱骂", mild: "轻度辱骂", banter: "需看上下文", repeat: "需看账号历史", injection: "注入" };

const mb = (b: number | null | undefined): string => (b === null || b === undefined ? "—" : `${(b / 1e6).toFixed(1)} MB`);

function TrafficPanel({ t }: { t: TrafficStatus }) {
  const sum = t.generated || 1;
  const r = t.retention ?? null;
  return (
    <Panel title="模拟流量" sub={t.paused || t.per_sec === 0 ? "已暂停" : `每秒约 ${t.per_sec} 条`}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="trio">
          <Kpi label="已生成" value={<AnimatedNumber value={t.generated} format={(x) => Math.round(x).toLocaleString("en-US")} />} />
          <Kpi label="模拟审核员已处理" value={<AnimatedNumber value={t.sim_reviewer.decided} format={(x) => Math.round(x).toLocaleString("en-US")} />} />
          <Kpi label="模拟申诉" value={<AnimatedNumber value={t.appeals} />} />
        </div>
        <div className="meter two">
          {(Object.keys(KIND) as TrafficKind[]).map((k) => (
            <div className="item" key={k}><span className="l">{KIND[k]}</span><span className="n">{t.by_kind[k].toLocaleString("en-US")}</span>
              <div className="track"><div className="fill" style={{ width: `${(100 * t.by_kind[k]) / sum}%` }} /></div></div>
          ))}
        </div>
        <dl className="kv">
          <dt>模拟审核员</dt><dd>{t.sim_reviewer.id}，每分钟可处理 {t.sim_reviewer.per_min} 条；处理中 {t.sim_reviewer.thinking} 条，待处理 {t.sim_reviewer.open_sim_tasks} 条</dd>
          <dt>保留</dt><dd>{r ? <>保留最近 {r.keep.toLocaleString("en-US")} 条，已清理较早的 {r.pruned.toLocaleString("en-US")} 条，累计统计不受影响。数据库 {mb(r.db_bytes)}</> : "不清理"}</dd>
        </dl>
        <div className="small faint">以上内容由演示程序按设定比例自动生成，ID 以 sim- 开头。模拟审核员仅处理这些内容，不处理手动提交的内容。</div>
      </div>
    </Panel>
  );
}

/** The overview's head section: throughput numbers, the pipeline, the five-minute curve. */
function Hero() {
  const { config } = useConsole();
  const live = useLive();
  const f = live.frame;
  const sum = flowSummary(f?.flow ?? null);
  const d = f?.stats;
  const t = f?.traffic;
  return (
    <section className="hero" aria-label="实时处理">
      <div className="hero-top">
        <div className="hero-big">
          <span className="lbl"><span className={`dot ${live.connected ? "pulse" : ""}`} />每秒处理</span>
          <span className="v"><AnimatedNumber value={sum.now} format={(x) => x.toFixed(x >= 100 ? 0 : 1)} /><span className="u">条 / 秒</span></span>
          <span className="sub">近 5 秒均值{config.mode === "demo" ? (config.demo_corpus ? "；评论取自真实测试集" : "；演示数据") : ""}</span>
        </div>
        <div className="hero-stats">
          <div><span className="k">5 分钟均值</span><span className="v num">{sum.avg.toFixed(1)}<small> /s</small></span></div>
          <div><span className="k">峰值</span><span className="v num">{sum.peak}<small> /s</small></span></div>
          <div title="近 1 分钟内单条评论的快判用时，不含排队时间"><span className="k">快判用时 p50 · p95</span><span className="v num">{f?.flow?.p50_ms != null ? `${duration(f.flow.p50_ms)} · ${duration(f.flow.p95_ms)}` : "—"}</span></div>
          <div><span className="k">agent 处理中</span><span className="v num">{d ? d.agent.open : "—"}</span></div>
          {t ? <div><span className="k">模拟流量</span><span className="v num">{t.paused || t.per_sec === 0 ? "暂停" : <>{t.per_sec}<small> /s</small></>}</span></div> : null}
        </div>
      </div>
      <div className="hero-flow"><FlowPipeline frame={f ?? null} /></div>
      <div className="hero-curve">
        <div className="hero-curve-h"><span>处理速度</span><span className="faint">近 5 分钟每秒完成审核的条数</span></div>
        <Throughput flow={f?.flow ?? null} />
      </div>
    </section>
  );
}

/** First visit: where to go next, in the suggested order (the sidebar is easy to miss, on phones it is a drawer). */
function Guide() {
  const [hidden, setHidden] = useState<boolean>(() => { try { return localStorage.getItem("console.guide.hidden") === "1"; } catch { return false; } });
  if (hidden) return null;
  const hide = (): void => { setHidden(true); try { localStorage.setItem("console.guide.hidden", "1"); } catch { /* not persisted */ } };
  return (
    <section className="guide" aria-label="从这里开始">
      <div className="guide-h"><span>首次访问建议按以下顺序浏览，每页底部均可进入下一页</span><button className="btn sm ghost" onClick={hide}>不再显示</button></div>
      <div className="guide-cards">
        {TOUR.slice(1, 5).map((x, i) => (
          <a key={x.id} className="gcard-l" href={`#/${x.id}`}>
            <span className="gl-n num">{i + 1}</span>
            <span className="gl-t">{x.label} →</span>
            <span className="gl-w">{x.why}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export function Overview() {
  const { config } = useConsole();
  const live = useLive();
  const { data: m, connected } = useEventSource<Metrics>("/api/metrics");
  const head = <PageHead title="概览" desc={config.mode === "demo" ? `所有数据实时更新。当前为演示环境：${demoJudgeNote(config)}。` : "所有数据实时更新。"} />;
  if (!live.frame) return <>{head}<Guide /><Panel><Empty>{live.connected ? "加载中…" : "正在连接实时数据流…"}</Empty></Panel></>;
  const d = live.frame.stats;
  const finished = Math.max(0, d.reviews - d.agent.open - d.human.open);
  const auto = d.routes.fast_pass + d.routes.fast_block + d.agent.disposed;
  const routeTotal = ROUTES.reduce((n, r) => n + d.routes[r], 0);
  const effTotal = Object.values(d.effective).reduce((a, b) => a + b, 0);
  const relTotal = Object.values(d.release_reasons).reduce((a, b) => a + b, 0);

  return (
    <>
      {head}
      <Guide />
      {d.contents === 0 ? <Alert tone="info">暂无内容。可在“提交与追踪”中提交一条{config.mode === "demo" ? "，或在顶栏开启模拟流量" : ""}。</Alert> : null}
      <Hero />
      <div className="kpis" style={{ ["--n" as string]: 5 }}>
        <Kpi label="已接入内容" value={<AnimatedNumber value={d.contents} format={big} />} foot={`已快判 ${big(d.judged)} · 审次 ${big(d.reviews)}`} />
        <Kpi label="自动完成率" value={finished ? <AnimatedNumber value={(100 * auto) / finished} format={(x) => `${x.toFixed(1)}%`} /> : "—"} foot={`快判 ${big(d.routes.fast_pass + d.routes.fast_block)} · agent 处置 ${big(d.agent.disposed)} / 已结束 ${big(finished)}`} />
        <Kpi label="agent 处理中" value={<AnimatedNumber value={d.agent.open} />} foot={`已处置 ${big(d.agent.disposed)} · 交人工 ${big(d.agent.released)}`} />
        <Kpi label="人工队列" value={<AnimatedNumber value={d.human.open} />} tone={d.human.overdue ? "warn" : undefined} foot={`已领取 ${d.human.claimed} · 超时 ${d.human.overdue} · 已完成 ${big(d.human.closed)}`} />
        <Kpi label="每条平均费用" value={<AnimatedNumber value={d.cost.per_content_micro} format={(x) => yuan(x, 5)} />} foot={`快判 ${yuan(d.cost.fast_micro, 2)} · 审次 ${yuan(d.cost.review_micro, 2)}`} />
      </div>

      <div className="grid g-main">
        <Panel title="分流" sub="近 30 分钟，每分钟内容的流向" actions={<Legend />} className="fill">
          <MinuteBars series={d.series} />
        </Panel>
        <Panel title="最新审次" sub="实时更新" flush>
          <LiveFeed items={live.recent.slice(0, 9)} />
        </Panel>
      </div>

      <div className="grid g-4">
        <Panel title="各路占比" sub={`累计 ${big(routeTotal)} 个审次`}>
          <div className="stack" style={{ gap: 14 }}>
            <div className="share" role="img" aria-label="各路占比">{ROUTES.filter((r) => d.routes[r]).map((r) => <div key={r} title={`${ROUTE[r]} ${d.routes[r]}`} style={{ width: `${(100 * d.routes[r]) / Math.max(1, routeTotal)}%`, background: `var(--route-${r})` }} />)}</div>
            <div className="meter">
              {ROUTES.map((r) => <div className="item" key={r}><span className="l route"><span className="sw" style={{ background: `var(--route-${r})` }} />{ROUTE[r]}</span><span className="n">{big(d.routes[r])}<span className="faint"> · {pct(d.routes[r], routeTotal)}</span></span></div>)}
            </div>
          </div>
        </Panel>
        <Panel title="用时" sub="近 2000 条">
          <div className="lat">
            <span className="h">阶段</span><span className="h v">p50</span><span className="h v">p95</span>
            <span>接收至快判完成</span><span className="v">{duration(d.latency_ms.fast_p50)}</span><span className="v">{duration(d.latency_ms.fast_p95)}</span>
            <span>agent 审核</span><span className="v">{duration(d.latency_ms.agent_p50)}</span><span className="v">{duration(d.latency_ms.agent_p95)}</span>
            <span>人工处理</span><span className="v">{duration(d.latency_ms.human_p50)}</span><span className="v faint">—</span>
          </div>
        </Panel>
        <Panel title="当前处置结果" sub={`${big(effTotal)} 条内容`}>
          <Meter rows={Object.entries(d.effective).map(([k, n]) => [k === "pending" ? "审核中" : ACTION[k as keyof typeof ACTION] ?? k, n])} total={effTotal} />
        </Panel>
        <Panel title="转人工原因" sub={`共 ${big(relTotal)} 次`}>
          <Meter rows={Object.entries(d.release_reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => [reasonText(k), n])} total={relTotal} />
        </Panel>
      </div>

      <div className="grid g-2 align-start">
        <div className="stack" style={{ gap: 16 }}>
          <Panel title="申诉">
            <div className="trio">
              <Kpi label="申诉总数" value={<AnimatedNumber value={d.appeals.total} />} />
              <Kpi label="处理中" value={<AnimatedNumber value={d.appeals.open} />} />
              <Kpi label="改判" value={<AnimatedNumber value={d.appeals.changed} />} />
            </div>
          </Panel>
          <Panel title="网关实时指标" sub={connected ? "每秒更新" : "未连接"}>
            {!m ? <Empty>等待数据…</Empty> : (
              <dl className="kv">
                <dt>接入速率</dt><dd className="num">{m.intake_rate.toFixed(2)} 条/秒</dd>
                <dt>队列：接入 / agent / 人工</dt><dd className="num">{m.queue_intake} / {m.queue_agent} / {m.queue_human}</dd>
                <dt>快判 p50 / p95</dt><dd className="num nowrap">{duration(m.p50_fast)} / {duration(m.p95_fast)}</dd>
                <dt>未完成</dt><dd className="num">{m.outstanding_total}{m.replay_paused ? "（积压过多，已暂停接收）" : ""}</dd>
                <dt>近 1 分钟：放行 / 处置 / 存疑</dt><dd className="num">{m.pass_pct}% / {m.block_pct}% / {m.suspicious_pct}%</dd>
                <dt>每千条费用</dt><dd className="num">{yuan(m.cost_micro_per_1k, 3)}</dd>
                <dt>近 5 分钟转人工占比</dt><dd className="num">{m.release_pct}%</dd>
                <dt>判官弃答率 · 待投递</dt><dd className="num">{m.judge_abstain_pct}% · {m.outbox_pending}</dd>
              </dl>
            )}
          </Panel>
        </div>
        {live.frame.traffic ? <TrafficPanel t={live.frame.traffic} /> : null}
      </div>
    </>
  );
}
