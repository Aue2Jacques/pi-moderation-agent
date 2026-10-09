// Console shell: sidebar navigation (a drawer on narrow screens), top bar (where you are, live status, demo traffic,
// reviewer, theme), hash routes.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, errText, loadReviewer, saveReviewer, type ConsoleConfig, type Reviewer, type TrafficStatus } from "./api.ts";
import { useHashRoute } from "./hooks.ts";
import { LiveProvider, useLive } from "./live.tsx";
import { Alert, Icon } from "./ui.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Track } from "./pages/Track.tsx";
import { Reviews } from "./pages/Reviews.tsx";
import { ContentDetail } from "./pages/ContentDetail.tsx";
import { Human } from "./pages/Human.tsx";
import { Appeals } from "./pages/Appeals.tsx";
import { Rules } from "./pages/Rules.tsx";

type Ctx = { config: ConsoleConfig; reviewer: Reviewer | null; setReviewer: (r: Reviewer | null) => void; go: (path: string) => void; isSim: (contentId: string) => boolean };
const ConsoleCtx = createContext<Ctx | null>(null);
export function useConsole(): Ctx {
  const c = useContext(ConsoleCtx);
  if (!c) throw new Error("ConsoleCtx missing");
  return c;
}

const NAV: { id: string; label: string; icon: string; group?: string }[] = [
  { id: "overview", label: "概览", icon: "overview", group: "运行" },
  { id: "track", label: "提交与追踪", icon: "track" },
  { id: "reviews", label: "审次", icon: "list" },
  { id: "human", label: "人工复核", icon: "human", group: "处理" },
  { id: "appeals", label: "申诉", icon: "appeal" },
  { id: "rules", label: "规则与版本", icon: "rules", group: "配置" },
];
const TITLES: Record<string, string> = { overview: "概览", track: "提交与追踪", reviews: "审次", contents: "审次详情", human: "人工复核", appeals: "申诉", rules: "规则与版本" };

function useTheme(): [string, () => void] {
  const sysDark = (): boolean => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset["theme"] ?? (sysDark() ? "dark" : "light"));
  const toggle = (): void => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset["theme"] = next;
    try { localStorage.setItem("console.theme", next); } catch { /* not persisted */ }
    setTheme(next);
  };
  return [theme, toggle];
}

function SignIn({ onDone }: { onDone: (r: Reviewer) => void }) {
  const [reviewer, setReviewer] = useState("");
  const [token, setToken] = useState("");
  return (
    <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={(e) => { e.preventDefault(); if (reviewer && token) onDone({ reviewer, token }); }}>
      <input className="input" placeholder="审核员 ID" value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={{ width: 104 }} aria-label="审核员 ID" />
      <input className="input" placeholder="令牌" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 112 }} aria-label="令牌" />
      <button className="btn sm" type="submit">登录</button>
    </form>
  );
}

const RATES = [6, 12, 20, 40, 60, 120];

