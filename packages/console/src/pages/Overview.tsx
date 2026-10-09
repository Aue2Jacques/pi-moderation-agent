// Overview: the live pipeline and throughput (Flow.tsx), cumulative numbers and the latest reviews from the global live
// stream (/api/events), G's in-memory window metrics from /api/metrics (SSE). Nothing here polls.
import { useEffect, useRef, useState } from "react";
import { useConsole } from "../App.tsx";
import type { ReviewListItem, Stats, TrafficKind, TrafficStatus } from "../api.ts";
import { useEventSource } from "../hooks.ts";
import { ACTION, ROUTE, ROUTES, reasonText } from "../labels.ts";
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
  if (!items.length) return <Empty>还没有审次</Empty>;
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
          <dt>模拟审核员</dt><dd>{t.sim_reviewer.id} · 当前产能每分钟 {t.sim_reviewer.per_min} 条 · 处理中 {t.sim_reviewer.thinking} · 待处理模拟任务 {t.sim_reviewer.open_sim_tasks}</dd>
          <dt>保留</dt><dd>{r ? <>只保留最近 {r.keep.toLocaleString("en-US")} 条模拟内容，已清理 {r.pruned.toLocaleString("en-US")} 条（累计数字不受影响）· app.db {mb(r.db_bytes)}</> : "不清理"}</dd>
        </dl>
        <div className="small faint">内容由演示流量生成器按比例混合产生，ID 以 sim- 开头；模拟审核员只处理模拟任务，产能随流入调整，不碰手动提交的内容。</div>
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
          <span className="sub">快判完成的内容，近 5 秒平均{config.mode === "demo" ? " · 演示模式，判官与 agent 为脚本" : ""}</span>
        </div>
        <div className="hero-stats">
          <div><span className="k">5 分钟均值</span><span className="v num">{sum.avg.toFixed(1)}<small> /s</small></span></div>
          <div><span className="k">峰值</span><span className="v num">{sum.peak}<small> /s</small></span></div>
          <div title="近 1 分钟每条内容的快判耗时（判官调用、策略、写库；不含在接入队列里的等待）"><span className="k">快判耗时 p50 · p95</span><span className="v num">{f?.flow?.p50_ms != null ? `${duration(f.flow.p50_ms)} · ${duration(f.flow.p95_ms)}` : "—"}</span></div>
          <div><span className="k">agent 处理中</span><span className="v num">{d ? d.agent.open : "—"}</span></div>
          {t ? <div><span className="k">模拟流量</span><span className="v num">{t.paused || t.per_sec === 0 ? "暂停" : <>{t.per_sec}<small> /s</small></>}</span></div> : null}
        </div>
      </div>
      <div className="hero-flow"><FlowPipeline frame={f ?? null} /></div>
      <div className="hero-curve">
        <div className="hero-curve-h"><span>吞吐</span><span className="faint">近 5 分钟，每秒快判完成条数</span></div>
        <Throughput flow={f?.flow ?? null} />
      </div>
    </section>
  );
}

