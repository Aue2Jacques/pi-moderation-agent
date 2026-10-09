// The overview's live centrepiece: the processing pipeline (intake -> fast judge -> auto pass / auto action / agent ->
// agent action / human) with dots flowing along each lane in the real split, and the fast-path throughput of the last
// five minutes. Dots are spawned from the change of the cumulative counters between two live frames (stats are exact
// and continuous, also under demo retention), spread over the time until the next frame; at high rates one dot stands
// for several contents (the legend says how many). The lanes and dots are drawn on a canvas in one
// requestAnimationFrame loop; the node cards are HTML on top. prefers-reduced-motion: no dots, numbers jump.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Flow, LiveFrame, Stats } from "./api.ts";
import { AnimatedNumber, prefersReducedMotion } from "./motion.tsx";
import { duration } from "./ui.tsx";

type NodeId = "intake" | "judge" | "pass" | "block" | "agent" | "agentDone" | "human" | "appeal";
type LaneId = "in" | "pass" | "block" | "agent" | "direct" | "appeal" | "agentDone" | "agentHuman";
type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

/** Which counter feeds which lane, and its colour token. */
const LANES: { id: LaneId; from: NodeId; to: NodeId; color: string; count: (s: Stats) => number; after?: LaneId }[] = [
  { id: "in", from: "intake", to: "judge", color: "--flow-in", count: (s) => s.judged },
  { id: "pass", from: "judge", to: "pass", color: "--route-fast_pass", count: (s) => s.routes.fast_pass, after: "in" },
  { id: "block", from: "judge", to: "block", color: "--route-fast_block", count: (s) => s.routes.fast_block, after: "in" },
  { id: "agent", from: "judge", to: "agent", color: "--route-agent", count: (s) => s.routes.agent, after: "in" },
  { id: "direct", from: "judge", to: "human", color: "--route-human_direct", count: (s) => s.routes.human_direct, after: "in" },
  { id: "appeal", from: "appeal", to: "agent", color: "--route-appeal", count: (s) => s.routes.appeal },
  { id: "agentDone", from: "agent", to: "agentDone", color: "--route-agent", count: (s) => s.agent.disposed },
  { id: "agentHuman", from: "agent", to: "human", color: "--route-human_direct", count: (s) => s.agent.released },
];

/** Node centres as fractions of the canvas, for the wide (left to right) and the narrow (top to bottom) layout. */
const WIDE: Record<NodeId, [number, number]> = {
  intake: [0, 0.42], judge: [0.27, 0.42], agent: [0.62, 0.78], appeal: [0.4, 1],
  pass: [1, 0], block: [1, 1 / 3], agentDone: [1, 2 / 3], human: [1, 1],
};
const NARROW: Record<NodeId, [number, number]> = {
  intake: [0.5, 0], judge: [0.5, 0.25], agent: [0.69, 0.55], appeal: [0.94, 0.4],
  pass: [0, 1], block: [1 / 3, 1], agentDone: [2 / 3, 1], human: [1, 1],
};

type Layout = { narrow: boolean; w: number; h: number; boxes: Record<NodeId, Box>; paths: Record<LaneId, [Pt, Pt, Pt, Pt]> };

