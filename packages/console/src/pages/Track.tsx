// Submit a content and watch it go through the system live (SSE): judge scores, route, agent steps, result.
import { useEffect, useState } from "react";
import { useConsole } from "../App.tsx";
import { api, errText, type ContentTimeline, type DemoSampleInfo } from "../api.ts";
import { useEventSource } from "../hooks.ts";
import { SCENE } from "../labels.ts";
import { ContentHeader, EventFeed, Pipeline, ReviewCards } from "../Timeline.tsx";
import { Alert, Badge, Clamp, Empty, PageHead, Panel, clock } from "../ui.tsx";

type Recent = { id: string; text: string; scene: string; at: number };
const RECENT_KEY = "console.recent";
const loadRecent = (): Recent[] => { try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) ?? "[]") as Recent[]; } catch { return []; } };
const saveRecent = (xs: Recent[]): void => { try { sessionStorage.setItem(RECENT_KEY, JSON.stringify(xs.slice(0, 20))); } catch { /* not kept */ } };

export function Track({ initialId }: { initialId: string | null }) {
  const { config, go, isSim } = useConsole();
  const [scene, setScene] = useState(config.scenes[0]?.scene ?? "comment");
  const [text, setText] = useState("");
  const [withParent, setWithParent] = useState(false);
  const [parentText, setParentText] = useState("");
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [tracking, setTracking] = useState<string | null>(initialId);
  useEffect(() => { if (initialId) setTracking(initialId); }, [initialId]);

  const { data: t, connected } = useEventSource<ContentTimeline>(tracking ? `/api/contents/${encodeURIComponent(tracking)}/stream` : null, "timeline");

  async function submit(body: { text: string; scene: string; account_id?: string; parent?: { text: string; account_id?: string } }): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post<{ content_id: string }>("/api/contents", body);
      const next = [{ id: out.content_id, text: body.text, scene: body.scene, at: Date.now() }, ...recent.filter((r) => r.id !== out.content_id)];
      setRecent(next);
      saveRecent(next);
      setTracking(out.content_id);
      go(`/track/${encodeURIComponent(out.content_id)}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (): void => {
    void submit({ text, scene, ...(account.trim() ? { account_id: account.trim() } : {}), ...(withParent && parentText.trim() ? { parent: { text: parentText.trim() } } : {}) });
  };
  const runSample = (s: DemoSampleInfo): void => {
    setScene(s.scene); setText(s.text); setAccount(s.account_id); setWithParent(!!s.parent); setParentText(s.parent?.text ?? "");
    void submit({ text: s.text, scene: s.scene, account_id: s.account_id, ...(s.parent ? { parent: s.parent } : {}) });
  };
  const localText = recent.find((r) => r.id === tracking)?.text ?? null;
  const lastReview = t?.reviews[t.reviews.length - 1];

  return (
    <>
      <PageHead title="提交与追踪" desc="提交的内容进入接入队列，与线上流量走同一条链路；右侧实时显示它经过的每一步。" />
      <div className="split">
        <div className="stack" style={{ gap: 20 }}>
          <Panel title="提交内容">
            <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
              <div className="field"><span className="field-l">场景</span>
                <div className="seg" role="radiogroup" aria-label="场景">
                  {config.scenes.map((s) => <button type="button" key={s.scene} role="radio" aria-checked={scene === s.scene} className={scene === s.scene ? "on" : ""} onClick={() => setScene(s.scene)}>{SCENE[s.scene] ?? s.scene}</button>)}
                </div>
              </div>
              <label className="field"><span className="field-l">内容<span className="hint">{text.length}/2000</span></span>
                <textarea className="textarea" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="输入一条评论、弹幕或昵称" />
              </label>
              <label className="check"><input type="checkbox" checked={withParent} onChange={(e) => setWithParent(e.target.checked)} />这是一条回复（附父评论作为上下文）</label>
              {withParent ? (
                <label className="field"><span className="field-l">父评论</span>
                  <textarea className="textarea" rows={2} maxLength={2000} value={parentText} onChange={(e) => setParentText(e.target.value)} placeholder="被回复的那条内容" />
                </label>
              ) : null}
              <label className="field"><span className="field-l">账号 ID<span className="hint">可选，agent 会查这个账号的历史</span></span>
                <input className="input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="例如 u_viewer" />
              </label>
              {error ? <Alert tone="bad">{error}</Alert> : null}
              <div className="row"><button className="btn primary" type="submit" disabled={busy || !text.trim()}>提交并追踪</button></div>
            </form>
          </Panel>

          {config.samples.length ? (
            <Panel title="演示示例" sub="点一条直接提交" flush>
              <div className="samples">
                {config.samples.map((s) => (
                  <button key={s.id} className="sample" onClick={() => runSample(s)} disabled={busy}>
                    <span className="t">{s.title}<Badge>{SCENE[s.scene] ?? s.scene}</Badge></span>
                    <span className="x">“{s.text}”{s.parent ? <span className="faint">　回复 “{s.parent.text}”</span> : null}</span>
                    <span className="r">{s.route}</span>
                  </button>
                ))}
              </div>
            </Panel>
          ) : null}

          {recent.length ? (
            <Panel title="本次会话提交" flush>
              <table className="table"><tbody>
                {recent.map((r) => (
                  <tr key={r.id} className={`click ${r.id === tracking ? "sel" : ""}`} tabIndex={0} onClick={() => { setTracking(r.id); go(`/track/${encodeURIComponent(r.id)}`); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setTracking(r.id); go(`/track/${encodeURIComponent(r.id)}`); } }}>
                    <td><Clamp text={r.text} lines={1} /></td><td className="small muted nowrap">{SCENE[r.scene] ?? r.scene}</td><td className="small faint num nowrap">{clock(r.at)}</td>
                  </tr>
                ))}
              </tbody></table>
            </Panel>
          ) : null}
        </div>

        <div className="stack" style={{ gap: 20 }}>
          {!tracking ? (
            <Panel title="实时追踪"><Empty>提交一条内容，或点左侧示例，这里会实时显示它的审核过程。</Empty></Panel>
          ) : !t ? (
            <Panel title="实时追踪"><Empty>连接中…</Empty></Panel>
          ) : (
            <>
              <Panel title="实时追踪" sub={connected ? "实时推送中" : "连接已断开，重连中"} actions={
                <>
                  {t.phase === "human" && lastReview ? <a className="btn sm" href={`#/human/${encodeURIComponent(lastReview.review_id)}`}>去人工复核</a> : null}
                  {t.phase === "done" ? <a className="btn sm" href={`#/appeals/${encodeURIComponent(t.content.content_id)}`}>发起申诉</a> : null}
                  <a className="btn sm" href={`#/contents/${encodeURIComponent(t.content.content_id)}`}>详情</a>
                </>
              }>
                <div className="stack" style={{ gap: 18 }}>
                  <ContentHeader t={t} text={localText} sim={isSim(t.content.content_id)} />
                  <Pipeline t={t} />
                </div>
              </Panel>
              <ReviewCards t={t} />
              <Panel title="事件流" sub="按时间倒序"><EventFeed t={t} /></Panel>
            </>
          )}
        </div>
      </div>
    </>
  );
}
