// Submit a content and watch it go through the system live (SSE): judge scores, route, agent steps, result.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useConsole } from "../App.tsx";
import { api, errText, type ContentTimeline, type DemoSampleInfo, type ImageSampleInfo } from "../api.ts";
import { localImages } from "../images.ts";
import { useEventSource } from "../hooks.ts";
import { SCENE } from "../labels.ts";
import { ContentHeader, EventFeed, Pipeline, ReviewCards } from "../Timeline.tsx";
import { Alert, Badge, Clamp, Empty, PageHead, Panel, clock } from "../ui.tsx";

type Recent = { id: string; text: string; scene: string; at: number; image?: boolean };
type Picked = { kind: "file"; name: string; url: string; data: string; bytes: number } | { kind: "sample"; sample: ImageSampleInfo };
const KEV_NOTE = "真实识图：开源判官 Kev-4B 零训练读截图，测试集 200 张渲染截图上辱骂 AUROC 约 0.93、营销约 0.997，单卡约 28–31 张/秒（实测，见 reports/2026-10-09-kev-inference-speed.md 第 11 节）。";
const ACCEPT = ["image/png", "image/jpeg", "image/webp", "image/gif"];
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
  const [picked, setPicked] = useState<Picked | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imagesOn = config.images.enabled;
  const maxMb = config.images.max_bytes / 1024 / 1024;

  function pickFile(f: File | undefined): void {
    if (!f) return;
    if (!ACCEPT.includes(f.type)) { setError(`只接受 PNG、JPEG、WebP、GIF 图片（这个文件是 ${f.type || "未知类型"}）`); return; }
    if (f.size > config.images.max_bytes) { setError(`图片不能超过 ${maxMb} MB（这个文件 ${(f.size / 1024 / 1024).toFixed(1)} MB）`); return; }
    const r = new FileReader();
    r.onload = () => { setError(null); setPicked({ kind: "file", name: f.name, url: URL.createObjectURL(f), data: String(r.result), bytes: f.size }); };
    r.onerror = () => setError("读取图片失败");
    r.readAsDataURL(f);
  }
  const onDrop = (e: DragEvent): void => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files[0]); };
  useEffect(() => { if (initialId) setTracking(initialId); }, [initialId]);

  const { data: t, connected } = useEventSource<ContentTimeline>(tracking ? `/api/contents/${encodeURIComponent(tracking)}/stream` : null, "timeline");

  async function submit(body: { text: string; scene: string; account_id?: string; parent?: { text: string; account_id?: string }; image?: { data: string }; image_sample?: string }, localUrl?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const out = await api.post<{ content_id: string }>("/api/contents", body);
      if (localUrl) localImages.set(out.content_id, localUrl);
      const image = !!(body.image || body.image_sample);
      const next = [{ id: out.content_id, text: body.text || (image ? "（图片）" : ""), scene: body.scene, at: Date.now(), ...(image ? { image } : {}) }, ...recent.filter((r) => r.id !== out.content_id)];
      setRecent(next);
      saveRecent(next);
      setTracking(out.content_id);
      go(`/track/${encodeURIComponent(out.content_id)}`);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const onSubmit = (): void => {
    const img = picked?.kind === "file" ? { image: { data: picked.data } } : picked?.kind === "sample" ? { image_sample: picked.sample.id } : {};
    void submit({ text, scene, ...(account.trim() ? { account_id: account.trim() } : {}), ...(withParent && parentText.trim() ? { parent: { text: parentText.trim() } } : {}), ...img }, picked?.kind === "file" ? picked.url : undefined)
      .then((ok) => { if (ok) setPicked(null); });
  };
  const runImageSample = (x: ImageSampleInfo): void => {
    setScene(x.scene); setText(""); setAccount(x.account_id); setWithParent(false); setPicked(null);
    void submit({ text: "", scene: x.scene, account_id: x.account_id, image_sample: x.id });
  };
  const runSample = (s: DemoSampleInfo): void => {
    setScene(s.scene); setText(s.text); setAccount(s.account_id); setWithParent(!!s.parent); setParentText(s.parent?.text ?? "");
    void submit({ text: s.text, scene: s.scene, account_id: s.account_id, ...(s.parent ? { parent: s.parent } : {}) });
  };
  const localText = recent.find((r) => r.id === tracking)?.text ?? null;
  const lastReview = t?.reviews[t.reviews.length - 1];

  return (
    <>
      <PageHead title="提交与追踪" desc="提交的内容进入接入队列，与线上流量走同一条链路；追踪面板实时显示它经过的每一步。" />
      <div className={`split ${tracking ? "tracking" : ""}`}>
        <div className="stack" style={{ gap: 20 }}>
          <Panel title="提交内容">
            <form className="stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
              <div className="field"><span className="field-l">场景</span>
                <div className="seg" role="radiogroup" aria-label="场景">
                  {config.scenes.map((s) => <button type="button" key={s.scene} role="radio" aria-checked={scene === s.scene} className={scene === s.scene ? "on" : ""} onClick={() => setScene(s.scene)}>{SCENE[s.scene] ?? s.scene}</button>)}
                </div>
              </div>
              <label className="field"><span className="field-l">内容<span className="hint">{text.length}/2000{imagesOn ? " · 带图片时可不填" : ""}</span></span>
                <textarea className="textarea" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={imagesOn ? "输入一条评论、弹幕或昵称，也可以只传图片" : "输入一条评论、弹幕或昵称"} />
              </label>
              {imagesOn ? (
                <div className="field"><span className="field-l">图片<span className="hint">可选，PNG / JPEG / WebP / GIF，不超过 {maxMb} MB</span></span>
                  {picked ? (
                    <div className="picked">
                      <img src={picked.kind === "file" ? picked.url : picked.sample.url} alt="待提交的图片" />
                      <div className="picked-t"><b className="wrap-any">{picked.kind === "file" ? picked.name : picked.sample.title}</b>
                        <span className="small faint">{picked.kind === "file" ? `${(picked.bytes / 1024).toFixed(0)} KB · 随手上传：演示模式下判官给中间带概率` : "预置示例"}</span></div>
                      <button type="button" className="btn sm ghost" onClick={() => setPicked(null)}>移除</button>
                    </div>
                  ) : (
                    <div className={`drop ${drag ? "on" : ""}`} role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
                      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
                      <span>拖入一张图片，或<b>点此选择</b></span>
                    </div>
                  )}
                  <input ref={fileInput} type="file" accept={ACCEPT.join(",")} hidden onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} aria-label="选择图片" />
                </div>
              ) : null}
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
              <div className="row"><button className="btn primary" type="submit" disabled={busy || (!text.trim() && !picked)}>提交并追踪</button></div>
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

          {config.images.samples.length ? (
            <Panel title="图片示例" sub="评论截图，点一张直接提交">
              <div className="stack" style={{ gap: 12 }}>
                <div className="img-samples">
                  {config.images.samples.map((x) => (
                    <button key={x.id} className="img-sample" onClick={() => runImageSample(x)} disabled={busy} title={x.route}>
                      <img src={x.url} alt={x.title} loading="lazy" />
                      <span className="t">{x.title}</span>
                      <span className="r">{x.route}</span>
                    </button>
                  ))}
                </div>
                {config.images.note ? <div className="small faint">{config.images.note}。{KEV_NOTE}</div> : <div className="small faint">{KEV_NOTE}</div>}
              </div>
            </Panel>
          ) : null}

          {recent.length ? (
            <Panel title="本次会话提交" flush>
              <table className="table"><tbody>
                {recent.map((r) => (
                  <tr key={r.id} className={`click ${r.id === tracking ? "sel" : ""}`} tabIndex={0} onClick={() => { setTracking(r.id); go(`/track/${encodeURIComponent(r.id)}`); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setTracking(r.id); go(`/track/${encodeURIComponent(r.id)}`); } }}>
                    <td>{r.image ? <span className="badge" style={{ marginRight: 6 }}>图</span> : null}<Clamp text={r.text} lines={1} /></td><td className="small muted nowrap">{SCENE[r.scene] ?? r.scene}</td><td className="small faint num nowrap">{clock(r.at)}</td>
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
