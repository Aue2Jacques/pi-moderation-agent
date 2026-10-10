// Capacity and scheduling (simulated, frontend only): one platform day in a few minutes — commute / lunch / evening
// peaks, a judge GPU pool that scales ahead of them, a degrade ladder that holds the latency target, and what the idle
// capacity does off-peak. The model is capacity.ts; the backend plan is docs/capacity-plan-2026-10-09.md.
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, PageHead, Panel } from "../ui.tsx";
import {
  AGENT_CAP, CAP_FAST, CAP_NORMAL, LEVELS, MAX_CARDS, PEAK, SIM_FACTS, SLO_S, failCard, newSim, phaseOf, planned, savings, simClock, spike, step,
  type Flags, type Sim,
} from "../capacity.ts";

const SPEEDS = [1, 2, 4] as const;
/** real milliseconds per simulated minute at 1x: a day in about 3 minutes */
const MS_PER_MIN = 125;

function useSim(): { sim: Sim; running: boolean; setRunning: (b: boolean) => void; speed: number; setSpeed: (n: number) => void; act: (f: (s: Sim) => void) => void; reset: (flags?: Flags) => void } {
  const ref = useRef<Sim>(newSim());
  const [, bump] = useState(0);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => { for (let i = 0; i < speed; i++) step(ref.current); bump((x) => x + 1); }, MS_PER_MIN);
    return () => clearInterval(id);
  }, [running, speed]);
  return {
    sim: ref.current, running, setRunning, speed, setSpeed,
    act: (f) => { f(ref.current); bump((x) => x + 1); },
    reset: (flags) => { ref.current = newSim(flags ?? ref.current.flags); bump((x) => x + 1); },
  };
}

