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
import { Capacity } from "./pages/Capacity.tsx";
import { Agent } from "./pages/Agent.tsx";
import { System } from "./pages/System.tsx";
import { Glossary } from "./pages/Glossary.tsx";
import { demoJudgeNote } from "./labels.ts";

type Ctx = { config: ConsoleConfig; reviewer: Reviewer | null; setReviewer: (r: Reviewer | null) => void; go: (path: string) => void; isSim: (contentId: string) => boolean };
const ConsoleCtx = createContext<Ctx | null>(null);
export function useConsole(): Ctx {
  const c = useContext(ConsoleCtx);
  if (!c) throw new Error("ConsoleCtx missing");
  return c;
}

const NAV: { id: string; label: string; icon: string; group?: string }[] = [
  { id: "overview", label: "概览", icon: "overview", group: "了解系统" },
  { id: "track", label: "提交与追踪", icon: "track" },
  { id: "agent", label: "Agent 与 Harness", icon: "agent" },
  { id: "capacity", label: "容量与调度", icon: "capacity" },
  { id: "human", label: "人工复核", icon: "human", group: "审核后台" },
  { id: "appeals", label: "申诉", icon: "appeal" },
  { id: "reviews", label: "审次", icon: "list" },
  { id: "rules", label: "规则与版本", icon: "rules" },
  { id: "system", label: "系统状态", icon: "system", group: "其他" },
  { id: "glossary", label: "术语表", icon: "glossary" },
];
const TITLES: Record<string, string> = { overview: "概览", track: "提交与追踪", reviews: "审次", contents: "审次详情", human: "人工复核", appeals: "申诉", rules: "规则与版本", capacity: "容量与调度", agent: "Agent 与 Harness", system: "系统状态", glossary: "术语表" };

/** The suggested reading order: each page ends with a link to the next one (NextStop). */
export const TOUR: { id: string; label: string; why: string }[] = [
  { id: "overview", label: "概览", why: "实时查看整条审核流水线，以及内容在各环节的分布" },
  { id: "track", label: "提交与追踪", why: "提交一条评论或截图，几秒内即可看到它经过的每一步" },
  { id: "agent", label: "Agent 与 Harness", why: "agent 如何逐步取证，harness 如何约束它的每一步" },
  { id: "capacity", label: "容量与调度", why: "早晚高峰与突发热点下，GPU 资源如何调度" },
  { id: "human", label: "人工复核", why: "agent 无法确定的内容交由人工领取、查看证据并裁决" },
  { id: "rules", label: "规则与版本", why: "每条结论依据的规则版本，以及新规则如何逐步放量" },
];

function NextStop({ page }: { page: string }) {
  const i = TOUR.findIndex((x) => x.id === page);
  if (i < 0 || i === TOUR.length - 1) return null;
  const n = TOUR[i + 1]!;
  return (
    <a className="next-stop" href={`#/${n.id}`}>
      <span className="ns-k">下一页 · {i + 2}/{TOUR.length}</span>
      <span className="ns-t">{n.label} →</span>
      <span className="ns-w">{n.why}</span>
    </a>
  );
}

/** Phones: the sidebar is a drawer, so the main pages get a tab bar at the bottom. */
const TABS: { id: string; label: string; icon: string }[] = [
  { id: "overview", label: "概览", icon: "overview" }, { id: "track", label: "提交", icon: "track" },
  { id: "agent", label: "Agent", icon: "agent" }, { id: "capacity", label: "调度", icon: "capacity" },
];

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

/** Demo traffic: pause and rate tiers (contents a second). Shown in demo mode only; a select on narrow screens. */
function TrafficControl({ status }: { status: TrafficStatus }) {
  const [err, setErr] = useState<string | null>(null);
  const set = (body: { per_sec?: number; paused?: boolean }): void => { api.post("/api/demo/traffic", body).then(() => setErr(null)).catch((e) => setErr(errText(e))); };
  const running = !status.paused && status.per_sec > 0;
  const tiers = status.tiers.length ? status.tiers : [1, 5, 10, 20, 50];
  const title = err ?? `已生成 ${status.generated.toLocaleString("en-US")} 条，模拟审核员已处理 ${status.sim_reviewer.decided.toLocaleString("en-US")} 条`;
  return (
    <div className={`traffic ${running ? "" : "paused"}`} title={title}>
      <span className="tl"><span className={`dot ${running ? "pulse" : ""}`} /><span className="hide-md">模拟流量</span></span>
      <button type="button" className="tp" onClick={() => set(status.per_sec === 0 ? { per_sec: 10, paused: false } : { paused: !status.paused })} aria-label={running ? "暂停模拟流量" : "继续模拟流量"} title={running ? "暂停" : "继续"}>
        <Icon name={running ? "pause" : "play"} size={13} />
      </button>
      <div className="tiers hide-sm" role="radiogroup" aria-label="模拟流量每秒条数">
        {tiers.map((r) => (
          <button key={r} type="button" role="radio" aria-checked={running && status.per_sec === r} className={running && status.per_sec === r ? "on" : ""} onClick={() => set({ per_sec: r, paused: false })} aria-label={`每秒 ${r} 条`} title={`每秒 ${r} 条`}>{r}</button>
        ))}
        <span className="u">/秒</span>
      </div>
      <label className="tsel show-sm">
        <span className="sr-only">每秒条数</span>
        <select value={tiers.includes(status.per_sec) ? status.per_sec : ""} onChange={(e) => set({ per_sec: Number(e.target.value), paused: false })} aria-label="模拟流量每秒条数（下拉）">
          {tiers.includes(status.per_sec) ? null : <option value="">{status.per_sec === 0 ? "关" : `${status.per_sec}/秒`}</option>}
          {tiers.map((r) => <option key={r} value={r}>{r}/秒</option>)}
        </select>
      </label>
    </div>
  );
}

