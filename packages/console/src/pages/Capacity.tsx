// Capacity and scheduling (simulated, frontend only): one platform day in a few minutes on the company's own GPU pool.
// Cards are always busy — judging or running offline work; the scheduler borrows offline cards for peaks (cheapest to
// stop first) and hands them back afterwards. Switch costs are measured (python/kevfast/switch_bench.py); the model is
// capacity.ts; the build plan is docs/gpu-scheduling-plan-2026-10-09.md. First screen (phone included): clock, key
// numbers, the pool and the day curve together.
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Panel } from "../ui.tsx";
import {
  AGENT_CAP, CAP_FAST, CAP_NORMAL, CARDS, JOB_INFO, LEVELS, PEAK, SIM_FACTS, SLO_S, SWITCH, SWITCH_STEPS, failCard, newSim, phaseOf, planned, simClock,
  spike, step, switchSeconds, type Card, type Flags, type Sim, type SwitchKind,
} from "../capacity.ts";

const SPEEDS = [1, 2, 4] as const;
/** real milliseconds per simulated minute at 1x: a day in about 3 minutes */
const MS_PER_MIN = 125;

function useSim() {
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
    act: (f: (s: Sim) => void) => { f(ref.current); bump((x) => x + 1); },
    reset: (flags?: Flags) => { ref.current = newSim(flags ?? ref.current.flags); bump((x) => x + 1); },
  };
}

