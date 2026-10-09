// Appeals: a user disputes a ruling; G opens a new review (new seq, new agent session) and the old ruling stays
// effective until the new one is made. Duplicate requests (same request id) are idempotent.
import { useEffect, useState } from "react";
import { useConsole } from "../App.tsx";
import { api, errText, type AppealItem, type ContentTimeline, type ReviewListItem } from "../api.ts";
import { usePoll } from "../hooks.ts";
import { ACTOR, APPEAL_REASONS, SCENE, appealReason } from "../labels.ts";
import { ActionTag, Alert, Card, Empty, Icon, StateTag, dateTime, shortId } from "../ui.tsx";

export function Appeals({ preset }: { preset: string | null }) {
  const { go } = useConsole();
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

  const appeals = usePoll<AppealItem[]>("/api/appeals", 2500);
  const disposed = usePoll<{ items: ReviewListItem[] }>("/api/review-list?state=disposed&limit=8", 4000);
  const humanDone = usePoll<{ items: ReviewListItem[] }>("/api/review-list?state=human_disposed&limit=8", 4000);
  const candidates = [...(disposed.data?.items ?? []), ...(humanDone.data?.items ?? [])].sort((a, b) => b.updated_at - a.updated_at).slice(0, 10);

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
    <div className="split">
      <div className="stack" style={{ gap: 16 }}>
        <Card title="发起申诉" sub="开新审次重审，原裁决在此期间继续有效">
          <div className="stack">
            <label className="field">内容 ID<input className="input" value={contentId} onChange={(e) => setContentId(e.target.value)} placeholder="例如 c-…" /></label>
            {target ? (
              <div className="row small">当前有效处置 <ActionTag action={target.effective?.action ?? null} />
                <span className="muted">· {target.reviews.length} 个审次</span>{open ? <span className="tag warn">最新审次未结束</span> : null}</div>
            ) : contentId.trim() ? <div className="small faint">没有找到这条内容</div> : null}
            <label className="field">申诉理由
              <select className="select" value={reason} onChange={(e) => setReason(e.target.value)}>{APPEAL_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}（{r.code}）</option>)}</select>
            </label>
            {msg ? <Alert tone={msg.tone}>{msg.text}{msg.id ? <> · <a href={`#/track/${encodeURIComponent(msg.id)}`}>实时查看重审</a></> : null}</Alert> : null}
            <div className="row"><button className="btn primary" disabled={busy || !contentId.trim()} onClick={() => void submit()}><Icon name="appeal" size={14} />提交申诉</button></div>
          </div>
        </Card>
        <Card title="最近已处置的内容" sub="点选填入" tight>
          {candidates.length === 0 ? <Empty>还没有已处置的内容</Empty> : (
            <table className="tbl"><tbody>
              {candidates.map((r) => (
                <tr key={r.review_id} className={`click ${r.content_id === contentId ? "sel" : ""}`} onClick={() => setContentId(r.content_id)}>
                  <td className="mono">{shortId(r.content_id)}</td><td>{SCENE[r.scene] ?? r.scene}</td><td><ActionTag action={r.action} /></td><td className="small muted">{r.actor ? ACTOR[r.actor] ?? r.actor : ""}</td>
                </tr>
              ))}
            </tbody></table>
          )}
        </Card>
      </div>

      <Card title="申诉记录" sub={`${appeals.data?.length ?? 0} 条`} tight>
        {appeals.error ? <div className="card-b"><Alert tone="bad">{appeals.error}</Alert></div> : null}
        {!appeals.data ? <Empty>加载中…</Empty> : appeals.data.length === 0 ? <Empty>还没有申诉。对已处置的内容发起一次，可以看到新审次如何重审。</Empty> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>内容</th><th>理由</th><th>原裁决</th><th /><th>重审结果</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>
                {appeals.data.map((a) => (
                  <tr key={a.review_id} className="click" onClick={() => go(`/contents/${encodeURIComponent(a.content_id)}`)}>
                    <td className="mono">{shortId(a.content_id)}</td>
                    <td className="small">{appealReason(a.reason_code)}</td>
                    <td>{a.prior ? <span className="row"><ActionTag action={a.prior.action} /><span className="small faint">{ACTOR[a.prior.actor] ?? a.prior.actor}</span></span> : "—"}</td>
                    <td className="faint">→</td>
                    <td>{a.result ? <span className="row"><ActionTag action={a.result.action} /><span className="small faint">{ACTOR[a.result.actor] ?? a.result.actor}</span>{a.prior && a.prior.action !== a.result.action ? <span className="tag info">改判</span> : null}</span> : <span className="faint">进行中</span>}</td>
                    <td><StateTag state={a.state} /></td>
                    <td className="small faint num nowrap">{dateTime(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
