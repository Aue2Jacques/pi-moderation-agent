// Console shell: sidebar navigation, top bar (title, theme, reviewer), hash routes.
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, loadReviewer, saveReviewer, type ConsoleConfig, type Reviewer, type Stats } from "./api.ts";
import { useHashRoute, usePoll } from "./hooks.ts";
import { Alert, Icon } from "./ui.tsx";
import { Overview } from "./pages/Overview.tsx";
import { Track } from "./pages/Track.tsx";
import { Reviews } from "./pages/Reviews.tsx";
import { ContentDetail } from "./pages/ContentDetail.tsx";
import { Human } from "./pages/Human.tsx";
import { Appeals } from "./pages/Appeals.tsx";
import { Rules } from "./pages/Rules.tsx";

type Ctx = { config: ConsoleConfig; reviewer: Reviewer | null; setReviewer: (r: Reviewer | null) => void; go: (path: string) => void };
const ConsoleCtx = createContext<Ctx | null>(null);
export function useConsole(): Ctx {
  const c = useContext(ConsoleCtx);
  if (!c) throw new Error("ConsoleCtx missing");
  return c;
}

const NAV: { id: string; label: string; icon: string; group?: string }[] = [
  { id: "overview", label: "概览", icon: "overview", group: "运营" },
  { id: "track", label: "提交与追踪", icon: "send" },
  { id: "reviews", label: "审次", icon: "list" },
  { id: "human", label: "人工复核", icon: "user", group: "处理" },
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
    <form className="row" onSubmit={(e) => { e.preventDefault(); if (reviewer && token) onDone({ reviewer, token }); }}>
      <input className="input" placeholder="审核员 ID" value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={{ width: 110 }} aria-label="审核员 ID" />
      <input className="input" placeholder="令牌" type="password" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: 130 }} aria-label="令牌" />
      <button className="btn sm" type="submit">登录</button>
    </form>
  );
}

export function App() {
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [reviewer, setReviewerState] = useState<Reviewer | null>(null);
  const [parts, go] = useHashRoute();
  const [theme, toggleTheme] = useTheme();
  const stats = usePoll<Stats>(config ? "/api/stats" : null, 4000);

  useEffect(() => {
    api.get<ConsoleConfig>("/api/config").then((c) => { setConfig(c); setReviewerState(loadReviewer(c)); }).catch((e) => setCfgError(String(e)));
  }, []);
  const setReviewer = (r: Reviewer | null): void => { saveReviewer(r); setReviewerState(r); };

  const page = parts[0] ?? "overview";
  useEffect(() => { document.title = `${TITLES[page] ?? "控制台"} · 内容审核控制台`; }, [page]);

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
  const humanOpen = stats.data?.human.open ?? 0;

  return (
    <ConsoleCtx.Provider value={{ config, reviewer, setReviewer, go }}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
            <div><div className="brand-name">内容审核控制台</div><div className="brand-sub">Pi moderation agent</div></div>
          </div>
          <nav className="nav" aria-label="主导航">
            {NAV.map((n) => (
              <div key={n.id} style={{ display: "contents" }}>
                {n.group ? <div className="nav-group">{n.group}</div> : null}
                <a href={`#/${n.id}`} className={page === n.id || (n.id === "reviews" && page === "contents") ? "active" : ""}>
                  <Icon name={n.icon} />{n.label}
                  {n.id === "human" && humanOpen > 0 ? <span className="count">{humanOpen}</span> : null}
                </a>
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <div className="kv"><span>模式</span><span className={`badge-mode ${config.mode}`} style={{ fontFamily: "inherit" }}>{config.mode === "demo" ? "演示" : "真实"}</span></div>
            <div className="kv"><span>规则</span><span title={config.rules_ver}>{config.rules_ver}</span></div>
            <div className="kv"><span>校准</span><span title={config.calib_ver}>{config.calib_ver}</span></div>
            <div className="kv"><span>判官</span><span>{config.judge_model}</span></div>
            <div className="kv"><span>agent</span><span>{config.agent_model ?? "—"}</span></div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <h1>{TITLES[page] ?? "概览"}</h1>
            {config.mode === "demo" ? <span className="badge-mode demo" title="判官与 agent 是脚本，其余链路与真实模式相同">演示模式 · 脚本化判官与 agent</span> : <span className="badge-mode real">真实模式</span>}
            <div className="spacer" />
            {reviewer ? (
              <span className="row small muted"><Icon name="user" size={14} />审核员 <b style={{ color: "var(--text)" }}>{reviewer.reviewer}</b>
                {config.demo_auth ? null : <button className="btn sm ghost" onClick={() => setReviewer(null)}>退出</button>}</span>
            ) : <SignIn onDone={setReviewer} />}
            <button className="btn sm ghost" onClick={toggleTheme} aria-label={theme === "dark" ? "切换到浅色" : "切换到深色"} title={theme === "dark" ? "浅色" : "深色"}><Icon name={theme === "dark" ? "sun" : "moon"} /></button>
          </header>
          <main className="content"><div className="page">{body}</div></main>
        </div>
      </div>
    </ConsoleCtx.Provider>
  );
}
