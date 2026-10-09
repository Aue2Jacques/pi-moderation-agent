// Shared presentational pieces: icons, tags, cards, formatting.
import type { ReactNode } from "react";
import type { Action, RouteKind } from "./api.ts";
import { ACTION, ACTOR, PHASE, ROUTE, STATE } from "./labels.ts";

// ---------- icons (inline SVG, 16px, stroke) ----------
const paths: Record<string, string> = {
  overview: "M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z",
  send: "M4 12l16-8-6 16-2.5-6.5L4 12z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0",
  appeal: "M4 4v6h6M20 20v-6h-6M5.6 15A8 8 0 0019 18M18.4 9A8 8 0 005 6",
  rules: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  sun: "M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  minus: "M5 12h14",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 018 0v4",
  rule: "M6 3h9l4 4v14H6zM9 13h7M9 17h5",
  thread: "M4 5h16v10H8l-4 4zM8 9h8M8 12h5",
  history: "M3 12a9 9 0 103-6.7L3 8M3 3v5h5M12 7v5l3 2",
  scale: "M12 3v18M5 7h14M7 7l-3 7a3 3 0 006 0zM17 7l-3 7a3 3 0 006 0z",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3",
  gavel: "M14 4l6 6M11 7l6 6M3 21l8-8M12.5 5.5l6 6-3 3-6-6z",
  handoff: "M16 11a4 4 0 100-8M8 21v-2a4 4 0 014-4h4M3 15l3 3 4-5",
  alert: "M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  refresh: "M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5",
  inbox: "M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5",
  up: "M7 17L17 7M9 7h8v8",
  back: "M15 18l-6-6 6-6",
};
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={paths[name] ?? paths["minus"]} />
    </svg>
  );
}

// ---------- tags ----------
const ACTION_TONE: Record<Action, string> = { pass: "good", limit: "warn", takedown: "bad" };
const ACTION_ICON: Record<Action, string> = { pass: "check", limit: "minus", takedown: "x" };
export function ActionTag({ action, big }: { action: Action | null | undefined; big?: boolean }) {
  if (!action) return <span className="tag">未定</span>;
  return <span className={`tag ${ACTION_TONE[action]}`} style={big ? { height: 28, fontSize: 14, padding: "0 12px", borderRadius: 14 } : undefined}><Icon name={ACTION_ICON[action]} size={big ? 15 : 13} />{ACTION[action]}</span>;
}
const STATE_TONE: Record<string, string> = { queued: "info", investigating: "info", disposed: "good", human_queue: "warn", human_disposed: "good" };
export function StateTag({ state }: { state: string }) {
  const live = state === "queued" || state === "investigating";
  return <span className={`tag ${STATE_TONE[state] ?? ""}`}>{live ? <span className="dot pulse" style={{ background: "currentColor" }} /> : null}{STATE[state] ?? state}</span>;
}
export function RouteTag({ route }: { route: RouteKind }) {
  return <span className="tag outline"><span className="dot" style={{ background: `var(--route-${route}, var(--text-3))` }} />{ROUTE[route]}</span>;
}
export const ActorText = ({ actor }: { actor: string | null | undefined }) => <span>{actor ? (ACTOR[actor] ?? actor) : "—"}</span>;
export function PhaseTag({ phase }: { phase: string }) {
  const tone = phase === "done" ? "good" : phase === "human" ? "warn" : "info";
  return <span className={`tag ${tone}`}>{phase !== "done" ? <span className="dot pulse" style={{ background: "currentColor" }} /> : <Icon name="check" size={13} />}{PHASE[phase] ?? phase}</span>;
}

// ---------- layout ----------
export function Card({ title, sub, right, children, tight, className }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; tight?: boolean; className?: string }) {
  return (
    <section className={`card ${className ?? ""}`}>
      {title !== undefined ? <div className="card-h"><h2>{title}</h2>{sub ? <span className="sub">{sub}</span> : null}{right ? <div className="right">{right}</div> : null}</div> : null}
      <div className={`card-b ${tight ? "tight" : ""}`}>{children}</div>
    </section>
  );
}
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Alert = ({ tone, children }: { tone: "bad" | "info" | "warn" | "good"; children: ReactNode }) => <div className={`alert ${tone}`} role={tone === "bad" ? "alert" : "status"}>{children}</div>;

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
export const shortId = (id: string): string => (id.length > 26 ? `${id.slice(0, 12)}…${id.slice(-10)}` : id);
