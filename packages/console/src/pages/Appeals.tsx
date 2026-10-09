// Appeals: a user disputes a ruling; G opens a new review (new seq, new agent session) and the old ruling stays
// effective until the new one is made. Duplicate requests (same request id) are idempotent.
import { useEffect, useState } from "react";
import { useConsole } from "../App.tsx";
import { api, errText, type AppealItem, type ContentTimeline, type ReviewListItem } from "../api.ts";
import { ACTOR, APPEAL_REASONS, SCENE, appealReason } from "../labels.ts";
import { useLive, useLiveQuery } from "../live.tsx";
import { useFreshIds } from "../motion.tsx";
import { ActionBadge, Alert, Badge, Empty, Id, PageHead, Panel, SimTag, StateBadge, dateTime } from "../ui.tsx";

export function Appeals({ preset }: { preset: string | null }) {
  const { go, isSim } = useConsole();
  const live = useLive();
  const [contentId, setContentId] = useState(preset ?? "");
  const [reason, setReason] = useState("disagree");
  const [msg, setMsg] = useState<{ tone: "bad" | "good"; text: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<ContentTimeline | null>(null);
  useEffect(() => { if (preset) setContentId(preset); }, [preset]);
  useEffect(() => {
    setTarget(null);
    if (!contentId.trim()) return;
    const id = contentId.trim();
    const t = setTimeout(() => { api.get<ContentTimeline>(`/api/contents/${encodeURIComponent(id)}`).then(setTarget).catch(() => setTarget(null)); }, 250);
    return () => clearTimeout(t);
  }, [contentId]);

  const appeals = useLiveQuery<AppealItem[]>("/api/appeals", live.frame?.versions.appeals);
  const disposed = useLiveQuery<{ items: ReviewListItem[] }>("/api/review-list?state=disposed&limit=8", live.frame?.versions.reviews, undefined, 3000);
  const humanDone = useLiveQuery<{ items: ReviewListItem[] }>("/api/review-list?state=human_disposed&limit=8", live.frame?.versions.reviews, undefined, 3000);
  const freshAppeals = useFreshIds(appeals.data?.map((a) => a.review_id) ?? null, "appeals");
  const candidates = [...(disposed.data?.items ?? []), ...(humanDone.data?.items ?? [])].sort((a, b) => b.updated_at - a.updated_at).slice(0, 8);

  async function submit(): Promise<void> {
    setBusy(true); setMsg(null);
    const id = contentId.trim();
    try {
      const out = await api.post<{ review_id: string; duplicate: boolean }>("/api/appeals", { content_id: id, trigger_request_id: `appeal-${Date.now().toString(36)}`, reason_code: reason });
      setMsg({ tone: "good", text: `已受理，新审次 ${out.review_id}`, id });
      appeals.reload();
    } catch (e) { setMsg({ tone: "bad", text: errText(e) }); } finally { setBusy(false); }
  }
  const last = target?.reviews[target.reviews.length - 1];
  const open = !!last && (last.state === "queued" || last.state === "investigating" || last.state === "human_queue");

  return (
    <>
      <PageHead title="申诉" desc="对已处置的内容发起申诉会开一个新审次由 agent 重审；新裁决形成前，原裁决继续有效。" />
      <div className="split">
        <div className="stack" style={{ gap: 20 }}>
          <Panel title="发起申诉">
            <div className="stack" style={{ gap: 14 }}>
              <label className="field"><span className="field-l">内容 ID</span><input className="input" value={contentId} onChange={(e) => setContentId(e.target.value)} placeholder="例如 c-…，或从下面选一条" /></label>
              {target ? (
                <div className="row small">当前有效处置 <ActionBadge action={target.effective?.action ?? null} />
                  <span className="muted">· {target.reviews.length} 个审次</span>{open ? <Badge tone="warn">最新审次未结束</Badge> : null}</div>
              ) : contentId.trim() ? <div className="small faint">没有找到这条内容</div> : null}
              <label className="field"><span className="field-l">申诉理由</span>
                <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{APPEAL_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}（{r.code}）</option>)}</select>
              </label>
              {msg ? <Alert tone={msg.tone}>{msg.text}{msg.id ? <> · <a href={`#/track/${encodeURIComponent(msg.id)}`}>实时查看重审</a></> : null}</Alert> : null}
              <div className="row"><button className="btn primary" disabled={busy || !contentId.trim()} onClick={() => void submit()}>提交申诉</button></div>
            </div>
          </Panel>
          <Panel title="最近已处置的内容" sub="点选填入" flush>
            {candidates.length === 0 ? <Empty>还没有已处置的内容</Empty> : (
              <table className="table candidates"><tbody>
                {candidates.map((r) => (
                  <tr key={r.review_id} className={`click ${r.content_id === contentId ? "sel" : ""}`} tabIndex={0} onClick={() => setContentId(r.content_id)} onKeyDown={(e) => { if (e.key === "Enter") setContentId(r.content_id); }}>
                    <td><span className="row" style={{ gap: 6 }}><Id value={r.content_id} short />{isSim(r.content_id) ? <SimTag /> : null}</span></td>
                    <td className="nowrap small muted">{SCENE[r.scene] ?? r.scene}</td>
                    <td className="nowrap"><span className="row" style={{ gap: 6, flexWrap: "nowrap" }}><ActionBadge action={r.action} /><span className="small faint">{r.actor ? ACTOR[r.actor] ?? r.actor : ""}</span></span></td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </Panel>
        </div>

        <Panel title="申诉记录" sub={`${appeals.data?.length ?? 0} 条${(appeals.data?.length ?? 0) > 100 ? "，显示最近 100 条" : ""}`} flush>
          {appeals.error ? <div className="panel-b"><Alert tone="bad">{appeals.error}</Alert></div> : null}
          {!appeals.data ? <Empty>加载中…</Empty> : appeals.data.length === 0 ? <Empty>还没有申诉。对已处置的内容发起一次，可以看到新审次如何重审。</Empty> : (
            <div className="table-wrap">
              <table className="table stackable">
                <thead><tr><th>内容</th><th>理由</th><th>原裁决 → 重审结果</th><th>状态</th><th className="num">时间</th></tr></thead>
                <tbody>
                  {appeals.data.slice(0, 100).map((a) => (
                    <tr key={a.review_id} className={`click ${freshAppeals.has(a.review_id) ? "fresh" : ""}`} tabIndex={0} onClick={() => go(`/contents/${encodeURIComponent(a.content_id)}`)} onKeyDown={(e) => { if (e.key === "Enter") go(`/contents/${encodeURIComponent(a.content_id)}`); }}>
                      <td className="lead"><span className="row" style={{ gap: 6 }}><Id value={a.content_id} short />{isSim(a.content_id) ? <SimTag /> : null}</span></td>
                      <td data-label="理由" className="small">{appealReason(a.reason_code)}</td>
                      <td data-label="结果"><span className="row" style={{ gap: 6 }}>
                        {a.prior ? <><ActionBadge action={a.prior.action} /><span className="small faint">{ACTOR[a.prior.actor] ?? a.prior.actor}</span></> : "—"}
                        <span className="faint" aria-label="改为">→</span>
                        {a.result ? <><ActionBadge action={a.result.action} /><span className="small faint">{ACTOR[a.result.actor] ?? a.result.actor}</span>{a.prior && a.prior.action !== a.result.action ? <Badge tone="accent">改判</Badge> : null}</> : <span className="faint small">进行中</span>}
                      </span></td>
                      <td data-label="状态"><StateBadge state={a.state} /></td>
                      <td data-label="时间" className="small faint num nowrap">{dateTime(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