const sec = (s: number): string => (s < 1 ? `${Math.round(s * 1000)} ms` : s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s / 60)} 分钟`);
const count = (n: number): string => (n >= 10_000 ? `${(n / 10_000).toFixed(n >= 1e6 ? 0 : 1)} 万` : Math.round(n).toLocaleString("en-US"));

function cellText(c: Card): { role: string; sub: string } {
  if (c.role === "judge") return { role: "判官", sub: c.mixed ? "兼跑补审" : `批 ${c.batch}` };
  if (c.role === "offline") return { role: JOB_INFO[c.job ?? "batch"].short, sub: "离线" };
  if (c.role === "switching") return { role: c.toward === "judge" ? "→判官" : `→${JOB_INFO[c.job ?? "batch"].short}`, sub: "切换中" };
  return { role: "故障", sub: "已移出" };
}

/** The pool: one cell per card, coloured by role. */
function Pool({ sim }: { sim: Sim }) {
  return (
    <div className="pool" role="list" aria-label="GPU 卡池">
      {sim.cards.map((c) => {
        const t = cellText(c);
        const title = c.role === "judge" ? `GPU ${c.id}：判官，利用率 ${Math.round(c.util * 100)}%${c.mixed ? "，余量用于补审与回扫" : ""}`
          : c.role === "offline" ? `GPU ${c.id}：${JOB_INFO[c.job ?? "batch"].label}` : c.role === "switching" ? `GPU ${c.id}：切换中，约需半分钟` : `GPU ${c.id}：健康检查失败，已移出路由`;
        return (
          <div key={c.id} role="listitem" className={`pc ${c.role} ${c.role === "offline" && c.job === "train" ? "train" : ""} ${c.mixed ? "mixed" : ""}`} title={title}>
            <span className="pc-id mono">{String(c.id).padStart(2, "0")}</span>
            <span className="pc-r">{t.role}</span>
            <span className="pc-s">{t.sub}</span>
            <span className="pc-bar"><i style={{ width: `${Math.round((c.role === "judge" || c.role === "offline" ? c.util : 0.12) * 100)}%` }} /></span>
          </div>
        );
      })}
    </div>
  );
}

/** The day: planned inflow (dashed), actual inflow, judge capacity; below it, how the pool was split per minute. */
function DayChart({ sim }: { sim: Sim }) {
  const W = 960, H = 200, A = 40, top = PEAK * 2.4;
  const day0 = Math.floor((sim.t - 1) / 1440) * 1440;
  const x = (m: number): number => ((m - day0) / 1440) * W;
  const y = (v: number): number => H - (Math.min(v, top) / top) * H;
  const pts = sim.history.filter((p) => p.t > day0);
  const plan = useMemo(() => Array.from({ length: 97 }, (_, i) => `${i ? "L" : "M"}${((i * 15) / 1440 * W).toFixed(1)},${(H - (planned(i * 15) / top) * H).toFixed(1)}`).join(""), [top]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.demand).toFixed(1)}`).join("");
  const area = pts.length ? `${line}L${x(pts[pts.length - 1]!.t).toFixed(1)},${H}L${x(pts[0]!.t).toFixed(1)},${H}Z` : "";
  const cap = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.cap).toFixed(1)}`).join("");
  // allocation strip: judges from the bottom, offline above them
  const ya = (n: number): number => A - (n / CARDS) * A;
  const judgeA = pts.length ? `M${x(pts[0]!.t).toFixed(1)},${A}${pts.map((p) => `L${x(p.t).toFixed(1)},${ya(p.judges).toFixed(1)}`).join("")}L${x(pts[pts.length - 1]!.t).toFixed(1)},${A}Z` : "";
  const offA = pts.length ? `${pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${ya(p.judges).toFixed(1)}`).join("")}${[...pts].reverse().map((p) => `L${x(p.t).toFixed(1)},${ya(p.judges + p.offline).toFixed(1)}`).join("")}Z` : "";
  const peaks: [number, number, string][] = [[7 * 60, 10 * 60, "早高峰"], [11 * 60, 14 * 60, "午间"], [17 * 60, 23 * 60, "晚高峰"]];
  const now = pts.length ? x(pts[pts.length - 1]!.t) : 0;
  return (
    <div className="day">
      <div className="day-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="今天的流量与判官算力">
          {peaks.map(([a, b, l]) => <rect key={l} x={(a / 1440) * W} width={((b - a) / 1440) * W} y={0} height={H} className="peak" />)}
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="gl" vectorEffect="non-scaling-stroke" />
          <path d={plan} className="plan" vectorEffect="non-scaling-stroke" />
          {area ? <path d={area} className="area" /> : null}
          {line ? <path d={line} className="ln" vectorEffect="non-scaling-stroke" /> : null}
          {cap ? <path d={cap} className="cap" vectorEffect="non-scaling-stroke" /> : null}
          {pts.map((p) => p.level > 0 ? <rect key={p.t} x={x(p.t)} width={W / 1440 + 0.4} y={H - 4} height={4} className={`lv lv${p.level}`} /> : null)}
          <line x1={now} x2={now} y1={0} y2={H} className="now" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="day-y" aria-hidden="true"><span style={{ top: 0 }}>{Math.round(top)}</span><span style={{ top: "50%" }}>{Math.round(top / 2)}</span></div>
        <div className="day-peaks" aria-hidden="true">{peaks.map(([a, b, l]) => <span key={l} style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }}>{l}</span>)}</div>
      </div>
      <div className="day-alloc">
        <svg viewBox={`0 0 ${W} ${A}`} preserveAspectRatio="none" role="img" aria-label="每分钟判官卡与离线卡的数量">
          {offA ? <path d={offA} className="a-off" /> : null}
          {judgeA ? <path d={judgeA} className="a-judge" /> : null}
          <line x1={now} x2={now} y1={0} y2={A} className="now" vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
      <div className="day-x" aria-hidden="true">{[0, 6, 12, 18, 24].map((h) => <span key={h} style={{ left: `${(h / 24) * 100}%` }}>{String(h).padStart(2, "0")}:00</span>)}</div>
      <div className="legend">
        <span><i className="k-ln" />流量</span><span><i className="k-cap" />判官算力</span><span><i className="k-plan" />预测</span>
        <span><i className="k-sw judge" />判官卡</span><span><i className="k-sw off" />离线卡</span><span><i className="k-lv" />降级</span>
      </div>
    </div>
  );
}