export function App() {
  return <LiveProvider><Console /></LiveProvider>;
}

function Console() {
  const live = useLive();
  // the gateway inlines the config into index.html (window.__CONSOLE_CONFIG__): no extra round trip before the first paint
  const [config, setConfig] = useState<ConsoleConfig | null>(() => (window as { __CONSOLE_CONFIG__?: ConsoleConfig }).__CONSOLE_CONFIG__ ?? null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [reviewer, setReviewerState] = useState<Reviewer | null>(null);
  const [parts, go] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const pre = (window as { __CONSOLE_CONFIG__?: ConsoleConfig }).__CONSOLE_CONFIG__;
    if (pre) { setReviewerState(loadReviewer(pre)); return; }
    api.get<ConsoleConfig>("/api/config").then((c) => { setConfig(c); setReviewerState(loadReviewer(c)); }).catch((e) => setCfgError(String(e)));
  }, []);
  const setReviewer = (r: Reviewer | null): void => { saveReviewer(r); setReviewerState(r); };

  const page = parts[0] ?? "overview";
  useEffect(() => { document.title = `${TITLES[page] ?? "控制台"} · 内容审核控制台`; setDrawer(false); }, [page, parts[1]]);

  if (cfgError) return <div className="content"><Alert tone="bad">无法连接服务：{cfgError}</Alert></div>;
  if (!config) return <div className="empty">加载中…</div>;

  let body: ReactNode;
  switch (page) {
    case "track": body = <Track initialId={parts[1] ?? null} />; break;
    case "reviews": body = <Reviews />; break;
    case "contents": body = <ContentDetail contentId={parts[1] ?? ""} />; break;
    case "human": body = <Human selected={parts[1] ?? null} />; break;
    case "appeals": body = <Appeals preset={parts[1] ?? null} />; break;
    case "rules": body = <Rules />; break;
    case "capacity": body = <Capacity />; break;
    case "agent": body = <Agent />; break;
    case "system": body = <System />; break;
    case "glossary": body = <Glossary />; break;
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
          <details className="side-env">
            <summary>版本信息</summary>
            <div className="env-row"><span className="k">规则</span><span className="v">{config.rules_ver}</span></div>
            <div className="env-row"><span className="k">校准（{config.calib_mode}）</span><span className="v">{config.calib_ver}</span></div>
            <div className="env-row"><span className="k">判官 / agent</span><span className="v">{config.judge_model} / {config.agent_model ?? "—"}</span></div>
          </details>
        </aside>
        <div className={`scrim ${drawer ? "open" : ""}`} onClick={() => setDrawer(false)} aria-hidden="true" />
        <div className="main">
          <header className="topbar">
            <button className="btn ghost icon menu-btn" onClick={() => setDrawer(true)} aria-label="打开菜单"><Icon name="menu" /></button>
            <div className="crumb"><span className="root">内容审核</span><span className="sep">/</span><span className="cur">{TITLES[page] ?? "概览"}</span></div>
            <div className="spacer" />
            <div className="top-actions">
              <span className={`live-ind ${live.connected ? "" : "off"}`} title={live.connected ? "实时数据已连接" : "实时数据已断开，正在重连"}>
                <span className={`dot ${live.connected ? "pulse" : ""}`} /><span className="txt">{live.connected ? "实时" : "重连中"}</span>
              </span>
              {config.mode === "demo"
                ? <span className="mode hide-sm" title={`${demoJudgeNote(config)}。其余流程与正式环境一致`}><span className="dot" />演示模式</span>
                : <span className="mode real hide-sm"><span className="dot" />真实模式</span>}
              {config.mode === "demo" && traffic ? <TrafficControl status={traffic} /> : null}
              {reviewer ? (
                <span className="reviewer">审核员 <b>{reviewer.reviewer}</b>
                  {config.demo_auth ? null : <button className="btn sm ghost" onClick={() => setReviewer(null)}>退出</button>}</span>
              ) : <SignIn onDone={setReviewer} />}
              <button className="btn ghost icon" onClick={toggleTheme} aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"} title={theme === "dark" ? "浅色" : "深色"}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
            </div>
          </header>
          <main className="content"><div className="page" key={`${page}/${page === "contents" ? parts[1] ?? "" : ""}`}>{body}<NextStop page={page} /></div></main>
        </div>
        <nav className="tabbar" aria-label="常用页面">
          {TABS.map((x) => (
            <a key={x.id} href={`#/${x.id}`} className={page === x.id ? "on" : ""} aria-current={page === x.id ? "page" : undefined}><Icon name={x.icon} size={18} /><span>{x.label}</span></a>
          ))}
          <button type="button" onClick={() => setDrawer(true)} className={drawer ? "on" : ""}><Icon name="menu" size={18} /><span>全部</span></button>
        </nav>
      </div>
    </ConsoleCtx.Provider>
  );
}