/** Demo traffic: running / paused, contents per minute. Shown in demo mode only. */
function TrafficControl({ status }: { status: TrafficStatus }) {
  const [err, setErr] = useState<string | null>(null);
  const set = (body: { per_min?: number; paused?: boolean }): void => { api.post("/api/demo/traffic", body).then(() => setErr(null)).catch((e) => setErr(errText(e))); };
  const running = !status.paused && status.per_min > 0;
  const rates = RATES.includes(status.per_min) || status.per_min === 0 ? RATES : [...RATES, status.per_min].sort((a, b) => a - b);
  return (
    <div className={`traffic ${running ? "" : "paused"}`} title={err ?? `模拟流量：已生成 ${status.generated} 条，模拟审核员已处理 ${status.sim_reviewer.decided} 条`}>
      <span><span className={`dot ${running ? "pulse" : ""}`} /><span className="hide-sm">模拟流量</span></span>
      <label className="row" style={{ gap: 2, flexWrap: "nowrap" }}>
        <span className="sr-only">每分钟条数</span>
        <select value={status.per_min} onChange={(e) => set({ per_min: Number(e.target.value), paused: false })} aria-label="模拟流量每分钟条数">
          {status.per_min === 0 ? <option value={0}>关</option> : null}
          {rates.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <span className="faint">/分</span>
      </label>
      <button type="button" onClick={() => set(status.per_min === 0 ? { per_min: 20, paused: false } : { paused: !status.paused })} aria-label={running ? "暂停模拟流量" : "继续模拟流量"} title={running ? "暂停" : "继续"}>
        <Icon name={running ? "pause" : "play"} size={13} />
      </button>
    </div>
  );
}

export function App() {
  return <LiveProvider><Console /></LiveProvider>;
}

function Console() {
  const live = useLive();
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [reviewer, setReviewerState] = useState<Reviewer | null>(null);
  const [parts, go] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    api.get<ConsoleConfig>("/api/config").then((c) => { setConfig(c); setReviewerState(loadReviewer(c)); }).catch((e) => setCfgError(String(e)));
  }, []);
  const setReviewer = (r: Reviewer | null): void => { saveReviewer(r); setReviewerState(r); };

  const page = parts[0] ?? "overview";
  useEffect(() => { document.title = `${TITLES[page] ?? "控制台"} · 内容审核控制台`; setDrawer(false); }, [page, parts[1]]);

  if (cfgError) return <div className="content"><Alert tone="bad">无法连接网关：{cfgError}</Alert></div>;
  if (!config) return <div className="empty">加载中…</div>;

  let body: ReactNode;
  switch (page) {
    case "track": body = <Track initialId={parts[1] ?? null} />; break;
    case "reviews": body = <Reviews />; break;
    case "contents": body = <ContentDetail contentId={parts[1] ?? ""} />; break;
    case "human": body = <Human selected={parts[1] ?? null} />; break;
    case "appeals": body = <Appeals preset={parts[1] ?? null} />; break;
    case "rules": body = <Rules />; break;
    default: body = <Overview />;
  }
  const humanOpen = live.frame?.stats.human.open ?? 0;
  const prefix = config.demo_traffic?.sim_prefix;
  const isSim = (id: string): boolean => !!prefix && id.startsWith(prefix);
  const traffic = live.frame?.traffic ?? null;

  return (
    <ConsoleCtx.Provider value={{ config, reviewer, setReviewer, go, isSim }}>
      <div className="app">
        <aside className={`side ${drawer ? "open" : ""}`} aria-label="侧栏">
          <div className="side-brand">
            <span className="mark" aria-hidden="true">审</span>
            <span className="name">内容审核控制台</span>
            <button className="btn ghost sm icon close" onClick={() => setDrawer(false)} aria-label="关闭菜单"><Icon name="close" /></button>
          </div>
          <nav className="side-nav" aria-label="主导航">
            {NAV.map((n) => (
              <div key={n.id} style={{ display: "contents" }}>
                {n.group ? <div className="nav-group">{n.group}</div> : null}
                <a href={`#/${n.id}`} className={`nav-item ${page === n.id || (n.id === "reviews" && page === "contents") ? "active" : ""}`} aria-current={page === n.id ? "page" : undefined}>
                  <Icon name={n.icon} />{n.label}
                  {n.id === "human" && humanOpen > 0 ? <span className="nav-count" title={`待处理 ${humanOpen} 条`}>{humanOpen}</span> : null}
                </a>
              </div>
            ))}
          </nav>
          <div className="side-env">
            <div className="env-row"><span className="k">规则</span><span className="v">{config.rules_ver}</span></div>
            <div className="env-row"><span className="k">校准（{config.calib_mode}）</span><span className="v">{config.calib_ver}</span></div>
            <div className="env-row"><span className="k">判官 / agent</span><span className="v">{config.judge_model} / {config.agent_model ?? "—"}</span></div>
          </div>
        </aside>
        <div className={`scrim ${drawer ? "open" : ""}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <div className="main">
          <header className="topbar">
            <button className="btn ghost icon menu-btn" onClick={() => setDrawer(true)} aria-label="打开菜单"><Icon name="menu" /></button>
            <div className="crumb"><span className="root">内容审核</span><span className="sep">/</span><span className="cur">{TITLES[page] ?? "概览"}</span></div>
            <div className="spacer" />
            <div className="top-actions">
              <span className={`live-ind ${live.connected ? "" : "off"}`} title={live.connected ? "已连接实时数据流" : "实时数据流已断开，正在重连"}>
                <span className={`dot ${live.connected ? "pulse" : ""}`} /><span className="txt">{live.connected ? "实时" : "重连中"}</span>
              </span>
              {config.mode === "demo"
                ? <span className="mode hide-sm" title="判官与 agent 是脚本，其余链路与真实模式相同；数字只作演示"><span className="dot" />演示模式</span>
                : <span className="mode real hide-sm"><span className="dot" />真实模式</span>}
              {config.mode === "demo" && traffic ? <TrafficControl status={traffic} /> : null}
              {reviewer ? (
                <span className="reviewer">审核员 <b>{reviewer.reviewer}</b>
                  {config.demo_auth ? null : <button className="btn sm ghost" onClick={() => setReviewer(null)}>退出</button>}</span>
              ) : <SignIn onDone={setReviewer} />}
              <button className="btn ghost icon" onClick={toggleTheme} aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"} title={theme === "dark" ? "浅色" : "深色"}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
            </div>
          </header>
          <main className="content"><div className="page" key={`${page}/${page === "contents" ? parts[1] ?? "" : ""}`}>{body}</div></main>
        </div>
      </div>
    </ConsoleCtx.Provider>
  );
}
