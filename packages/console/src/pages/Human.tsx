// Human review desk: the queue (severity x due time), one task's evidence, claim, decision. Decisions go through the
// same submit check as everything else (core.submitRuling with actor=human); a refusal is shown with its code. In demo
// mode a simulated reviewer works on simulated tasks too; its claims and decisions are marked.
import { useEffect, useMemo, useState } from "react";
import { useConsole } from "../App.tsx";
import { api, authHeaders, errText, type Action, type ContentTimeline, type HumanQueueItem } from "../api.ts";
import { useEventSource, useNow, useOpenView } from "../hooks.ts";
import { ACTION, QUESTION, SCENE, reasonText } from "../labels.ts";
import { useLive, useLiveQuery } from "../live.tsx";
import { useFreshIds } from "../motion.tsx";
import { ContentHeader, ReviewCard } from "../Timeline.tsx";
import { ActionBadge, Alert, Badge, Empty, Id, PageHead, Panel, SimTag, ago, clock, duration, Term } from "../ui.tsx";

const RENDER_MAX = 100;
type ClaimRule = { rule_id: string; default_action: "limit" | "takedown" };

function Who({ id }: { id: string | null }) {
  const { config } = useConsole();
  if (!id) return <span className="faint">未领取</span>;
  const sim = id === config.demo_traffic?.sim_reviewer;
  return <span className="row" style={{ gap: 6, flexWrap: "nowrap" }}><span className="wrap-any">{id}</span>{sim ? <SimTag title="模拟审核员，仅处理演示程序生成的内容" /> : null}</span>;
}

