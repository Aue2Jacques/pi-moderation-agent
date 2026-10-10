// Overview: the live pipeline and throughput (Flow.tsx), cumulative numbers and the latest reviews from the global live
// stream (/api/events), G's in-memory window metrics from /api/metrics (SSE). Nothing here polls.
import { useEffect, useRef, useState } from "react";
import { TOUR, useConsole } from "../App.tsx";
import type { ReviewListItem, Stats } from "../api.ts";
import { ROUTE, ROUTES, demoJudgeNote, reasonText } from "../labels.ts";
import { useLive } from "../live.tsx";
import { FlowPipeline, Throughput, flowSummary } from "../Flow.tsx";
import { AnimatedNumber, useFreshIds } from "../motion.tsx";
import { ActionBadge, Alert, Empty, Id, Kpi, PageHead, Panel, RouteBadge, SimTag, StateBadge, clock, duration, pad2, pct, yuan } from "../ui.tsx";


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

/** The overview's head section: throughput numbers, the pipeline, the five-minute curve. */
function Hero() {
  const { config } = useConsole();
  const live = useLive();
  const f = live.frame;
  const sum = flowSummary(f?.flow ?? null);
  const d = f?.stats;
  const finished = d ? Math.max(0, d.reviews - d.agent.open - d.human.open) : 0;
  const autoRate = d && finished ? (100 * (d.routes.fast_pass + d.routes.fast_block + d.agent.disposed)) / finished : null;
  return (
    <section className="hero" aria-label="实时处理">
      <div className="hero-top">
        <div className="hero-big">
          <span className="lbl"><span className={`dot ${live.connected ? "pulse" : ""}`} />每秒处理</span>
          <span className="v"><AnimatedNumber value={sum.now} format={(x) => x.toFixed(x >= 100 ? 0 : 1)} /><span className="u">条 / 秒</span></span>
          <span className="sub">近 5 秒均值{config.mode === "demo" ? (config.demo_corpus ? "；评论取自真实测试集" : "；演示数据") : ""}</span>
        </div>
        <div className="hero-stats">
          <div title="近 1 分钟内单条评论的快判用时中位数，不含排队时间"><span className="k">单条用时</span><span className="v num">{f?.flow?.p50_ms != null ? duration(f.flow.p50_ms) : "—"}</span></div>
          <div title="已结束的审核中，由快判或 agent 自动完成、无需人工的比例"><span className="k">自动完成率</span><span className="v num">{autoRate !== null ? `${autoRate.toFixed(1)}%` : "—"}</span></div>
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
  const head = <PageHead title="概览" desc={config.mode === "demo" ? `所有数据实时更新。当前为演示环境：${demoJudgeNote(config)}。` : "所有数据实时更新。"} />;
  if (!live.frame) return <>{head}<Guide /><Panel><Empty>{live.connected ? "加载中…" : "正在连接实时数据流…"}</Empty></Panel></>;
  const d = live.frame.stats;
  const relTotal = Object.values(d.release_reasons).reduce((a, b) => a + b, 0);

  return (
    <>
      {head}
      <Guide />
      {d.contents === 0 ? <Alert tone="info">暂无内容。可在“提交与追踪”中提交一条{config.mode === "demo" ? "，或在顶栏开启模拟流量" : ""}。</Alert> : null}
      <Hero />
      <div className="kpis" style={{ ["--n" as string]: 4 }}>
        <Kpi label="已审核内容" value={<AnimatedNumber value={d.contents} format={big} />} foot="累计接收的评论、弹幕与昵称" />
        <Kpi label="agent 正在处理" value={<AnimatedNumber value={d.agent.open} />} foot={`已自行处置 ${big(d.agent.disposed)} 条，转人工 ${big(d.agent.released)} 条`} />
        <Kpi label="等待人工" value={<AnimatedNumber value={d.human.open} />} tone={d.human.overdue ? "warn" : undefined} foot={`已完成 ${big(d.human.closed)} 条${d.human.overdue ? `，超时 ${d.human.overdue} 条` : ""}`} />
        <Kpi label="每条平均成本" value={<AnimatedNumber value={d.cost.per_content_micro} format={(x) => yuan(x, 5)} />} foot="含快判与 agent 的模型调用" />
      </div>

      <div className="grid g-main">
        <Panel title="分流" sub="近 30 分钟，每分钟内容的流向" actions={<Legend />} className="fill">
          <MinuteBars series={d.series} />
        </Panel>
        <Panel title="最新审次" sub="实时更新" flush>
          <LiveFeed items={live.recent.slice(0, 9)} />
        </Panel>
      </div>

      <Panel title="用时、转人工与申诉" sub="近 2000 条审核">
        <div className="ov-three">
          <div>
            <h3 className="ov-h">各环节用时</h3>
            <div className="lat">
              <span className="h">环节</span><span className="h v">中位数</span><span className="h v">较慢的 5%</span>
              <span>快判</span><span className="v">{duration(d.latency_ms.fast_p50)}</span><span className="v">{duration(d.latency_ms.fast_p95)}</span>
              <span>agent 审核</span><span className="v">{duration(d.latency_ms.agent_p50)}</span><span className="v">{duration(d.latency_ms.agent_p95)}</span>
              <span>人工处理</span><span className="v">{duration(d.latency_ms.human_p50)}</span><span className="v faint">—</span>
            </div>
          </div>
          <div>
            <h3 className="ov-h">转人工原因<span className="faint"> · 共 {big(relTotal)} 次</span></h3>
            <Meter rows={Object.entries(d.release_reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => [reasonText(k), n])} total={relTotal} />
          </div>
          <div>
            <h3 className="ov-h">申诉</h3>
            <div className="trio">
              <Kpi label="累计" value={<AnimatedNumber value={d.appeals.total} />} />
              <Kpi label="处理中" value={<AnimatedNumber value={d.appeals.open} />} />
              <Kpi label="改判" value={<AnimatedNumber value={d.appeals.changed} />} />
            </div>
          </div>
        </div>
      </Panel>
      <p className="small faint ov-more">网关实时指标、模拟流量明细与版本信息见 <a href="#/system">系统状态</a>。</p>
    </>
  );
}
