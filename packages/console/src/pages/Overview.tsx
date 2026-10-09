// Overview: cumulative counts from app.db (/api/stats) and G's live window metrics (/api/metrics, SSE).
import { useState } from "react";
import { useConsole } from "../App.tsx";
import type { RouteKind, Stats } from "../api.ts";
import { useEventSource, usePoll } from "../hooks.ts";
import { ACTION, ROUTE, ROUTES, reasonText } from "../labels.ts";
import { Alert, Card, Empty, duration, pad2, pct, yuan } from "../ui.tsx";

type Metrics = { intake_rate: number; fast_rate: number; queue_intake: number; queue_agent: number; queue_human: number; outstanding_total: number; replay_paused: boolean;
  p50_fast: number; p95_fast: number; p50_agent: number; p95_agent: number; cost_micro_per_1k: number; release_pct: number; judge_abstain_pct: number; outbox_pending: number; pass_pct: number; block_pct: number; suspicious_pct: number };

const Tile = ({ label, value, unit, foot }: { label: string; value: string; unit?: string; foot?: string }) => (
  <div className="card stat"><div className="label">{label}</div><div className="value">{value}{unit ? <span className="unit">{unit}</span> : null}</div>{foot ? <div className="foot">{foot}</div> : null}</div>
);

/** Decisions per minute, stacked by route; hover a column for its numbers. */
function MinuteBars({ series }: { series: Stats["series"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 180, padL = 28, padB = 22, padT = 8;
  const totals = series.map((b) => ROUTES.reduce((n, r) => n + (b[r as keyof typeof b] as number), 0));
  const max = Math.max(4, ...totals);
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const cw = (W - padL) / series.length;
  const y = (v: number): number => padT + (H - padT - padB) * (1 - v / top);
  const label = (m: number): string => { const d = new Date(m * 60_000); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const hb = hover !== null ? series[hover] : undefined;
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="每分钟审次数，按路径堆叠" onMouseLeave={() => setHover(null)}>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={padL} x2={W} y1={y(i * step)} y2={y(i * step)} stroke="var(--border)" strokeDasharray={i ? "2 3" : undefined} />
            <text x={padL - 6} y={y(i * step) + 4} textAnchor="end" fontSize="10" fill="var(--text-3)">{i * step}</text>
          </g>
        ))}
        {series.map((b, i) => {
          let acc = 0;
          const x = padL + i * cw + 2;
          return (
            <g key={b.minute} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * cw} y={padT} width={cw} height={H - padT - padB} fill={hover === i ? "var(--surface-3)" : "transparent"} />
              {ROUTES.map((r) => {
                const v = b[r as keyof typeof b] as number;
                if (!v) return null;
                const y0 = y(acc), y1 = y(acc + v);
                acc += v;
                return <rect key={r} x={x} y={y1 + 1} width={Math.max(2, cw - 4)} height={Math.max(1, y0 - y1 - 1)} rx={2} fill={`var(--route-${r})`} />;
              })}
              {i % 5 === 4 ? <text x={i === series.length - 1 ? W - 2 : padL + i * cw + cw / 2} y={H - 6} textAnchor={i === series.length - 1 ? "end" : "middle"} fontSize="10" fill="var(--text-3)">{label(b.minute)}</text> : null}
            </g>
          );
        })}
      </svg>
      {hb ? (
        <div className="chart-tip" style={{ left: `min(calc(${((padL + (hover! + 1) * cw) / W) * 100}% + 8px), calc(100% - 170px))`, top: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{label(hb.minute)} · 共 {totals[hover!]}</div>
          {ROUTES.map((r) => <div className="row" key={r}><span className="row" style={{ gap: 6 }}><span className="sw" style={{ background: `var(--route-${r})` }} />{ROUTE[r]}</span><span className="num">{hb[r as keyof typeof hb]}</span></div>)}
        </div>
      ) : null}
    </div>
  );
}

function Legend() {
  return <div className="legend">{ROUTES.map((r) => <span key={r}><span className="sw" style={{ background: `var(--route-${r})` }} />{ROUTE[r]}</span>)}</div>;
}

function BarList({ rows, total }: { rows: [string, number][]; total: number }) {
  if (!rows.length) return <Empty>暂无</Empty>;
  return <div className="bar-list">{rows.map(([k, n]) => <div className="item" key={k}><span className="ellipsis" title={k}>{k}</span><div className="track"><div className="fill" style={{ width: `${total ? (100 * n) / total : 0}%` }} /></div><span className="num" style={{ textAlign: "right" }}>{n}</span></div>)}</div>;
}