function SwitchCost({ sim }: { sim: Sim }) {
  const kinds: [SwitchKind, string][] = [["infer_to_judge", "推理任务 → 判官"], ["train_to_judge", "训练 → 判官"], ["judge_to_offline", "判官 → 离线任务"]];
  const max = Math.max(...kinds.map(([k]) => switchSeconds(k)));
  const last = sim.lastSwitch;
  return (
    <div className="swc">
      {kinds.map(([k, label]) => (
        <div key={k} className={`swc-row ${last?.kind === k ? "hit" : ""}`}>
          <div className="swc-h"><span>{label}</span><span className="num">约 {Math.round(switchSeconds(k))} 秒{last?.kind === k ? <span className="faint">（最近一次：GPU {last.card}，{simClock(last.t)}）</span> : null}</span></div>
          <div className="swc-bar" style={{ width: `${(switchSeconds(k) / max) * 100}%` }}>
            {SWITCH_STEPS[k].map((st) => <i key={st} className={`s-${st} ${SWITCH[st].measured ? "" : "est"}`} style={{ flexGrow: SWITCH[st].s }} title={`${SWITCH[st].label}：${SWITCH[st].s} s${SWITCH[st].measured ? "（实测）" : "（估计）"}`} />)}
          </div>
        </div>
      ))}
      <ul className="swc-steps">
        {(Object.keys(SWITCH) as (keyof typeof SWITCH)[]).map((st) => (
          <li key={st}><i className={`s-${st} ${SWITCH[st].measured ? "" : "est"}`} /><span>{SWITCH[st].label}</span><span className="num">{SWITCH[st].s} s</span>{SWITCH[st].measured ? <Badge tone="good">实测</Badge> : <Badge>估计</Badge>}</li>
        ))}
      </ul>
      <p className="small faint">
        以上为单张 5060 Ti 的实测结果。判官占用 6.3 GB、训练峰值 12.3 GB，合计超过 16 GB，因此该型号需要整卡切换。
        录制 CUDA graphs 约占切换时间的四成；它只降低单条延迟、不影响批量吞吐，因此可以先不录制直接上线，约 17 秒即可接收请求（路线 M3）。显存 24 GB 及以上的卡可让判官常驻，切换时只需暂停训练。
      </p>
    </div>
  );
}

const ROUTE: { id: string; name: string; what: string; accept: string }[] = [
  { id: "M1", name: "kevfast 两级优先级", what: "在线请求优先，离线请求限制批大小", accept: "离线任务满载时，在线 p95 增加不超过一个批次（约 0.5 秒）" },
  { id: "M2", name: "LoRA 断点续训", what: "kev.train 支持 LoRA 断点恢复，并响应 SIGUSR1", accept: "在任意一步中断并恢复后，loss 与同种子的不中断训练逐步一致" },
  { id: "M3", name: "判官快速上线", what: "先不录制 CUDA graphs 即开始服务，空闲时补录", accept: "从启动到可接收批量请求不超过 18 秒" },
  { id: "M4", name: "节点代理", what: "管理每张卡的进程、角色切换、超时与故障上报", accept: "单卡完成 20 次“训练 → 判官 → 训练”往返，无残留进程与显存" },
  { id: "M5", name: "调度器与判官池路由", what: "预测借调、抢占顺序、亲和路由与切换记录", accept: "回放一整天的流量；判官进程被终止后 1 分钟内补位" },
  { id: "M6", name: "降级档位接入", what: "复问按请求开关，新增补审队列", accept: "切换档位时在途请求不报错，低峰时补审队列清空" },
];

function Route() {
  return (
    <ol className="route-list">
      {ROUTE.map((r) => (
        <li key={r.id}>
          <span className="r-id mono">{r.id}</span>
          <div className="r-b"><div className="r-t">{r.name}<Badge>未开始</Badge></div><div className="r-w">{r.what}</div><div className="r-a">验收：{r.accept}</div></div>
        </li>
      ))}
    </ol>
  );
}

function Ladder({ sim }: { sim: Sim }) {
  return (
    <ol className="ladder">
      {LEVELS.map((l) => (
        <li key={l.level} className={`${sim.level === l.level ? "on" : ""}`}>
          <span className="lv-n num">{l.level}</span>
          <div className="lv-b"><div className="lv-t">{l.name}{sim.level === l.level ? <Badge tone={l.level ? "warn" : "good"} dot pulse={l.level > 0}>当前</Badge> : null}</div><div className="lv-w">{l.what}</div><div className="lv-c">代价：{l.cost}</div></div>
        </li>
      ))}
    </ol>
  );
}

