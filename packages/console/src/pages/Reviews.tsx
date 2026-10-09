// Review list with filters; a row opens the content's full timeline.
import { useState } from "react";
import { useConsole } from "../App.tsx";
import type { ReviewListItem } from "../api.ts";
import { useLive, useLiveQuery } from "../live.tsx";
import { ACTION, ACTOR, ROUTE, ROUTES, SCENE, STATE, reasonText } from "../labels.ts";
import { ActionTag, Alert, Card, Empty, RouteTag, StateTag, dateTime, shortId, yuan } from "../ui.tsx";

const PAGE = 50;

export function Reviews() {
  const { config, go } = useConsole();
  const [f, setF] = useState({ route: "", state: "", scene: "", action: "", actor: "", q: "" });
  const [page, setPage] = useState(0);
  const qs = new URLSearchParams(Object.entries({ ...f, limit: String(PAGE), offset: String(page * PAGE) }).filter(([, v]) => v !== "")).toString();
  const live = useLive();
  const list = useLiveQuery<{ items: ReviewListItem[]; total: number }>(`/api/review-list?${qs}`, live.frame?.versions.reviews);
  const set = (k: keyof typeof f) => (v: string): void => { setF({ ...f, [k]: v }); setPage(0); };
  const sel = (k: keyof typeof f, label: string, opts: [string, string][]) => (
    <label className="field" style={{ minWidth: 120 }}>{label}
      <select className="select" value={f[k]} onChange={(e) => set(k)(e.target.value)}>
        <option value="">全部</option>{opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
  const total = list.data?.total ?? 0;

  return (
    <>
      <Card>
        <div className="row" style={{ alignItems: "end", gap: 12 }}>
          {sel("route", "路径", ROUTES.map((r) => [r, ROUTE[r]]))}
          {sel("state", "状态", Object.entries(STATE))}
          {sel("scene", "场景", config.scenes.map((s) => [s.scene, SCENE[s.scene] ?? s.scene]))}
          {sel("action", "结论", Object.entries(ACTION))}
          {sel("actor", "处理方", Object.entries(ACTOR))}
          <label className="field" style={{ flex: 1, minWidth: 180 }}>搜索
            <input className="input" placeholder="内容 ID 或审次 ID" value={f.q} onChange={(e) => set("q")(e.target.value)} />
          </label>
          <button className="btn" onClick={() => { setF({ route: "", state: "", scene: "", action: "", actor: "", q: "" }); setPage(0); }}>重置</button>
        </div>
      </Card>
      <Card title="审次" sub={`共 ${total} 条`} tight right={
        <div className="row small">
          <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button>
          <span className="muted num">{total ? `${page * PAGE + 1}–${Math.min(total, (page + 1) * PAGE)}` : "0"}</span>
          <button className="btn sm" disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>下一页</button>
        </div>
      }>
        {list.error ? <div className="card-b"><Alert tone="bad">{list.error}</Alert></div> : null}
        {!list.data ? <Empty>加载中…</Empty> : list.data.items.length === 0 ? <Empty>没有符合条件的审次。可以在“提交与追踪”提交一条内容。</Empty> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>内容</th><th>审次</th><th>场景</th><th>路径</th><th>原因</th><th>状态</th><th>结论</th><th>处理方</th><th className="num">agent 费用</th><th>创建</th></tr></thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.review_id} className="click" onClick={() => go(`/contents/${encodeURIComponent(r.content_id)}`)}>
                    <td className="mono" title={r.content_id}>{shortId(r.content_id)}</td>
                    <td className="small muted nowrap">第 {r.seq} 次 · {r.trigger === "appeal" ? "申诉" : r.trigger === "fast" ? "快判" : "疑似"}</td>
                    <td>{SCENE[r.scene] ?? r.scene}</td>
                    <td><RouteTag route={r.route} /></td>
                    <td className="small muted">{reasonText(r.suspect_reason ?? r.release_reason)}</td>
                    <td><StateTag state={r.state} /></td>
                    <td><ActionTag action={r.action} /></td>
                    <td className="small">{r.actor ? ACTOR[r.actor] ?? r.actor : "—"}</td>
                    <td className="num small">{yuan(r.used_micro)}</td>
                    <td className="small faint nowrap num">{dateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
