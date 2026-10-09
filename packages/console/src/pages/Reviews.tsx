// Review list with filters; a row opens the content's full timeline. Re-read when the live stream says reviews changed.
import { memo, useCallback, useState } from "react";
import { useConsole } from "../App.tsx";
import type { ReviewListItem } from "../api.ts";
import { ACTION, ACTOR, ROUTE, ROUTES, SCENE, STATE, reasonText } from "../labels.ts";
import { useLive, useLiveQuery } from "../live.tsx";
import { useFreshIds } from "../motion.tsx";
import { ActionBadge, Alert, Empty, Id, PageHead, Panel, RouteBadge, SimTag, StateBadge, dateTime, yuan } from "../ui.tsx";

const PAGE = 50;
const NONE = { route: "", state: "", scene: "", action: "", actor: "", q: "" };

export function Reviews() {
  const { config, go, isSim } = useConsole();
  const live = useLive();
  const [f, setF] = useState(NONE);
  const [page, setPage] = useState(0);
  // follow: re-read whenever reviews change; off (or any page but the first): the list holds still until switched back
  const [follow, setFollow] = useState(true);
  const [held, setHeld] = useState<string | undefined>(undefined);
  const qs = new URLSearchParams(Object.entries({ ...f, limit: String(PAGE), offset: String(page * PAGE) }).filter(([, v]) => v !== "")).toString();
  const following = follow && page === 0;
  const version = following ? live.frame?.versions.reviews : held;
  // at most one re-read every 2 s: at high demo rates the first page is replaced almost entirely each time
  const list = useLiveQuery<{ items: ReviewListItem[]; total: number }>(`/api/review-list?${qs}`, version, undefined, 2000);
  const toggleFollow = (): void => { setHeld(live.frame?.versions.reviews); setFollow(!follow); };
  const set = (k: keyof typeof f) => (v: string): void => { setF({ ...f, [k]: v }); setPage(0); };
  const goPage = (n: number): void => { setHeld(live.frame?.versions.reviews); setPage(n); };
  const sel = (k: keyof typeof f, label: string, opts: [string, string][]) => (
    <label className="field"><span className="field-l">{label}</span>
      <select className="select" value={f[k]} onChange={(e) => set(k)(e.target.value)}>
        <option value="">全部</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  const total = list.data?.total ?? 0;
  const fresh = useFreshIds(list.data?.items.map((r) => r.review_id) ?? null, list.path ?? "");
  const open = useCallback((r: ReviewListItem): void => go(`/contents/${encodeURIComponent(r.content_id)}`), [go]);

  return (
    <>
      <PageHead title="审次" desc="每次审核（快判、agent、人工、申诉重审）是一个审次。点一行查看这条内容的完整时间线。" />
      <Panel>
        <div className="filters">
          {sel("route", "路径", ROUTES.map((r) => [r, ROUTE[r]]))}
          {sel("state", "状态", Object.entries(STATE))}
          {sel("scene", "场景", config.scenes.map((s) => [s.scene, SCENE[s.scene] ?? s.scene]))}
          {sel("action", "结论", Object.entries(ACTION))}
          {sel("actor", "处理方", Object.entries(ACTOR))}
          <label className="field wide"><span className="field-l">搜索</span>
            <input className="input" placeholder="内容 ID 或审次 ID" value={f.q} onChange={(e) => set("q")(e.target.value)} />
          </label>
          <button className="btn wide" onClick={() => { setF(NONE); setPage(0); }} disabled={JSON.stringify(f) === JSON.stringify(NONE)}>重置</button>
        </div>
      </Panel>
      <Panel title="审次列表" sub={`共 ${total.toLocaleString("en-US")} 条${config.mode === "demo" ? "（演示模式只保留最近的模拟内容）" : ""}`} flush actions={
        <div className="row small">
          <button className={`btn sm ${following ? "" : "ghost"}`} onClick={toggleFollow} aria-pressed={follow} title={follow ? "新审次到达时自动刷新（第一页）；点一下停住列表" : "列表已停住；点一下恢复自动刷新"}>
            <span className={`dot ${following ? "pulse" : ""}`} style={{ background: following ? "var(--good)" : "var(--text-3)" }} />{follow ? "跟随最新" : "已暂停刷新"}
          </button>
          <button className="btn sm" disabled={page === 0} onClick={() => goPage(page - 1)}>上一页</button>
          <span className="muted num nowrap">{total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)}` : "0"}</span>
          <button className="btn sm" disabled={(page + 1) * PAGE >= total} onClick={() => goPage(page + 1)}>下一页</button>
        </div>
      }>
        {list.error ? <div className="panel-b"><Alert tone="bad">{list.error}</Alert></div> : null}
        {!list.data ? <Empty>加载中…</Empty> : list.data.items.length === 0 ? <Empty>没有符合条件的审次。可以在“提交与追踪”提交一条内容。</Empty> : (
          <div className="table-wrap">
            <table className="table stackable">
              <thead><tr><th>内容</th><th>场景</th><th>路径</th><th>原因</th><th>状态</th><th>结论</th><th>处理方</th><th className="num">agent 费用</th><th className="num">创建</th></tr></thead>
              <tbody>
                {list.data.items.map((r) => <Row key={r.review_id} r={r} fresh={fresh.has(r.review_id)} sim={isSim(r.content_id)} open={open} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/** One row; memoized, so a live frame that does not change the list does not re-render the table. */
const Row = memo(function Row({ r, fresh, sim, open }: { r: ReviewListItem; fresh: boolean; sim: boolean; open: (r: ReviewListItem) => void }) {
  return (
    <tr className={`click ${fresh ? "fresh" : ""}`} tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => { if (e.key === "Enter") open(r); }}>
      <td className="lead"><div className="cell-2"><span className="row" style={{ gap: 6 }}><Id value={r.content_id} short />{sim ? <SimTag /> : null}</span>
        <span className="s">第 {r.seq} 次 · {r.trigger === "appeal" ? "申诉" : r.trigger === "fast" ? "快判" : "疑似"}</span></div></td>
      <td data-label="场景" className="nowrap">{SCENE[r.scene] ?? r.scene}</td>
      <td data-label="路径"><RouteBadge route={r.route} /></td>
      <td data-label="原因" className="small muted" style={{ minWidth: 120 }}>{reasonText(r.suspect_reason ?? r.release_reason)}</td>
      <td data-label="状态"><StateBadge state={r.state} /></td>
      <td data-label="结论"><ActionBadge action={r.action} /></td>
      <td data-label="处理方" className="small nowrap">{r.actor ? ACTOR[r.actor] ?? r.actor : "—"}</td>
      <td data-label="agent 费用" className="num small nowrap">{yuan(r.used_micro)}</td>
      <td data-label="创建" className="small faint nowrap num">{dateTime(r.created_at)}</td>
    </tr>
  );
});