function Latency({ sim }: { sim: Sim }) {
  const W = 600, H = 110, top = 8;
  const pts = sim.history.slice(-240);
  const x = (i: number): number => (i / 239) * W;
  const y = (v: number): number => H - (Math.min(v, top) / top) * H;
  const done = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.doneS).toFixed(1)}`).join("");
  const day0 = Math.floor((sim.t - 1) / 1440) * 1440;
  const today = sim.history.filter((p) => p.t > day0);
  const over = today.filter((p) => p.doneS > SLO_S).length;
  const worst = today.reduce((m, p) => Math.max(m, p.doneS), 0);
  const degraded = today.filter((p) => p.level > 0).length;
  return (
    <div>
      <div className="lat">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="近 4 小时发布到审完 p95">
          <line x1="0" x2={W} y1={y(SLO_S)} y2={y(SLO_S)} className="slo" vectorEffect="non-scaling-stroke" />
          {done ? <path d={done} className="done" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        <span className="slo-l" style={{ top: `${(1 - SLO_S / top) * 100}%` }}>目标 {SLO_S} s</span>
      </div>
      <div className="kv4">
        <div><span className="k">当前</span><span className={`v num ${sim.doneS > SLO_S ? "bad-t" : ""}`}>{sec(sim.doneS)}</span></div>
        <div><span className="k">今日超标</span><span className={`v num ${over ? "bad-t" : ""}`}>{over}<small> 分钟</small></span></div>
        <div><span className="k">今日最差</span><span className="v num">{sec(worst)}</span></div>
        <div><span className="k">降级时长</span><span className="v num">{degraded}<small> 分钟</small></span></div>
      </div>
      <p className="small faint">发布到审核完成的 p95，近 4 小时（模拟时间）。agent 并发上限为每秒 {AGENT_CAP} 次，当前约 {Math.round(sim.agentShare * 100)}% 的内容转交 agent。</p>
    </div>
  );
}

function Jobs({ sim }: { sim: Sim }) {
  return (
    <div className="jobs">
      <div className="job">
        <div className="job-t">补审高峰期暂缓的内容<span className="faint"> · 在判官卡上以低优先级执行</span></div>
        <div className="job-v num">待补审 {count(sim.deferred)} · 已补审 {count(sim.backfilled)}</div>
      </div>
      {sim.jobs.map((j) => {
        const p = Math.min(1, j.done / j.need);
        const on = sim.cards.filter((c) => c.role === "offline" && c.job === j.kind).length;
        return (
          <div key={j.kind} className="job">
            <div className="job-t">{JOB_INFO[j.kind].label}{JOB_INFO[j.kind].measured ? <span className="m">耗时实测</span> : null}</div>
            <div className="job-bar"><span style={{ width: `${p * 100}%` }} className={p >= 1 ? "full" : ""} /></div>
            <div className="job-v num">{p >= 1 ? "完成" : `${Math.round(p * 100)}%`} · {j.need >= 60 ? `${(j.need / 60).toFixed(1)} 卡时` : `${j.need} 卡分钟`}{on ? ` · ${on} 张卡运行中` : ""}</div>
          </div>
        );
      })}
      <div className="job">
        <div className="job-t">其他团队的批处理任务<span className="faint"> · 无平台任务时运行，最先被抢占</span></div>
        <div className="job-v num">今日累计 {(sim.batchDone / 60).toFixed(1)} 卡时</div>
      </div>
    </div>
  );
}

function Log({ sim }: { sim: Sim }) {
  const [all, setAll] = useState(false);
  const rows = sim.events.slice(0, all ? 40 : 6);
  return (
    <>
      <ul className="cap-log">{rows.map((e, i) => <li key={`${e.t}-${i}`} className={e.tone}><span className="mono faint">{simClock(e.t)}</span><span>{e.text}</span></li>)}</ul>
      {sim.events.length > 6 ? <button className="btn sm ghost log-more" onClick={() => setAll(!all)}>{all ? "收起" : "查看更多"}</button> : null}
    </>
  );
}

export function Capacity() {
  const { sim, running, setRunning, speed, setSpeed, act, reset } = useSim();
  const judges = sim.cards.filter((c) => c.role === "judge").length;
  const offline = sim.cards.filter((c) => c.role === "offline").length;
  const switching = sim.cards.filter((c) => c.role === "switching").length;
  const toggle = (k: keyof Flags): void => reset({ ...sim.flags, [k]: !sim.flags[k] });
  const capPer = sim.level >= 1 ? CAP_FAST : CAP_NORMAL;
  return (
    <>
      <div className="cap-head">
        <h1>容量与调度</h1>
        <p>公司自有的 {CARDS} 张 GPU 始终保持运行：平时执行训练、聚类、OCR 等离线任务，高峰来临前借调为判官，高峰过后归还。<b>本页为前端模拟</b>，切换耗时为单卡实测，其余参数为假设，详见页底。</p>
      </div>
      <section className="hero cap-hero" aria-label="模拟一天">
        <div className="cap-top">
          <div className="cap-clock">
            <span className="lbl"><span className={`dot ${running ? "pulse" : ""}`} />{phaseOf(sim.t)} · 第 {Math.floor((sim.t - 1) / 1440) + 1} 天</span>
            <span className="v num">{simClock(sim.t)}</span>
          </div>
          <div className="cap-stats">
            <div><span className="k">流量</span><span className="v num">{Math.round(sim.demand)}<small> /s</small></span></div>
            <div><span className="k">判官 · 离线</span><span className="v num">{judges}<small> · </small>{offline}{switching ? <small> +{switching} 切换中</small> : null}</span></div>
            <div><span className="k">审核完成 p95</span><span className={`v num ${sim.doneS > SLO_S ? "bad-t" : ""}`}>{sec(sim.doneS)}</span></div>
            <div><span className="k">降级</span><span className={`v ${sim.level ? "warn-t" : ""}`}>{sim.level ? `第 ${sim.level} 档` : "无"}</span></div>
            <div><span className="k">卡池利用率</span><span className="v num">{Math.round(sim.poolUtil * 100)}%</span></div>
          </div>
        </div>
        <div className="cap-main">
          <div className="cap-pool">
            <div className="cap-sec-h"><span>GPU 卡池</span><span className="faint">判官单卡 {capPer} 条/秒</span></div>
            <Pool sim={sim} />
          </div>
          <div className="cap-chart">
            <div className="cap-sec-h"><span>今天</span><span className="faint">流量与判官算力（条/秒），下方为卡的分配</span></div>
            <DayChart sim={sim} />
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
            <button className="btn sm" onClick={() => act(failCard)}>模拟单卡故障</button>
            <button className="btn sm ghost" onClick={() => reset()}>重新开始</button>
          </div>
          <details className="cap-flags">
            <summary>策略开关（修改后从 06:00 重新开始）</summary>
            <div className="row">
              <label className="chk"><input type="checkbox" checked={sim.flags.predict} onChange={() => toggle("predict")} />按预测提前借调</label>
              <label className="chk"><input type="checkbox" checked={sim.flags.degrade} onChange={() => toggle("degrade")} />自动降级</label>
              <label className="chk"><input type="checkbox" checked={sim.flags.evidence} onChange={() => toggle("evidence")} />Kev 带证据复判（agent 占比 15% → 5%）</label>
            </div>
          </details>
        </div>
      </section>

      <div className="grid g-main cap-gap">
        <Panel title="单次切换耗时" sub="单张 5060 Ti 实测，脚本见 python/kevfast/switch_bench.py">
          <SwitchCost sim={sim} />
        </Panel>
        <Panel title="调度日志" sub="模拟时间" flush>
          <Log sim={sim} />
        </Panel>
      </div>

      <div className="grid g-2 cap-gap">
        <Panel title="延迟" sub={`目标：发布到审核完成的 p95 不超过 ${SLO_S} 秒；作者本人发布后即可看到`}>
          <Latency sim={sim} />
        </Panel>
        <Panel title="降级档位" sub="仅当卡池全部借调仍不足时升档">
          <Ladder sim={sim} />
        </Panel>
      </div>

      <div className="grid g-2 cap-gap">
        <Panel title="离线任务" sub="平台任务于零点入队，优先于其他团队的批处理">
          <Jobs sim={sim} />
        </Panel>
        <Panel title="实施路线" sub="尚未实施；每一步均设有真机验收标准">
          <Route />
          <p className="small faint" style={{ marginTop: 10 }}>完整方案：docs/gpu-scheduling-plan-2026-10-09.md</p>
        </Panel>
      </div>

      <Panel title="数字依据" className="cap-gap">
        <ul className="facts">
          {SIM_FACTS.map((f) => <li key={f.k}><span className="faint">{f.k}</span><span className="num">{f.v}</span>{f.measured ? <Badge tone="good">实测</Badge> : <Badge>假设</Badge>}</li>)}
        </ul>
      </Panel>
    </>
  );
}