export function Human({ selected }: { selected: string | null }) {
  const { go, reviewer, isSim, config } = useConsole();
  const live = useLive();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const queue = useLiveQuery<HumanQueueItem[]>(`/api/human/queue?status=${tab}`, live.frame?.versions.human);
  const now = useNow(1000);
  const all = queue.data ?? [];
  const items = all.slice(0, RENDER_MAX);   // a busy queue: the first rows only (the count is in the tab)
  const fresh = useFreshIds(queue.data?.map((x) => x.review_id) ?? null, queue.path ?? "");
  const current = all.find((x) => x.review_id === selected) ?? null;
  const [pinned, setPinned] = useState<HumanQueueItem | null>(null);
  useEffect(() => { if (current) setPinned(current); else if (!selected) setPinned(null); }, [current, selected]);
  const task = current ?? (pinned?.review_id === selected ? pinned : null);
  const select = (id: string): void => go(`/human/${encodeURIComponent(id)}`);

  async function claimNext(): Promise<void> {
    if (!reviewer) return;
    const out = await api.post<{ review: { review_id: string } | null }>("/api/human/claim", {}, authHeaders(reviewer)).catch(() => ({ review: null }));
    queue.reload();
    if (out.review) select(out.review.review_id);
  }

  return (
    <>
      <PageHead title="人工复核" desc={<>agent 无法确定或因系统原因转交人工的内容。人工裁决同样需要通过<Term k="提交校验" />。{config.demo_traffic ? <> 演示环境中有一位模拟审核员（标记为 <SimTag />）负责处理自动生成的任务。</> : null}</>} />
      <div className="split-wide">
        <Panel title="队列" sub={`${tab === "open" ? "按严重程度与时限排序" : "最近完成"}${all.length > RENDER_MAX ? `，显示前 ${RENDER_MAX} 条（共 ${all.length} 条）` : ""}`} flush actions={
          <>
            <div className="seg" role="tablist" aria-label="队列">
              <button className={tab === "open" ? "on" : ""} onClick={() => setTab("open")} role="tab" aria-selected={tab === "open"}>待处理{live.frame ? ` ${live.frame.stats.human.open}` : ""}</button>
              <button className={tab === "closed" ? "on" : ""} onClick={() => setTab("closed")} role="tab" aria-selected={tab === "closed"}>已完成</button>
            </div>
            {tab === "open" ? <button className="btn sm primary" disabled={!reviewer || items.length === 0} onClick={() => void claimNext()}>领取下一条</button> : null}
          </>
        }>
          {queue.error ? <div className="panel-b"><Alert tone="bad">{queue.error}</Alert></div> : null}
          {!queue.data ? <Empty>加载中…</Empty> : items.length === 0 ? <Empty>{tab === "open" ? "队列为空。agent 无法确定、或因系统原因转交人工的内容，将显示在这里。" : "暂无已完成的任务。"}</Empty> : (
            <div className="table-wrap">
              <table className="table stackable">
                <thead><tr><th>内容</th><th>原因</th><th>{tab === "open" ? "剩余时限" : "结论"}</th><th>{tab === "open" ? "领取" : "处理人"}</th></tr></thead>
                <tbody>
                  {items.map((x) => {
                    const left = x.due_at - now;
                    return (
                      <tr key={x.review_id} className={`click ${x.review_id === selected ? "sel" : ""} ${fresh.has(x.review_id) ? "fresh" : ""}`} tabIndex={0} onClick={() => select(x.review_id)} onKeyDown={(e) => { if (e.key === "Enter") select(x.review_id); }}>
                        <td className="lead"><div className="cell-2"><span className="row" style={{ gap: 6 }}><Id value={x.content_id} short />{isSim(x.content_id) ? <SimTag /> : null}</span>
                          <span className="s">{SCENE[x.scene] ?? x.scene} · {x.trigger === "appeal" ? "申诉审次" : `第 ${x.review_id.split("#").pop()} 审次`} · 严重程度 {x.severity}</span></div></td>
                        <td data-label="原因" className="small" style={{ minWidth: 96 }}>{reasonText(x.reason)}</td>
                        <td data-label={tab === "open" ? "剩余时限" : "结论"} className="small num nowrap">{tab === "open"
                          ? <span style={{ color: left < 0 ? "var(--bad)" : left < 600_000 ? "var(--warn)" : undefined }}>{left < 0 ? `超时 ${duration(-left)}` : duration(left)}</span>
                          : <span className="row" style={{ flexWrap: "nowrap" }}><ActionBadge action={x.action} /><span className="faint">{ago(x.closed_at ?? x.created_at, now)}</span></span>}</td>
                        <td data-label={tab === "open" ? "领取" : "处理人"} className="small"><Who id={tab === "open" ? x.claimed_by : x.closed_by} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {selected && task ? <TaskPanel key={selected} item={task} onChanged={queue.reload} /> : selected ? <Panel title="任务"><Empty>加载中…（若任务已完成，请切换到“已完成”）</Empty></Panel> : (
          <Panel title="任务"><Empty>从左侧选择一条任务，或点击“领取下一条”。{reviewer ? null : <><br />请先以审核员身份登录。</>}</Empty></Panel>
        )}
      </div>
    </>
  );
}

function TaskPanel({ item, onChanged }: { item: HumanQueueItem; onChanged: () => void }) {
  const { reviewer, config, isSim } = useConsole();
  const { data: t } = useEventSource<ContentTimeline>(`/api/contents/${encodeURIComponent(item.content_id)}/stream`, "timeline");
  const open = useOpenView(item.content_id, t?.version, reviewer, config.mode === "demo");
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
  // the live timeline knows about a claim or a decision before the queue list is re-read
  const claimedBy = review?.human?.claimed_by ?? item.claimed_by;
  const closedBy = review?.human?.closed_by ?? item.closed_by;
  const mine = !!reviewer && claimedBy === reviewer.reviewer;
  const takenByOther = !!claimedBy && !mine;
  const closed = item.closed_at !== null || !!review?.human?.closed_at || done;
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
    if (!reviewer || !window.confirm("查看原文会记录到审计日志，是否继续？")) return;
    try { setRestricted(await api.get<ContentTimeline>(`/api/contents/${encodeURIComponent(item.content_id)}?view=restricted`, { ...authHeaders(reviewer), "x-confirm": "yes" })); } catch (e) { setMsg({ tone: "bad", text: errText(e) }); }
  }
  const ruleOptions = rules ?? [];
  const usable = (a: Action): boolean => a === "pass" || ruleOptions.some((r) => r.default_action === a);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <Panel title="任务" sub={<Id value={item.review_id} />} actions={
        closed ? <Badge tone="good">已完成{closedBy ? ` · ${closedBy}` : ""}</Badge>
          : mine ? <><Badge tone="info">我已领取</Badge><button className="btn sm" onClick={() => void unclaim()}>放弃领取</button></>
          : takenByOther ? <Badge tone="warn"><Who id={claimedBy} /> 已领取</Badge>
          : <button className="btn sm primary" disabled={!reviewer || busy} onClick={() => void claim()}>领取</button>
      }>
        <div className="stack" style={{ gap: 14 }}>
          <dl className="kv">
            <dt>内容</dt><dd className="row" style={{ gap: 6 }}><Id value={item.content_id} />{isSim(item.content_id) ? <SimTag /> : null}</dd>
            <dt>转入原因</dt><dd>{reasonText(item.reason)}{item.suspect_reason ? <span className="faint">（快判：{reasonText(item.suspect_reason)}）</span> : null}</dd>
            <dt>场景</dt><dd>{SCENE[item.scene] ?? item.scene}，可用处置：{sceneActions.map((a) => ACTION[a]).join("、")}</dd>
            <dt>截止时间</dt><dd>{clock(item.due_at)}</dd>
            <dt>规则版本</dt><dd className="mono">{item.rules_ver}</dd>
          </dl>
          {t ? (restricted ?? open ? <ContentHeader t={(restricted ?? open)!} /> : (
            <div className="hidden-text">原文默认不显示（{t.content.text_len} 字）
              <button className="btn sm" onClick={() => void openRestricted()} disabled={!reviewer}>查看原文</button></div>
          )) : null}
        </div>
      </Panel>

      {!closed ? (
        <Panel title="裁决" sub="人工裁决同样需要通过提交校验">
          <div className="stack" style={{ gap: 14 }}>
            {!mine ? <Alert tone="info">{takenByOther ? "该任务已被其他审核员领取。" : "请先领取任务，再提交裁决。"}</Alert> : null}
            <div className="row" style={{ gap: 12 }}>
              <div className="seg" role="radiogroup" aria-label="处置">
                {sceneActions.map((a) => <button key={a} role="radio" aria-checked={action === a} className={action === a ? "on" : ""} disabled={!mine || !usable(a)} title={usable(a) ? undefined : "当前场景的规则不支持该处置"} onClick={() => { setAction(a); setRuleIds(a === "pass" ? [] : ruleOptions.filter((r) => r.default_action === a).map((r) => r.rule_id).slice(0, 1)); }}>{ACTION[a]}</button>)}
              </div>
              {action !== "pass" ? ruleOptions.filter((r) => r.default_action === action).map((r) => (
                <label key={r.rule_id} className="check"><input type="checkbox" checked={ruleIds.includes(r.rule_id)} onChange={(e) => setRuleIds(e.target.checked ? [...ruleIds, r.rule_id] : ruleIds.filter((x) => x !== r.rule_id))} />{QUESTION[r.rule_id] ?? r.rule_id} <span className="mono faint">{r.rule_id}</span></label>
              )) : null}
            </div>
            <label className="field"><span className="field-l">理由</span><textarea className="textarea" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="简要说明判断依据" disabled={!mine} /></label>
            {stuck ? <label className="check small"><input type="checkbox" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} disabled={!mine} />同时记为反馈标注：{stuck} → {action === "pass" ? "不违规" : "违规"}</label> : null}
            {msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}
            <div className="row"><button className="btn primary" disabled={!mine || busy || (action !== "pass" && ruleIds.length === 0)} onClick={() => void submit()}>提交裁决</button></div>
          </div>
        </Panel>
      ) : msg ? <Alert tone={msg.tone}>{msg.text}</Alert> : null}

      {review ? <ReviewCard r={review} restricted={!!restricted} {...(restricted ?? t ? { t: (restricted ?? t)! } : {})} /> : <Panel title="证据"><Empty>加载中…</Empty></Panel>}
    </div>
  );
}