export function Overview() {
  const { config } = useConsole();
  const s = usePoll<Stats>("/api/stats", 3000);
  const { data: m, connected } = useEventSource<Metrics>("/api/metrics");
  if (s.error) return <Alert tone="bad">{s.error}</Alert>;
  if (!s.data) return <Empty>加载中…</Empty>;
  const d = s.data;
  const finished = Math.max(0, d.reviews - d.agent.open - d.human.open);
  const auto = d.routes.fast_pass + d.routes.fast_block + d.agent.disposed;
  const routeTotal = ROUTES.reduce((n, r) => n + d.routes[r], 0);
  const effTotal = Object.values(d.effective).reduce((a, b) => a + b, 0);
  const relTotal = Object.values(d.release_reasons).reduce((a, b) => a + b, 0);

  return (
    <>
      {d.contents === 0 ? <Alert tone="info">还没有内容。到“提交与追踪”提交一条{config.mode === "demo" ? "，或点演示示例" : ""}，这里的数字会随之变化。</Alert> : null}
      <div className="grid cols-4 stats">
        <Tile label="已接入内容" value={String(d.contents)} foot={`已快判 ${d.judged} · 审次 ${d.reviews}`} />
        <Tile label="自动完成率" value={pct(auto, finished)} foot={`快判 ${d.routes.fast_pass + d.routes.fast_block} + agent 处置 ${d.agent.disposed} / 已结束 ${finished}`} />
        <Tile label="人工队列" value={String(d.human.open)} unit="条" foot={`已领取 ${d.human.claimed} · 超时 ${d.human.overdue} · 已完成 ${d.human.closed}`} />
        <Tile label="每条内容平均费用" value={yuan(d.cost.per_content_micro, 5)} foot={`快判 ${yuan(d.cost.fast_micro)} · 审次 ${yuan(d.cost.review_micro)}${config.mode === "demo" ? " · 演示用模拟用量" : ""}`} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)" }}>
        <Card title="分流" sub="每分钟新建审次，按路径（近 30 分钟）" right={<Legend />}>
          <MinuteBars series={d.series} />
        </Card>
        <Card title="各路占比" sub={`累计 ${routeTotal} 个审次`}>
          <div className="stack">
            <div className="share-bar" role="img" aria-label="各路占比">{ROUTES.filter((r) => d.routes[r]).map((r) => <div key={r} title={`${ROUTE[r]} ${d.routes[r]}`} style={{ width: `${(100 * d.routes[r]) / Math.max(1, routeTotal)}%`, background: `var(--route-${r})` }} />)}</div>
            <table className="tbl"><tbody>
              {ROUTES.map((r: RouteKind) => <tr key={r}><td><span className="row" style={{ gap: 8 }}><span className="sw" style={{ background: `var(--route-${r})` }} />{ROUTE[r]}</span></td><td className="num">{d.routes[r]}</td><td className="num muted">{pct(d.routes[r], routeTotal)}</td></tr>)}
            </tbody></table>
          </div>
        </Card>
      </div>

      <div className="grid cols-3">
        <Card title="耗时" sub="累计，近 2000 条">
          <table className="tbl"><tbody>
            <tr><td>接入到快判结论</td><td className="num">p50 {duration(d.latency_ms.fast_p50)}</td><td className="num">p95 {duration(d.latency_ms.fast_p95)}</td></tr>
            <tr><td>agent 审次</td><td className="num">p50 {duration(d.latency_ms.agent_p50)}</td><td className="num">p95 {duration(d.latency_ms.agent_p95)}</td></tr>
            <tr><td>人工处理</td><td className="num">p50 {duration(d.latency_ms.human_p50)}</td><td className="num muted">—</td></tr>
          </tbody></table>
        </Card>
        <Card title="当前有效处置" sub={`${effTotal} 条内容`}>
          <BarList rows={Object.entries(d.effective).map(([k, n]) => [k === "pending" ? "待定（审核中）" : ACTION[k as keyof typeof ACTION] ?? k, n])} total={effTotal} />
        </Card>
        <Card title="转人工原因" sub={`agent 处置 ${d.agent.disposed} · 交人工 ${d.agent.released}`}>
          <BarList rows={Object.entries(d.release_reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => [reasonText(k), n])} total={relTotal} />
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="申诉">
          <div className="grid cols-3" style={{ gap: 0 }}>
            <div className="stat"><div className="label">申诉总数</div><div className="value">{d.appeals.total}</div></div>
            <div className="stat"><div className="label">处理中</div><div className="value">{d.appeals.open}</div></div>
            <div className="stat"><div className="label">改判</div><div className="value">{d.appeals.changed}</div></div>
          </div>
        </Card>
        <Card title="实时窗口指标" sub={connected ? "网关内存，每秒推送" : "未连接"}>
          {!m ? <Empty>等待推送…</Empty> : (
            <dl className="kv-grid" style={{ gridTemplateColumns: "max-content 1fr max-content 1fr", gap: "10px 18px" }}>
              <dt>接入速率</dt><dd className="num">{m.intake_rate.toFixed(2)} 条/秒</dd>
              <dt>队列 接入 / agent / 人工</dt><dd className="num">{m.queue_intake} / {m.queue_agent} / {m.queue_human}</dd>
              <dt>快判 p50 / p95</dt><dd className="num">{duration(m.p50_fast)} / {duration(m.p95_fast)}</dd>
              <dt>未完成总量</dt><dd className="num">{m.outstanding_total}{m.replay_paused ? "（背压暂停）" : ""}</dd>
              <dt>近 60 秒 放行 / 处置 / 疑似</dt><dd className="num">{m.pass_pct}% / {m.block_pct}% / {m.suspicious_pct}%</dd>
              <dt>每千条费用</dt><dd className="num">{yuan(m.cost_micro_per_1k, 3)}</dd>
              <dt>转人工占比（5 分钟）</dt><dd className="num">{m.release_pct}%</dd>
              <dt>判官弃答 · 待投递</dt><dd className="num">{m.judge_abstain_pct}% · {m.outbox_pending}</dd>
            </dl>
          )}
        </Card>
      </div>
    </>
  );
}
