// Shared presentational pieces: icons (navigation only), badges, panels, KPI cells, ids and long text, formatting.
// Text is never clipped without a way to read it: shortened ids and clamped text carry the full value in `title`
// and expand on click.
import { useState, type ReactNode } from "react";
import type { Action, RouteKind } from "./api.ts";
import { ACTION, ACTOR, PHASE, ROUTE, STATE } from "./labels.ts";

// ---------- icons (inline SVG, 16px, stroke): navigation and a few controls only ----------
const paths: Record<string, string> = {
  overview: "M4 13h4v7H4zM10 8h4v12h-4zM16 4h4v16h-4z",
  track: "M4 12h4l3-7 4 14 3-7h2",
  list: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  human: "M12 12a4 4 0 100-8 4 4 0 000 8zM5 20a7 7 0 0114 0",
  appeal: "M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0019 18M18.4 9A8 8 0 005 6",
  rules: "M7 3h8l4 4v14H7zM14 3v5h5M10 13h6M10 17h4",
  capacity: "M4 6h16v4H4zM4 14h16v4H4zM7 8h.01M7 16h.01",
  agent: "M12 3v3M7 8h10a2 2 0 012 2v7a2 2 0 01-2 2H7a2 2 0 01-2-2v-7a2 2 0 012-2zM9.5 13h.01M14.5 13h.01M9.5 16.5h5",
  sun: "M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20.5 13.5A8.5 8.5 0 1110.5 3.5a6.5 6.5 0 0010 10z",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
  back: "M15 18l-6-6 6-6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 018 0v4",
  pause: "M8 5v14M16 5v14",
  play: "M7 5l12 7-12 7z",
};
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name] ?? paths["close"]} />
    </svg>
  );
}

// ---------- badges ----------
export type Tone = "good" | "warn" | "bad" | "info" | "neutral" | "accent";
export function Badge({ tone = "neutral", dot, pulse, children, title, className }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; title?: string; className?: string }) {
  return <span className={`badge ${tone} ${className ?? ""}`} title={title}>{dot ? <span className={`dot ${pulse ? "pulse" : ""}`} /> : null}{children}</span>;
}
const ACTION_TONE: Record<Action, Tone> = { pass: "good", limit: "warn", takedown: "bad" };
export function ActionBadge({ action, big }: { action: Action | null | undefined; big?: boolean }) {
  if (!action) return <Badge key="none">未定</Badge>;
  // keyed by value: a changed action re-mounts and plays the swap transition
  return <Badge key={action} tone={ACTION_TONE[action]} className={`swap ${big ? "lg" : ""}`}>{ACTION[action]}</Badge>;
}
const STATE_TONE: Record<string, Tone> = { queued: "info", investigating: "info", disposed: "neutral", human_queue: "warn", human_disposed: "neutral" };
export function StateBadge({ state }: { state: string }) {
  const live = state === "queued" || state === "investigating" || state === "human_queue";
  return <Badge key={state} tone={STATE_TONE[state] ?? "neutral"} dot pulse={state === "investigating"} className={`swap ${live ? "" : "quiet"}`}>{STATE[state] ?? state}</Badge>;
}
export function RouteBadge({ route }: { route: RouteKind }) {
  return <span className="route"><span className="sw" style={{ background: `var(--route-${route}, var(--text-3))` }} />{ROUTE[route]}</span>;
}
export function PhaseBadge({ phase }: { phase: string }) {
  const tone: Tone = phase === "done" ? "good" : phase === "human" ? "warn" : "info";
  return <Badge key={phase} tone={tone} dot pulse={phase !== "done"} className="swap">{PHASE[phase] ?? phase}</Badge>;
}
export const ActorText = ({ actor }: { actor: string | null | undefined }) => <span>{actor ? (ACTOR[actor] ?? actor) : "—"}</span>;
/** Marks generated demo traffic and the simulated reviewer. */
export const SimTag = ({ title = "演示程序自动生成的数据" }: { title?: string }) => <span className="sim" title={title}>模拟</span>;

// ---------- layout ----------
export function Panel({ title, sub, actions, children, flush, className, id }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string }) {
  return (
    <section className={`panel ${className ?? ""}`} id={id}>
      {title !== undefined ? (
        <header className="panel-h">
          <div className="panel-t"><h2>{title}</h2>{sub ? <span className="sub">{sub}</span> : null}</div>
          {actions ? <div className="panel-a">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`panel-b ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}
export function PageHead({ title, desc, actions }: { title: string; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="ph-t"><h1>{title}</h1>{desc ? <p>{desc}</p> : null}</div>
      {actions ? <div className="ph-a">{actions}</div> : null}
    </div>
  );
}
export function Kpi({ label, value, unit, foot, tone }: { label: string; value: ReactNode; unit?: string; foot?: ReactNode; tone?: Tone }) {
  return (
    <div className="kpi">
      <div className="kpi-l">{label}</div>
      <div className={`kpi-v ${tone ?? ""}`}>{value}{unit ? <span className="unit">{unit}</span> : null}</div>
      {foot ? <div className="kpi-f">{foot}</div> : null}
    </div>
  );
}
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Alert = ({ tone, children }: { tone: "bad" | "info" | "warn" | "good"; children: ReactNode }) => <div className={`alert ${tone}`} role={tone === "bad" ? "alert" : "status"}>{children}</div>;

/** An id in monospace. `short`: middle-shortened, full value on hover, click to show it in full. */
export function Id({ value, short, className }: { value: string; short?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const cut = short && !open && value.length > 24;
  if (!cut && !short) return <span className={`mono id ${className ?? ""}`} title={value}>{value}</span>;
  return (
    <span className={`mono id ${short ? "can-open" : ""} ${className ?? ""}`} title={value} role="button" tabIndex={0}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setOpen(!open); } }}>
      {cut ? `${value.slice(0, 11)}…${value.slice(-9)}` : value}
    </span>
  );
}

/** Long text clamped to `lines`; full text on hover, click to expand. */
export function Clamp({ text, lines = 2, className }: { text: string; lines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={`clamp ${open ? "open" : ""} ${className ?? ""}`} style={{ WebkitLineClamp: open ? "unset" : lines }} title={open ? undefined : text}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>{text}</span>
  );
}

// ---------- formatting ----------
export const pad2 = (n: number): string => String(n).padStart(2, "0");
export function clock(ms: number): string { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
export function dateTime(ms: number): string { const d = new Date(ms); return `${d.getMonth() + 1}-${pad2(d.getDate())} ${clock(ms)}`; }
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s / 60} 分钟`;
  const m = Math.round(s / 60);
  return m % 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m / 60} 小时`;
}
/** micro-yuan -> yuan text */
export function yuan(micro: number | null | undefined, digits = 4): string { return micro === null || micro === undefined ? "—" : `¥${(micro / 1e6).toFixed(digits)}`; }
export const p2 = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : x.toFixed(2));
export const p3 = (x: number | null | undefined): string => (x === null || x === undefined ? "—" : x.toFixed(3));
export const pct = (n: number, d: number): string => (d ? `${Math.round((100 * n) / d)}%` : "—");