function layout(w: number): Layout {
  const narrow = w < 600;
  const h = narrow ? 470 : 400;
  const pad = 2;
  const nw = narrow ? Math.max(70, Math.floor((w - 2 * pad - 3 * 6) / 4)) : Math.round(Math.min(156, Math.max(118, w * 0.13)));
  const nh = narrow ? 76 : 66;
  const pos = narrow ? NARROW : WIDE;
  const boxes = {} as Record<NodeId, Box>;
  for (const id of Object.keys(pos) as NodeId[]) {
    const [fx, fy] = pos[id];
    const small = id === "appeal";
    const bw = small ? (narrow ? 64 : 76) : nw, bh = small ? 30 : nh;
    const cx = pad + bw / 2 + fx * (w - 2 * pad - bw);
    const cy = pad + bh / 2 + fy * (h - 2 * pad - bh);
    boxes[id] = { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
  }
  const paths = {} as Layout["paths"];
  for (const l of LANES) {
    const a = boxes[l.from], b = boxes[l.to];
    let p0: Pt, p3: Pt;
    if (l.id === "appeal") { p0 = narrow ? { x: a.x, y: a.y + a.h / 2 } : { x: a.x + a.w / 2, y: a.y }; p3 = narrow ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: b.x + b.w / 2, y: b.y + b.h }; }
    else if (l.id === "direct" && !narrow) { p0 = { x: a.x + a.w / 2, y: a.y + a.h }; p3 = { x: b.x, y: b.y + b.h * 0.72 }; }
    else if (narrow) { p0 = { x: a.x + a.w / 2, y: a.y + a.h }; p3 = { x: b.x + b.w / 2, y: b.y }; }
    else { p0 = { x: a.x + a.w, y: a.y + a.h / 2 }; p3 = { x: b.x, y: b.y + b.h / 2 }; }
    const dx = p3.x - p0.x, dy = p3.y - p0.y;
    const vertical = narrow || l.id === "appeal" || l.id === "direct";
    const c1 = vertical && !(l.id === "appeal" && narrow) ? { x: p0.x, y: p0.y + dy * 0.55 } : { x: p0.x + dx * 0.5, y: p0.y };
    const c2 = vertical && !(l.id === "appeal" && narrow) ? { x: p3.x - (l.id === "direct" && !narrow ? dx * 0.5 : 0), y: p3.y - (l.id === "direct" && !narrow ? 0 : dy * 0.45) } : { x: p3.x - dx * 0.5, y: p3.y };
    paths[l.id] = [p0, c1, c2, p3];
  }
  return { narrow, w, h, boxes, paths };
}

const bez = (p: [Pt, Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p[0].x + b * p[1].x + c * p[2].x + d * p[3].x, y: a * p[0].y + b * p[1].y + c * p[2].y + d * p[3].y };
};

const COLOR_OF = Object.fromEntries(LANES.map((l) => [l.id, l.color])) as Record<LaneId, string>;

type Dot = { lane: LaneId; t0: number; dur: number };
/** at most this many dots a second over all lanes; above it one dot stands for `per` contents */
const DOT_BUDGET = 90;
const TRAVEL_MS = 1500;

/** Lane rates (contents a second) over the last few frames, from the cumulative counters. */
function useRates(frame: LiveFrame | null): Record<LaneId, number> {
  const hist = useRef<{ at: number; c: Record<LaneId, number> }[]>([]);
  return useMemo(() => {
    const out = Object.fromEntries(LANES.map((l) => [l.id, 0])) as Record<LaneId, number>;
    if (!frame) return out;
    const c = Object.fromEntries(LANES.map((l) => [l.id, l.count(frame.stats)])) as Record<LaneId, number>;
    const h = hist.current;
    if (!h.length || h[h.length - 1]!.at !== frame.at) h.push({ at: frame.at, c });
    while (h.length > 2 && frame.at - h[0]!.at > 6000) h.shift();
    const first = h[0]!;
    const dt = (frame.at - first.at) / 1000;
    if (dt > 0.5) for (const l of LANES) out[l.id] = Math.max(0, (c[l.id] - first.c[l.id]) / dt);
    return out;
  }, [frame]);
}

const fmtRate = (x: number): string => (x >= 10 ? x.toFixed(0) : x >= 0.05 ? x.toFixed(1) : "0");
const int = (x: number): string => Math.round(x).toLocaleString("en-US");

