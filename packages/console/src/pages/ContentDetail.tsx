// One content's full timeline (live). The restricted view (original text, neighbour text, free-text reasons) needs a
// reviewer and an explicit confirmation, and every opening is written to the audit log by G.
import { useState } from "react";
import { useConsole } from "../App.tsx";
import { api, authHeaders, errText, type ContentTimeline } from "../api.ts";
import { useEventSource } from "../hooks.ts";
import { ContentHeader, EventFeed, Pipeline, ReviewCards } from "../Timeline.tsx";
import { Alert, Empty, Icon, Id, PageHead, Panel, dateTime } from "../ui.tsx";

export function ContentDetail({ contentId }: { contentId: string }) {
  const { reviewer, isSim } = useConsole();
  const { data: live } = useEventSource<ContentTimeline>(contentId ? `/api/contents/${encodeURIComponent(contentId)}/stream` : null, "timeline");
  const [restricted, setRestricted] = useState<ContentTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openRestricted(): Promise<void> {
    if (!reviewer) { setError("需要先以审核员身份登录"); return; }
    if (!window.confirm("查看原文与证据全文属于受限操作，会以你的身份写入审计日志。继续？")) return;
    try {
      setRestricted(await api.get<ContentTimeline>(`/api/contents/${encodeURIComponent(contentId)}?view=restricted`, { ...authHeaders(reviewer), "x-confirm": "yes" }));
      setError(null);
    } catch (e) { setError(errText(e)); }
  }
  const t = restricted ?? live;
  const head = (
    <PageHead title="审次详情" desc={<>内容 <Id value={contentId} /> 的全部审次与事件</>}
      actions={<a className="btn sm" href="#/reviews"><Icon name="back" size={14} />返回审次列表</a>} />
  );
  if (!contentId) return <Empty>缺少内容 ID</Empty>;
  if (!t) return <>{head}<Panel><Empty>加载中…</Empty></Panel></>;

  return (
    <>
      {head}
      <Panel title="内容" sub={`接入于 ${dateTime(t.content.created_at)}`} actions={
        restricted
          ? <button className="btn sm" onClick={() => setRestricted(null)}>回到脱敏视图</button>
          : <button className="btn sm" onClick={() => void openRestricted()}>查看原文与证据（受限）</button>
      }>
        <div className="stack" style={{ gap: 16 }}>
          {error ? <Alert tone="bad">{error}</Alert> : null}
          {restricted ? <Alert tone="warn">受限视图是打开时的快照，不随后续变化刷新；回到脱敏视图恢复实时。</Alert> : null}
          <ContentHeader t={t} sim={isSim(t.content.content_id)} />
          <dl className="kv">
            <dt>账号</dt><dd className="mono">{t.content.account_id ?? "—"}</dd>
            <dt>线程</dt><dd className="mono">{t.content.thread_id ?? "—"}</dd>
            <dt>回复</dt><dd className="mono">{t.content.reply_to ?? "—"}</dd>
            <dt>审次数</dt><dd>{t.reviews.length}</dd>
          </dl>
          <Pipeline t={t} />
        </div>
      </Panel>
      <div className="split-side">
        <ReviewCards t={t} />
        <Panel title="事件流" sub="按时间倒序"><EventFeed t={t} /></Panel>
      </div>
      {restricted ? <RestrictedEvidence t={restricted} /> : null}
    </>
  );
}

const REL: Record<string, string> = { parent: "父评论", ancestor: "更早回复", reply: "回复", mentioned: "被@者发言", before: "此前", after: "此后" };

/** Thread-context text the agent saw, only in the restricted view. */
function RestrictedEvidence({ t }: { t: ContentTimeline }) {
  const rows = t.reviews.flatMap((r) => r.steps.filter((s) => s.tool === "get_thread_context" && s.result).flatMap((s) => ((s.result as { neighbors?: { relation: string; text?: string; account_id: string | null }[] }).neighbors ?? []).map((n, i) => ({ key: `${s.call_id}-${i}`, review: r.seq, ...n }))));
  if (!rows.length) return null;
  return (
    <Panel title="上下文证据全文" sub="受限" flush>
      <table className="table stackable"><thead><tr><th>审次</th><th>关系</th><th>账号</th><th>内容</th></tr></thead><tbody>
        {rows.map((x) => <tr key={x.key}><td data-label="审次">{x.review}</td><td data-label="关系" className="nowrap">{REL[x.relation] ?? x.relation}</td><td data-label="账号" className="mono">{x.account_id ?? "—"}</td><td data-label="内容" className="wrap-any">{x.text ?? ""}</td></tr>)}
      </tbody></table>
    </Panel>
  );
}