export function Overview() {
  const { config } = useConsole();
  const live = useLive();
  const { data: m, connected } = useEventSource<Metrics>("/api/metrics");
  const head = <PageHead title="概览" desc={config.mode === "demo" ? "处理管线、吞吐、累计数字与最新审次随实时数据流更新。演示模式下判官与 agent 是脚本，数字只作演示。" : "处理管线、吞吐、累计数字与最新审次随实时数据流更新。"} />;
  if (!live.frame) return <>{head}<Panel><Empty>{live.connected ? "加载中…" : "正在连接实时数据流…"}</Empty></Panel></>;
  const d = live.frame.stats;
  const finished = Math.max(0, d.reviews - d.agent.open - d.human.open);
  const auto = d.routes.fast_pass + d.routes.fast_block + d.agent.disposed;
  const routeTotal = ROUTES.reduce((n, r) => n + d.routes[r], 0);
  const effTotal = Object.values(d.effective).reduce((a, b) => a + b, 0);
  const relTotal = Object.values(d.release_reasons).reduce((a, b) => a + b, 0);

  return (
    <>
      {head}
      {d.contents === 0 ? <Alert tone="info">还没有内容。到“提交与追踪”提交一条{config.mode === "demo" ? "，或点演示示例；开启顶栏的模拟流量后数字会持续变化" : ""}。</Alert> : null}
      <Hero />
      <div className="kpis" style={{ ["--n" as string]: 5 }}>
        <Kpi label="已接入内容" value={<AnimatedNumber value={d.contents} format={big} />} foot={`已快判 ${big(d.judged)} · 审次 ${big(d.reviews)}`} />
        <Kpi label="自动完成率" value={finished ? <AnimatedNumber value={(100 * auto) / finished} format={(x) => `${x.toFixed(1)}%`} /> : "—"} foot={`快判 ${big(d.routes.fast_pass + d.routes.fast_block)} · agent 处置 ${big(d.agent.disposed)} / 已结束 ${big(finished)}`} />
        <Kpi label="agent 处理中" value={<AnimatedNumber value={d.agent.open} />} foot={`已处置 ${big(d.agent.disposed)} · 交人工 ${big(d.agent.released)}`} />
        <Kpi label="人工队列" value={<AnimatedNumber value={d.human.open} />} tone={d.human.overdue ? "warn" : undefined} foot={`已领取 ${d.human.claimed} · 超时 ${d.human.overdue} · 已完成 ${big(d.human.closed)}`} />
        <Kpi label="每条平均费用" value={<AnimatedNumber value={d.cost.per_content_micro} format={(x) => yuan(x, 5)} />} foot={`快判 ${yuan(d.cost.fast_micro, 2)} · 审次 ${yuan(d.cost.review_micro, 2)}`} />
      </div>

      <div className="grid g-main">
        <Panel title="分流" sub="每分钟新建审次，近 30 分钟" actions={<Legend />} className="fill">
          <MinuteBars series={d.series} />
        </Panel>
        <Panel title="最新审次" sub="实时，每 1.5 秒刷新" flush>
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
        <Panel title="耗时" sub="近 2000 条">
          <div className="lat">
            <span className="h">阶段</span><span className="h v">p50</span><span className="h v">p95</span>
            <span>接入到快判结论</span><span className="v">{duration(d.latency_ms.fast_p50)}</span><span className="v">{duration(d.latency_ms.fast_p95)}</span>
            <span>agent 审次</span><span className="v">{duration(d.latency_ms.agent_p50)}</span><span className="v">{duration(d.latency_ms.agent_p95)}</span>
            <span>人工处理</span><span className="v">{duration(d.latency_ms.human_p50)}</span><span className="v faint">—</span>
          </div>
        </Panel>
        <Panel title="当前有效处置" sub={`${big(effTotal)} 条内容`}>
          <Meter rows={Object.entries(d.effective).map(([k, n]) => [k === "pending" ? "待定（审核中）" : ACTION[k as keyof typeof ACTION] ?? k, n])} total={effTotal} />
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
          <Panel title="网关窗口指标" sub={connected ? "内存窗口，每秒推送" : "未连接"}>
            {!m ? <Empty>等待推送…</Empty> : (
              <dl className="kv">
                <dt>接入速率</dt><dd className="num">{m.intake_rate.toFixed(2)} 条/秒</dd>
                <dt>队列：接入 / agent / 人工</dt><dd className="num">{m.queue_intake} / {m.queue_agent} / {m.queue_human}</dd>
                <dt>快判 p50 / p95</dt><dd className="num nowrap">{duration(m.p50_fast)} / {duration(m.p95_fast)}</dd>
                <dt>未完成总量</dt><dd className="num">{m.outstanding_total}{m.replay_paused ? "（背压暂停）" : ""}</dd>
                <dt>近 60 秒 放行 / 处置 / 疑似</dt><dd className="num">{m.pass_pct}% / {m.block_pct}% / {m.suspicious_pct}%</dd>
                <dt>每千条费用</dt><dd className="num">{yuan(m.cost_micro_per_1k, 3)}</dd>
                <dt>转人工占比（5 分钟）</dt><dd className="num">{m.release_pct}%</dd>
                <dt>判官弃答 · 待投递</dt><dd className="num">{m.judge_abstain_pct}% · {m.outbox_pending}</dd>
              </dl>
            )}
          </Panel>
        </div>
        {live.frame.traffic ? <TrafficPanel t={live.frame.traffic} /> : null}
      </div>
    </>
  );
}
