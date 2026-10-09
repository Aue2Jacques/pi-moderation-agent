// Human review desk: the queue (severity x due time), one task's evidence, claim, decision. Decisions go through the
// same submit check as everything else (core.submitRuling with actor=human); a refusal is shown with its code.
import { useEffect, useMemo, useState } from "react";
import { useConsole } from "../App.tsx";
import { api, authHeaders, errText, type Action, type ContentTimeline, type HumanQueueItem } from "../api.ts";
import { useEventSource, useNow } from "../hooks.ts";
import { useLive, useLiveQuery } from "../live.tsx";
import { ACTION, QUESTION, SCENE, reasonText } from "../labels.ts";
import { ContentHeader, ReviewCard } from "../Timeline.tsx";
import { ActionTag, Alert, Card, Empty, Icon, ago, clock, duration, shortId } from "../ui.tsx";

type ClaimRule = { rule_id: string; default_action: "limit" | "takedown" };

export function Human({ selected }: { selected: string | null }) {
  const { go, reviewer } = useConsole();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const live = useLive();
  const queue = useLiveQuery<HumanQueueItem[]>(`/api/human/queue?status=${tab}`, live.frame?.versions.human);
  const now = useNow(1000);
  const items = queue.data ?? [];
  const current = items.find((x) => x.review_id === selected) ?? null;
  const [pinned, setPinned] = useState<HumanQueueItem | null>(null);
  useEffect(() => { if (current) setPinned(current); else if (!selected) setPinned(null); }, [current, selected]);
  const task = current ?? (pinned?.review_id === selected ? pinned : null);

  async function claimNext(): Promise<void> {
    if (!reviewer) return;
    const out = await api.post<{ review: { review_id: string } | null }>("/api/human/claim", {}, authHeaders(reviewer)).catch(() => ({ review: null }));
    queue.reload();
    if (out.review) go(`/human/${encodeURIComponent(out.review.review_id)}`);
  }

  return (
    <div className="split wide-left" style={{ gridTemplateColumns: "minmax(420px, 0.9fr) minmax(0, 1.3fr)" }}>
      <Card title="人工队列" sub="按严重度和时限排序" tight right={
        <>
          <div className="seg" role="tablist">
            <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")} role="tab" aria-selected={tab === "open"}>待处理</button>
            <button className={tab === "closed" ? "on" : ""} onClick={() => setTab("closed")} role="tab" aria-selected={tab === "closed"}>已完成</button>
          </div>
          {tab === "open" ? <button className="btn sm primary" disabled={!reviewer || items.length === 0} onClick={() => void claimNext()}>领取下一条</button> : null}
        </>
      }>
        {queue.error ? <div className="card-b"><Alert tone="bad">{queue.error}</Alert></div> : null}
        {!queue.data ? <Empty>加载中…</Empty> : items.length === 0 ? <Empty>{tab === "open" ? "队列是空的。agent 拿不准、或因系统原因转人工的内容，会出现在这里。" : "还没有完成的任务。"}</Empty> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>内容</th><th>场景</th><th>原因</th><th>{tab === "open" ? "剩余时限" : "完成"}</th><th>领取</th></tr></thead>
              <tbody>
                {items.map((x) => {
                  const left = x.due_at - now;
                  return (
                    <tr key={x.review_id} className={`click ${x.review_id === selected ? "sel" : ""}`} onClick={() => go(`/human/${encodeURIComponent(x.review_id)}`)}>
                      <td><div className="mono" title={x.review_id}>{shortId(x.content_id)}</div><div className="small faint">{x.trigger === "appeal" ? "申诉审次" : `第 ${x.review_id.split("#").pop()} 审次`} · 严重度 {x.severity}</div></td>
                      <td>{SCENE[x.scene] ?? x.scene}</td>
                      <td className="small">{reasonText(x.reason)}</td>
                      <td className="small num">{tab === "open" ? <span style={{ color: left < 0 ? "var(--bad)" : left < 600_000 ? "var(--warn)" : undefined }}>{left < 0 ? `超时 ${duration(-left)}` : duration(left)}</span> : <span className="row"><ActionTag action={x.action} /><span className="faint">{ago(x.closed_at ?? x.created_at, now)}</span></span>}</td>
                      <td className="small">{x.claimed_by ?? <span className="faint">未领取</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {selected && task ? <TaskPanel key={selected} item={task} onChanged={queue.reload} /> : selected ? <Card title="任务"><Empty>加载中…（如果任务已完成，请切到“已完成”）</Empty></Card> : (
        <Card title="任务"><Empty>从左侧选择一条任务，或点“领取下一条”。<br />{reviewer ? null : "需要先登录审核员身份。"}</Empty></Card>
      )}
    </div>
  );
}

function TaskPanel({ item, onChanged }: { item: HumanQueueItem; onChanged: () => void }) {
  const { reviewer, config } = useConsole();
  const { data: t } = useEventSource<ContentTimeline>(`/api/contents/${encodeURIComponent(item.content_id)}/stream`, "timeline");
  const [rules, setRules] = useState<ClaimRule[] | null>(null);
  const [action, setAction] = useState<Action>("pass");
  const [ruleIds, setRuleIds] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState(true);
  const [msg, setMsg] = useState<{ tone: "bad" | "good"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [restricted, setRestricted] = useState<ContentTimeline | null>(null);
  const [done, setDone] = useState(false);

  const review = t?.reviews.find((r) => r.review_id === item.review_id) ?? null;
  const mine = !!reviewer && item.claimed_by === reviewer.reviewer;
  const takenByOther = !!item.claimed_by && !mine;
  const closed = item.closed_at !== null || done;
  const sceneActions = (config.scenes.find((s) => s.scene === item.scene)?.allowed_actions ?? ["pass", "limit", "takedown"]) as Action[];
  // the rule the machine was least sure about: its id goes into the feedback label (stage ③ feedback loop)
  const stuck = useMemo(() => {
    const qs = review?.judge_rounds.flatMap((j) => j.questions.filter((q) => q.kind === "rule")) ?? [];
    return qs.sort((a, b) => Math.abs((a.mean ?? 0) - 0.5) - Math.abs((b.mean ?? 0) - 0.5))[0]?.rule_id ?? null;
  }, [review]);

  async function claim(): Promise<void> {
    if (!reviewer) return;
    setBusy(true); setMsg(null);
    try {
      const out = await api.post<{ rules: ClaimRule[] }>("/api/human/claim", { review_id: item.review_id }, authHeaders(reviewer));
      setRules(out.rules);
      onChanged();
    } catch (e) { setMsg({ tone: "bad", text: errText(e) }); } finally { setBusy(false); }
  }
  async function unclaim(): Promise<void> {
    if (!reviewer) return;
    try { await api.post("/api/human/unclaim", { review_id: item.review_id }, authHeaders(reviewer)); setRules(null); onChanged(); } catch (e) { setMsg({ tone: "bad", text: errText(e) }); }
  }
  // a task already mine (claimed earlier): claiming again is idempotent and returns its pinned rules
  useEffect(() => { if (mine && !rules && !closed) void claim(); }, [mine]);

  async function submit(): Promise<void> {
    if (!reviewer) return;
    setBusy(true); setMsg(null);
    try {
      const body: Record<string, unknown> = { review_id: item.review_id, action, rule_ids: action === "pass" ? [] : ruleIds, reason };
      if (feedback && stuck) Object.assign(body, { rule_id: stuck, label: action === "pass" ? "none" : "violate" });
      await api.post("/api/human/submit", body, authHeaders(reviewer));
      setMsg({ tone: "good", text: `已提交：${ACTION[action]}` });
      setDone(true);
      onChanged();
    } catch (e) { setMsg({ tone: "bad", text: errText(e) }); } finally { setBusy(false); }
  }
  async function openRestricted(): Promise<void> {
    if (!reviewer || !window.confirm("查看原文属于受限操作，会写入审计日志。继续？")) return;
    try { setRestricted(await api.get<ContentTimeline>(`/api/contents/${encodeURIComponent(item.content_id)}?view=restricted`, { ...authHeaders(reviewer), "x-confirm": "yes" })); } catch (e) { setMsg({ tone: "bad", text: errText(e) }); }
  }
  const ruleOptions = rules ?? [];
  const usable = (a: Action): boolean => a === "pass" || ruleOptions.some((r) => r.default_action === a);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card title="任务" sub={<span className="mono">{item.review_id}</span>} right={
        closed ? <span className="tag good"><Icon name="check" size={12} />已完成</span>
          : mine ? <><span className="tag info">我已领取</span><button className="btn sm" onClick={() => void unclaim()}>放弃领取</button></>
          : takenByOther ? <span className="tag warn">{item.claimed_by} 已领取</span>
          : <button className="btn sm primary" disabled={!reviewer || busy} onClick={() => void claim()}>领取</button>
      }>
        <div className="stack">
          <dl className="kv-grid">
            <dt>转入原因</dt><dd>{reasonText(item.reason)}{item.suspect_reason ? <span className="faint">（快判：{reasonText(item.suspect_reason)}）</span> : null}</dd>
            <dt>场景</dt><dd>{SCENE[item.scene] ?? item.scene} · 可用处置 {sceneActions.map((a) => ACTION[a]).join("、")}</dd>
            <dt>时限</dt><dd>{clock(item.due_at)} 前</dd>
            <dt>规则版本</dt><dd className="mono">{item.rules_ver}</dd>
          </dl>
          {t ? (restricted ? <ContentHeader t={restricted} /> : (
            <div className="row small faint"><Icon name="lock" size={12} />原文默认隐藏（{t.content.text_len} 字）
              <button className="btn sm" onClick={() => void openRestricted()} disabled={!reviewer}><Icon name="eye" size={13} />查看原文（受限）</button></div>
          )) : null}
        </div>
      </Card>

      {!closed ? (
        <Card title="裁决" sub="人工裁决同样过提交检查">
          <div className="stack">
            {!mine ? <Alert tone="info">{takenByOther ? "这条任务已被其他审核员领取。" : "先领取任务，再提交裁决。"}</Alert> : null}
            <div className="row">
              <div className="seg" role="radiogroup" aria-label="处置">
                {sceneActions.map((a) => <button key={a} role="radio" aria-checked={action === a} className={action === a ? "on" : ""} disabled={!mine || !usable(a)} title={usable(a) ? undefined : "本场景的规则不支持这个处置"} onClick={() => { setAction(a); setRuleIds(a === "pass" ? [] : ruleOptions.filter((r) => r.default_action === a).map((r) => r.rule_id).slice(0, 1)); }}>{ACTION[a]}</button>)}
              </div>
              {action !== "pass" ? ruleOptions.filter((r) => r.default_action === action).map((r) => (
                <label key={r.rule_id} className="check"><input type="checkbox" checked={ruleIds.includes(r.rule_id)} onChange={(e) => setRuleIds(e.target.checked ? [...ruleIds, r.rule_id] : ruleIds.filter((x) => x !== r.rule_id))} />{QUESTION[r.rule_id] ?? r.rule_id} <span className="mono faint">{r.rule_id}</span></label>
              )) : null}
            </div>
            <label className="field">理由<textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="简要说明判断依据（受限内容，不进脱敏视图）" disabled={!mine} /></label>
            {stuck ? <label className="check small"><input type="checkbox" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} disabled={!mine} />写入回流标注：{stuck} → {action === "pass" ? "不违规" : "违规"}</label> : null}
            {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
            <div className="row"><button className="btn primary" disabled={!mine || busy || (action !== "pass" && ruleIds.length === 0)} onClick={() => void submit()}>提交裁决</button></div>
          </div>
        </Card>
      ) : msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}

      {review ? <ReviewCard r={review} restricted={!!restricted} /> : <Card title="证据"><Empty>加载中…</Empty></Card>}
    </div>
  );
}