const count = (n: number): string => (n >= 10_000 ? `${(n / 10_000).toFixed(n >= 1e6 ? 0 : 1)} 万` : Math.round(n).toLocaleString("en-US"));
const sec = (s: number): string => (s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s / 60)} 分钟`);

/** The day: planned inflow (dashed), actual inflow (filled), serving capacity (steps), offline share; peaks shaded. */
function DayChart({ sim }: { sim: Sim }) {
  const W = 960, H = 220, top = PEAK * 2.4;
  const day0 = Math.floor((sim.t - 1) / 1440) * 1440;
  const x = (m: number): number => ((m - day0) / 1440) * W;
  const y = (v: number): number => H - (Math.min(v, top) / top) * H;
  const pts = sim.history.filter((p) => p.t > day0);
  const plan = useMemo(() => Array.from({ length: 97 }, (_, i) => `${i ? "L" : "M"}${((i * 15) / 1440 * W).toFixed(1)},${(H - (planned(i * 15) / top) * H).toFixed(1)}`).join(""), [top]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.demand).toFixed(1)}`).join("");
  const area = pts.length ? `${line}L${x(pts[pts.length - 1]!.t).toFixed(1)},${H}L${x(pts[0]!.t).toFixed(1)},${H}Z` : "";
  const cap = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.cap).toFixed(1)}`).join("");
  const peaks: [number, number, string][] = [[7 * 60, 10 * 60, "早高峰"], [11 * 60, 14 * 60, "午间"], [17 * 60, 23 * 60, "晚高峰"]];
  const now = pts.length ? x(pts[pts.length - 1]!.t) : 0;
  return (
    <div className="cap-day">
      <div className="cap-day-y" aria-hidden="true"><span style={{ top: 0 }}>{Math.round(top)}</span><span style={{ top: "50%" }}>{Math.round(top / 2)}</span><span style={{ top: "100%" }}>0</span></div>
      <div className="cap-day-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="一天的流量与在线算力">
          {peaks.map(([a, b, l]) => <rect key={l} x={(a / 1440) * W} width={((b - a) / 1440) * W} y={0} height={H} className="peak" />)}
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="gl" vectorEffect="non-scaling-stroke" />
          <path d={plan} className="plan" vectorEffect="non-scaling-stroke" />
          {area ? <path d={area} className="area" /> : null}
          {line ? <path d={line} className="ln" vectorEffect="non-scaling-stroke" /> : null}
          {cap ? <path d={cap} className="cap" vectorEffect="non-scaling-stroke" /> : null}
          {pts.map((p) => p.level > 0 ? <rect key={p.t} x={x(p.t)} width={W / 1440 + 0.4} y={H - 5} height={5} className={`lv lv${p.level}`} /> : null)}
          <line x1={now} x2={now} y1={0} y2={H} className="now" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="cap-day-peaks" aria-hidden="true">{peaks.map(([a, b, l]) => <span key={l} style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }}>{l}</span>)}</div>
      </div>
      <div className="cap-day-x" aria-hidden="true">{[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}:00</span>)}</div>
      <div className="cap-legend">
        <span><i className="k-ln" />实际流量</span><span><i className="k-plan" />预测曲线</span><span><i className="k-cap" />在线算力（卡数 × 单卡吞吐）</span><span><i className="k-lv" />降级时段</span>
      </div>
    </div>
  );
}

function LatencyChart({ sim }: { sim: Sim }) {
  const W = 600, H = 120, top = 8;
  const pts = sim.history.slice(-240);
  const x = (i: number): number => (i / Math.max(1, 239)) * W;
  const y = (v: number): number => H - (Math.min(v, top) / top) * H;
  const done = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.doneS).toFixed(1)}`).join("");
  const fast = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.fastS).toFixed(1)}`).join("");
  return (
    <div className="cap-lat">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="近 4 小时审核延迟">
        <line x1="0" x2={W} y1={y(SLO_S)} y2={y(SLO_S)} className="slo" vectorEffect="non-scaling-stroke" />
        {done ? <path d={done} className="done" vectorEffect="non-scaling-stroke" /> : null}
        {fast ? <path d={fast} className="fast" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      <span className="slo-l" style={{ top: `${(1 - SLO_S / top) * 100}%` }}>目标 {SLO_S} s</span>
      <div className="cap-legend"><span><i className="k-done" />发布到审完 p95</span><span><i className="k-fast" />快判 p95</span><span className="faint">近 4 小时（模拟时间），纵轴封顶 {top} s</span></div>
    </div>
  );
}

/** today's latency in numbers: minutes over the target, worst and typical p95 */
function DayLatency({ sim }: { sim: Sim }) {
  const day0 = Math.floor((sim.t - 1) / 1440) * 1440;
  const pts = sim.history.filter((p) => p.t > day0);
  const over = pts.filter((p) => p.doneS > SLO_S).length;
  const worst = pts.reduce((m, p) => Math.max(m, p.doneS), 0);
  const sorted = pts.map((p) => p.doneS).sort((a, b) => a - b);
  const mid = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const degraded = pts.filter((p) => p.level > 0).length;
  return (
    <div className="cap-kpis">
      <div><span className="k">今天超目标</span><span className={`v num ${over ? "bad-t" : ""}`}>{over}<small> 分钟</small></span></div>
      <div><span className="k">今天最差 p95</span><span className="v num">{sec(worst)}</span></div>
      <div><span className="k">典型 p95（中位）</span><span className="v num">{sec(mid)}</span></div>
      <div><span className="k">处于降级</span><span className="v num">{degraded}<small> 分钟</small></span></div>
    </div>
  );
}

function Cards({ sim }: { sim: Sim }) {
  return (
    <div className="cards">
      {sim.cards.map((c) => {
        const label = c.state === "on" ? (c.role === "offline" ? "离线任务" : "在线") : c.state === "warming" ? `启动中 ${c.warm} 分` : c.state === "failed" ? "故障摘除" : "未租用";
        return (
          <div key={c.id} className={`gcard ${c.state} ${c.role}`} title={c.state === "on" && c.role === "online" ? `利用率 ${Math.round(c.util * 100)}% · 批大小约 ${c.batch}` : label}>
            <div className="gc-h"><span className="mono">GPU {String(c.id).padStart(2, "0")}</span><span className="gc-s">{label}</span></div>
            <div className="gc-bar"><span style={{ width: `${Math.round((c.state === "on" ? c.util : c.state === "warming" ? 0.15 : 0) * 100)}%` }} /></div>
            <div className="gc-f num">{c.state === "on" ? (c.role === "offline" ? "补审 / 训练 / 聚类" : `${Math.round(c.util * 100)}% · 批 ${c.batch}`) : " "}</div>
          </div>
        );
      })}
    </div>
  );
}

function Ladder({ sim }: { sim: Sim }) {
  return (
    <ol className="ladder">
      {LEVELS.map((l) => (
        <li key={l.level} className={`${sim.level === l.level ? "on" : ""} ${sim.level > l.level ? "past" : ""}`}>
          <span className="lv-n num">{l.level}</span>
          <div className="lv-b"><div className="lv-t">{l.name}{sim.level === l.level ? <Badge tone={l.level ? "warn" : "good"} dot pulse={l.level > 0}>当前</Badge> : null}</div><div className="lv-w">{l.what}</div><div className="lv-c">代价：{l.cost}</div></div>
        </li>
      ))}
    </ol>
  );
}

function Offline({ sim }: { sim: Sim }) {
  return (
    <div className="offline">
      <div className="off-row">
        <div className="off-t">补审高峰暂缓的内容<span className="faint"> · 第 2、3 档留下的，有空闲就先补</span></div>
        <div className="off-v num">{count(sim.deferred)} 条待补 · 已补 {count(sim.backfilled)}</div>
      </div>
      {sim.jobs.map((j) => {
        const p = Math.min(1, j.done / j.need);
        return (
          <div key={j.id} className="off-job">
            <div className="off-t">{j.label}{j.measured ? <span className="m">耗时实测</span> : null}</div>
            <div className="off-bar"><span style={{ width: `${p * 100}%` }} className={p >= 1 ? "full" : ""} /></div>
            <div className="off-v num">{p >= 1 ? "完成" : `${Math.round(p * 100)}%`} · {j.need >= 60 ? `${(j.need / 60).toFixed(1)} 卡时` : `${j.need} 卡分钟`}</div>
          </div>
        );
      })}
    </div>
  );
}

export function Capacity() {
  const { sim, running, setRunning, speed, setSpeed, act, reset } = useSim();
  const on = sim.cards.filter((c) => c.state === "on").length;
  const warming = sim.cards.filter((c) => c.state === "warming").length;
  const toggle = (k: keyof Flags): void => reset({ ...sim.flags, [k]: !sim.flags[k] });
  const capPer = sim.level >= 1 ? CAP_FAST : CAP_NORMAL;
  return (
    <>
      <PageHead title="容量与调度" desc={<>把平台的一天压缩成约 3 分钟：早晚高峰怎么扛、延迟怎么守住、低峰的空闲算力做什么。<b>这一页是前端模拟</b>，单卡吞吐等少数数字取自实测（见页底），其余为假设。</>} />
      <section className="hero cap-hero" aria-label="模拟一天">
        <div className="hero-top">
          <div className="hero-big">
            <span className="lbl"><span className={`dot ${running ? "pulse" : ""}`} />模拟时间 · {phaseOf(sim.t)}</span>
            <span className="v num">{simClock(sim.t)}<span className="u">第 {Math.floor((sim.t - 1) / 1440) + 1} 天</span></span>
            <span className="sub">平台峰值按 {PEAK} 条/秒设定；每秒真实时间约等于 {8 * speed} 分钟模拟时间</span>
          </div>
          <div className="hero-stats">
            <div><span className="k">当前流量</span><span className="v num">{Math.round(sim.demand)}<small> 条/秒</small></span></div>
            <div><span className="k">在线卡</span><span className="v num">{on}{warming ? <small> +{warming} 启动中</small> : null}<small> / {MAX_CARDS}</small></span></div>
            <div><span className="k">发布到审完 p95</span><span className={`v num ${sim.doneS > SLO_S ? "bad-t" : ""}`}>{sec(sim.doneS)}</span></div>
            <div><span className="k">快判 p95</span><span className="v num">{sec(sim.fastS)}</span></div>
            <div><span className="k">降级档位</span><span className={`v ${sim.level ? "warn-t" : ""}`}>{sim.level} · {LEVELS[sim.level]!.name}</span></div>
          </div>
        </div>
        <div className="cap-ctl">
          <div className="row">
            <button className="btn sm" onClick={() => setRunning(!running)}>{running ? "暂停" : "继续"}</button>
            <div className="seg sm" role="radiogroup" aria-label="播放速度">
              {SPEEDS.map((n) => <button key={n} role="radio" aria-checked={speed === n} className={speed === n ? "on" : ""} onClick={() => setSpeed(n)}>{n}×</button>)}
            </div>
            <span className="spacer" />
            <button className="btn sm" onClick={() => act(spike)}>突发热点</button>
            <button className="btn sm" onClick={() => act(failCard)}>拔掉一张卡</button>
            <button className="btn sm ghost" onClick={() => reset()}>重来</button>
          </div>
          <div className="row cap-flags">
            <label className="chk"><input type="checkbox" checked={sim.flags.predict} onChange={() => toggle("predict")} />按预测提前加卡</label>
            <label className="chk"><input type="checkbox" checked={sim.flags.degrade} onChange={() => toggle("degrade")} />自动降级</label>
            <label className="chk"><input type="checkbox" checked={sim.flags.evidence} onChange={() => toggle("evidence")} />Kev 带证据复判（agent 份额 15% → 5%）</label>
            <span className="faint small">切换开关会从 06:00 重新开始</span>
          </div>
        </div>
        <div className="hero-curve cap-curve">
          <div className="hero-curve-h"><span>今天</span><span className="faint">每分钟流量与在线算力，条/秒</span></div>
          <DayChart sim={sim} />
        </div>
      </section>

      <div className="grid g-main" style={{ marginTop: 16 }}>
        <Panel title="GPU 池" sub={`单卡 ${capPer} 条/秒 · 同规则版本优先发同一张卡（缓存热），排队差过大时溢出到最空的卡`}>
          <Cards sim={sim} />
          <div className="cap-foot small faint">卡时用量比全天开满 {MAX_CARDS} 张少 <b className="num">{Math.round(savings(sim) * 100)}%</b>；低峰空出来的卡先跑离线任务，跑完就退。</div>
        </Panel>
        <Panel title="降级梯子" sub="按排队和延迟自动升档，压力解除 10 分钟后逐档恢复">
          <Ladder sim={sim} />
        </Panel>
      </div>

      <div className="grid g-2" style={{ marginTop: 16 }}>
        <Panel title="延迟" sub={`目标：发布到审完 p95 ≤ ${SLO_S} 秒；作者自己发完立刻可见，其他人等审完`}>
          <LatencyChart sim={sim} />
          <DayLatency sim={sim} />
          <div className="cap-foot small faint">agent 并发上限 {AGENT_CAP} 次/秒；当前转 agent 约 {Math.round(sim.agentShare * 100)}%，agent 平均 {sec(sim.agentS)}。</div>
        </Panel>
        <Panel title="空闲算力在做什么" sub="在线流量留足 15% 余量后剩下的卡；离线任务每晚零点重新排队">
          <Offline sim={sim} />
        </Panel>
      </div>

      <div className="grid g-main" style={{ marginTop: 16 }}>
        <Panel title="调度日志" sub="模拟时间" flush>
          <ul className="cap-log">
            {sim.events.slice(0, 14).map((e, i) => <li key={`${e.t}-${i}`} className={e.tone}><span className="mono faint">{simClock(e.t)}</span><span>{e.text}</span></li>)}
          </ul>
        </Panel>
        <Panel title="数字依据">
          <ul className="facts">
            {SIM_FACTS.map((f) => <li key={f.k}><span className="faint">{f.k}</span><span className="num">{f.v}</span>{f.measured ? <Badge tone="good">实测</Badge> : <Badge>假设</Badge>}</li>)}
          </ul>
          <div className="small faint" style={{ marginTop: 10 }}>多卡调度、预测扩容、降级与离线任务都还没有后端实现，方案见 docs/capacity-plan-2026-10-09.md。</div>
        </Panel>
      </div>
    </>
  );
}