export function FlowPipeline({ frame }: { frame: LiveFrame | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);   // dots, redrawn every frame
  const lanes = useRef<HTMLCanvasElement>(null);    // lanes, redrawn on resize and theme change
  const [lay, setLay] = useState<Layout | null>(null);
  const dots = useRef<Dot[]>([]);
  const prev = useRef<{ at: number; c: Record<LaneId, number> } | null>(null);
  const [per, setPer] = useState(1);
  const reduced = prefersReducedMotion();
  const rates = useRates(frame);

  // size: follow the container width
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setLay(layout(Math.max(300, Math.floor(el.clientWidth)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // a new frame: spawn the dots for what moved since the previous one, spread over the expected gap to the next frame
  useEffect(() => {
    if (!frame) return;
    const c = Object.fromEntries(LANES.map((l) => [l.id, l.count(frame.stats)])) as Record<LaneId, number>;
    const p = prev.current;
    prev.current = { at: frame.at, c };
    if (!p || frame.snapshot || reduced) return;
    const gap = Math.min(2500, Math.max(400, frame.at - p.at));
    const deltas = LANES.map((l) => Math.max(0, c[l.id] - p.c[l.id]));
    const total = deltas.reduce((a, b) => a + b, 0);
    const k = Math.max(1, Math.ceil(total / ((DOT_BUDGET * gap) / 1000)));
    setPer(k);
    const now = performance.now();
    LANES.forEach((l, i) => {
      const n = Math.round(deltas[i]! / k);
      for (let j = 0; j < n; j++) {
        const offset = ((j + Math.random() * 0.8) / Math.max(1, n)) * gap + (l.after ? TRAVEL_MS * 0.92 : 0);
        dots.current.push({ lane: l.id, t0: now + offset, dur: TRAVEL_MS * (0.9 + Math.random() * 0.2) });
      }
    });
    if (dots.current.length > 1500) dots.current.splice(0, dots.current.length - 1500);
  }, [frame, reduced]);

  // draw: the lanes on their own canvas (now and then), the dots every animation frame, one path per lane
  useEffect(() => {
    const cv = canvas.current, lv = lanes.current;
    if (!cv || !lv || !lay) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [cv, lv]) { c.width = Math.round(lay.w * dpr); c.height = Math.round(lay.h * dpr); }
    const ctx = cv.getContext("2d"), lctx = lv.getContext("2d");
    if (!ctx || !lctx) return;
    let colors: Record<string, string> = {};
    let sig = "";
    const drawLanes = (): void => {
      const cs = getComputedStyle(document.documentElement);
      colors = Object.fromEntries(["--flow-in", "--route-fast_pass", "--route-fast_block", "--route-agent", "--route-human_direct", "--route-appeal", "--flow-lane"].map((k) => [k, cs.getPropertyValue(k).trim() || "#888"]));
      const next = JSON.stringify(colors);
      if (next === sig) return;
      sig = next;
      lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lctx.clearRect(0, 0, lay.w, lay.h);
      lctx.lineWidth = 1.5;
      lctx.lineCap = "round";
      lctx.strokeStyle = colors["--flow-lane"]!;
      for (const l of LANES) {
        const p = lay.paths[l.id];
        lctx.setLineDash(l.id === "direct" || l.id === "appeal" ? [3, 4] : []);
        lctx.beginPath();
        lctx.moveTo(p[0].x, p[0].y);
        lctx.bezierCurveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
        lctx.stroke();
      }
    };
    drawLanes();
    const theme = setInterval(drawLanes, 1000);   // picks up a theme switch
    if (reduced) return () => clearInterval(theme);
    const byLane = new Map<LaneId, Pt[]>();
    let raf = 0;
    const draw = (t: number): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, lay.w, lay.h);
      byLane.clear();
      const ds = dots.current;
      let keep = 0;
      for (let i = 0; i < ds.length; i++) {
        const d = ds[i]!;
        const k = (t - d.t0) / d.dur;
        if (k >= 1) continue;
        ds[keep++] = d;
        if (k < 0) continue;
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // ease in-out: dots leave and arrive gently
        let a = byLane.get(d.lane);
        if (!a) { a = []; byLane.set(d.lane, a); }
        a.push(bez(lay.paths[d.lane], e));
      }
      ds.length = keep;
      for (const [lane, pts] of byLane) {
        ctx.fillStyle = colors[COLOR_OF[lane]]!;
        ctx.beginPath();
        for (const p of pts) { ctx.moveTo(p.x + 2.6, p.y); ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2); }
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); clearInterval(theme); };
  }, [lay, reduced]);

  const s = frame?.stats;
  const routed = s ? s.routes.fast_pass + s.routes.fast_block + s.routes.agent + s.routes.human_direct : 0;
  const share = (n: number): string => (routed ? `${Math.round((100 * n) / routed)}%` : "—");
  const node = (id: NodeId, label: string, value: number, foot: string, tone?: string, title?: string) => {
    const b = lay?.boxes[id];
    if (!b) return null;
    return (
      <div key={id} className={`fnode ${tone ?? ""}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h }} title={title}>
        <span className="fn-l">{tone ? <i className="sw" style={{ background: `var(${tone})` }} /> : null}{label}</span>
        <span className="fn-v"><AnimatedNumber value={value} format={int} /></span>
        <span className="fn-r">{foot}</span>
      </div>
    );
  };
  return (
    <div className={`flow ${lay?.narrow ? "narrow" : ""}`} ref={wrap} style={{ height: lay?.h ?? 400 }} role="img" aria-label="实时处理管线：接入、判官快判、自动放行、自动处置、agent、人工，点按真实分流比例流动">
      <canvas ref={lanes} style={{ width: lay?.w ?? "100%", height: lay?.h ?? 400 }} aria-hidden="true" />
      <canvas ref={canvas} className="dots" style={{ width: lay?.w ?? "100%", height: lay?.h ?? 400 }} aria-hidden="true" />
      {s && lay ? (
        <>
          {node("intake", "接入", s.contents, `${fmtRate(rates.in)} /s`, undefined, "已接入的内容")}
          {node("judge", lay.narrow ? "快判" : "判官快判", s.judged, `p50 ${duration(frame?.flow?.p50_ms ?? s.latency_ms.fast_p50)}`, undefined, "一次请求问全部规则（主问 + 打乱选项复问）")}
          {node("pass", "自动放行", s.routes.fast_pass, lay.narrow ? `${fmtRate(rates.pass)} /s` : `${fmtRate(rates.pass)} /s · ${share(s.routes.fast_pass)}`, "--route-fast_pass")}
          {node("block", "自动处置", s.routes.fast_block, lay.narrow ? `${fmtRate(rates.block)} /s` : `${fmtRate(rates.block)} /s · ${share(s.routes.fast_block)}`, "--route-fast_block")}
          {node("agent", lay.narrow ? "agent" : "agent 查证据", s.routes.agent + s.routes.appeal, `处理中 ${s.agent.open}`, "--route-agent", "疑似内容与申诉由 agent 取证后复判")}
          {node("agentDone", lay.narrow ? "agent 处置" : "agent 处置", s.agent.disposed, `${fmtRate(rates.agentDone)} /s`, "--route-agent")}
          {node("human", "人工", s.human.closed, lay.narrow ? `待 ${s.human.open}` : `待处理 ${s.human.open}`, "--route-human_direct", "agent 证据不足或系统原因转人工；数字为已完成")}
          {(() => { const b = lay.boxes.appeal; return <div className="fnode chip" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} title={`申诉 ${s.appeals.total} 次，交 agent 重审`}><i className="sw" style={{ background: "var(--route-appeal)" }} />申诉</div>; })()}
        </>
      ) : null}
      {per > 1 && !reduced ? <span className="flow-note">每个点约 {per} 条</span> : null}
    </div>
  );
}

/** Fast-path contents a second over the last five minutes (SVG). */
export function Throughput({ flow, height = 132 }: { flow: Flow | null; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = flow?.series ?? new Array<number>(300).fill(0);
  const max = Math.max(1, ...series);
  const nice = (x: number): number => { const p = Math.pow(10, Math.floor(Math.log10(x))); const m = x / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
  const top = nice(max * 1.1);
  const W = 600, H = 100;
  const x = (i: number): number => (i / (series.length - 1)) * W;
  const y = (v: number): number => H - (v / top) * H;
  const line = series.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${W},${H}L0,${H}Z`;
  const hv = hover !== null ? series[hover] : undefined;
  return (
    <div className="tput" style={{ height }}>
      <div className="tput-y" aria-hidden="true"><span style={{ top: 0 }}>{top}</span><span style={{ top: "50%" }}>{top / 2}</span><span style={{ top: "100%" }}>0</span></div>
      <div className="tput-plot" onMouseLeave={() => setHover(null)} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.max(0, Math.min(series.length - 1, Math.round(((e.clientX - r.left) / r.width) * (series.length - 1))))); }}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="近 5 分钟每秒快判完成条数">
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="gl" vectorEffect="non-scaling-stroke" />
          <path d={area} className="area" />
          <path d={line} className="ln" vectorEffect="non-scaling-stroke" />
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="cur" vectorEffect="non-scaling-stroke" /> : null}
        </svg>
        {hover !== null && hv !== undefined ? <div className="chart-tip tput-tip" style={{ left: `clamp(0px, calc(${(hover / (series.length - 1)) * 100}% + 8px), calc(100% - 132px))` }}>{series.length - 1 - hover === 0 ? "刚才" : `${series.length - 1 - hover} 秒前`} · <b className="num">{hv}</b> 条</div> : null}
      </div>
      <div className="tput-x" aria-hidden="true"><span>5 分钟前</span><span>现在</span></div>
    </div>
  );
}

/** Summary numbers of the throughput window. */
export function flowSummary(flow: Flow | null): { now: number; avg: number; peak: number } {
  const s = flow?.series ?? [];
  const seen = s.findIndex((v) => v > 0);
  const window = seen < 0 ? [] : s.slice(seen);
  return { now: flow?.per_sec ?? 0, avg: window.length ? window.reduce((a, b) => a + b, 0) / window.length : 0, peak: Math.max(0, ...s) };
}
