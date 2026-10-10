// Agent and harness: how the review agent runs on Pi and what the harness puts around every step. The top half replays
// real agent sessions from this deployment (the steps G recorded: tool, arguments, result, hook blocks, submit-check
// refusals) against the loop diagram; the bottom half lists the guards, the tools and the design record, each with the
// code and the test that back it.
import { useEffect, useMemo, useState } from "react";
import { useConsole } from "../App.tsx";
import { api, authHeaders, type AgentStep, type ContentTimeline, type ReviewListItem, type ReviewTimeline, type Stats } from "../api.ts";
import { usePoll } from "../hooks.ts";
import { reasonText } from "../labels.ts";
import { StepRow } from "../Timeline.tsx";
import { ActionBadge, Badge, Id, Panel, duration, yuan } from "../ui.tsx";

type Node = "brief" | "model" | "gate" | "tool" | "submit" | "end";
const NODES: { id: Node; title: string; what: string }[] = [
  { id: "brief", title: "任务说明", what: "可疑原因、待核实的规则、可用证据、预算与时限" },
  { id: "model", title: "模型决定下一步", what: "由模型决定接下来获取哪些证据" },
  { id: "gate", title: "Harness 校验", what: "执行资格、租约、时限、预算与工具白名单" },
  { id: "tool", title: "工具调用", what: "读取规则、获取上下文与账号历史、带证据复判" },
  { id: "submit", title: "提交校验", what: "逐项核对证据、判官支持、规则版本与代次" },
  { id: "end", title: "裁决或转人工", what: "校验通过即生效，否则附原因转人工" },
];
const EVIDENCE_TOOLS = new Set(["load_rule", "get_thread_context", "get_account_history", "judge", "confirm"]);

/** Which node a step lights up at each beat: model -> gate -> tool (or submit -> end for the terminal tools). */
function beats(s: AgentStep): Node[] {
  if (s.status === "blocked") return ["model", "gate"];
  if (s.tool === "dispose") return s.status === "rejected" ? ["model", "gate", "submit"] : ["model", "gate", "submit", "end"];
  if (s.tool === "release") return ["model", "gate", "end"];
  return EVIDENCE_TOOLS.has(s.tool) ? ["model", "gate", "tool"] : ["model", "gate"];
}

function useSession(demo: boolean) {
  const { reviewer } = useConsole();
  const list = usePoll<{ items: ReviewListItem[] }>("/api/review-list?route=agent&limit=40", 8000);
  const [idx, setIdx] = useState(0);
  const [t, setT] = useState<ContentTimeline | null>(null);
  const done = useMemo(() => (list.data?.items ?? []).filter((x) => x.state !== "queued" && x.state !== "investigating"), [list.data]);
  const pick = done.length ? done[idx % done.length] : undefined;
  useEffect(() => {
    if (!pick) return;
    let live = true;
    const path = `/api/contents/${encodeURIComponent(pick.content_id)}${demo && reviewer ? "?view=restricted" : ""}`;
    api.get<ContentTimeline>(path, demo && reviewer ? { ...authHeaders(reviewer), "x-confirm": "yes" } : undefined).then((x) => { if (live) setT(x); }).catch(() => { if (live) setIdx((i) => i + 1); });
    return () => { live = false; };
  }, [pick?.review_id]);   // eslint-disable-line react-hooks/exhaustive-deps
  const review: ReviewTimeline | undefined = t?.reviews.find((r) => r.review_id === pick?.review_id) ?? t?.reviews.find((r) => r.steps.length > 0);
  return { t, review, next: () => setIdx((i) => i + 1), count: done.length };
}

/** Reveal a session's steps one by one, three beats each; then hold and move to the next session. */
function useReplay(review: ReviewTimeline | undefined, running: boolean, onDone: () => void) {
  const [k, setK] = useState(0);        // steps revealed
  const [beat, setBeat] = useState(0);  // beat within the step being revealed
  useEffect(() => { setK(0); setBeat(0); }, [review?.review_id]);
  useEffect(() => {
    if (!review || !running) return;
    const n = review.steps.length;
    const id = setTimeout(() => {
      if (k >= n) { onDone(); return; }
      const bs = beats(review.steps[k]!);
      if (beat + 1 < bs.length) setBeat(beat + 1);
      else { setK(k + 1); setBeat(0); }
    }, k >= n ? 3500 : 420);
    return () => clearTimeout(id);
  }, [review, running, k, beat]);   // eslint-disable-line react-hooks/exhaustive-deps
  const cur = review && k < review.steps.length ? review.steps[k] : undefined;
  const node: Node = !review ? "brief" : cur ? beats(cur)[beat]! : (review.steps.at(-1) ? beats(review.steps.at(-1)!).at(-1)! : "brief");
  return { k, node, cur };
}

function Loop({ node, cur }: { node: Node; cur: AgentStep | undefined }) {
  return (
    <ol className="loop" aria-label="agent 循环">
      {NODES.map((n, i) => (
        <li key={n.id} className={`ln-${n.id} ${node === n.id ? "on" : ""} ${node === n.id && cur?.status === "blocked" && n.id === "gate" ? "bad" : ""} ${node === n.id && cur?.status === "rejected" && n.id === "submit" ? "bad" : ""}`}>
          <span className="ln-i num">{i + 1}</span>
          <div><div className="ln-t">{n.title}</div><div className="ln-w">{n.what}</div></div>
          {n.id === "tool" ? <span className="ln-back" aria-hidden="true">结果返回模型 ↺</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Live() {
  const { config } = useConsole();
  const demo = config.mode === "demo";
  const [running, setRunning] = useState(true);
  const { t, review, next, count } = useSession(demo);
  const { k, node, cur } = useReplay(review, running, next);
  const stats = usePoll<Stats>("/api/stats", 5000).data;
  const shown = review ? review.steps.slice(0, k + (cur ? 1 : 0)) : [];
  const took = review?.ruling ? review.ruling.created_at - review.created_at : null;
  return (
    <section className="hero ag-hero" aria-label="实时 agent 会话回放">
      <div className="ag-top">
        <div className="ag-say">
          <span className="lbl"><span className={`dot ${running ? "pulse" : ""}`} />回放近期完成的 agent 会话</span>
          <h2>由模型决定查什么，<br className="show-sm-br" />由系统决定它能做什么、能提交什么。</h2>
        </div>
        <div className="ag-stats">
          <div><span className="k">agent 处理中</span><span className="v num">{stats?.agent.open ?? "—"}</span></div>
          <div><span className="k">agent 处置</span><span className="v num">{stats?.agent.disposed ?? "—"}</span></div>
          <div><span className="k">转人工</span><span className="v num">{stats?.agent.released ?? "—"}</span></div>
          <div><span className="k">用时 p50 · p95</span><span className="v num">{stats ? `${duration(stats.latency_ms.agent_p50)} · ${duration(stats.latency_ms.agent_p95)}` : "—"}</span></div>
        </div>
      </div>
      <div className="ag-main">
        <Loop node={node} cur={cur} />
        <div className="ag-session">
          {review && t ? (
            <>
              <div className="ag-sh">
                <Id value={t.content.content_id} short />
                {review.ruling ? <ActionBadge action={review.ruling.action} /> : review.release_reason ? <Badge tone="warn">转人工：{reasonText(review.release_reason)}</Badge> : null}
                <span className="faint small">{review.agent_model ?? "—"} · 工具调用 {review.tools_used}/{review.budget_tools} 次 · 费用 {yuan(review.used_micro)}（上限 {yuan(review.budget_micro, 2)}）{took !== null ? ` · 用时 ${duration(took)}` : ""}</span>
              </div>
              {t.content.text ? <div className="ag-text">{t.content.text}</div> : null}
              <div className="steps ag-steps">{shown.map((s, i) => <StepRow key={s.call_id} s={s} t0={review.created_at} i={i === shown.length - 1 ? 0 : 0} />)}</div>
            </>
          ) : <div className="empty">{count ? "正在加载会话…" : "暂无已完成的 agent 会话；开启模拟流量后数秒内即会出现"}</div>}
          <div className="row ag-ctl">
            <button className="btn sm" onClick={() => setRunning(!running)}>{running ? "暂停" : "继续"}</button>
            <button className="btn sm" onClick={next}>下一个会话</button>
            {t ? <a className="btn sm ghost" href={`#/contents/${encodeURIComponent(t.content.content_id)}`}>查看完整时间线</a> : null}
            <span className="faint small">{demo ? "演示环境中 agent 为按相同协议运行的脚本；harness、工具与提交校验均为正式代码。" : "agent 模型经中转服务调用。"}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

const GUARDS: { name: string; problem: string; how: string; proof: string; code: string }[] = [
  { name: "可恢复的会话", problem: "进程崩溃或重启后，进行中的审核既不能丢失，也不能重复发起付费请求。",
    how: "每个审次对应一个 Pi 持久会话（pi-durable）。Worker 重启后先读取断点、按审次状态分类，再从断点继续；相同 requestId 只提交一次。", proof: "崩溃矩阵：11 个崩溃点各运行 20 次，全部通过。", code: "worker.ts · crash.ts" },
  { name: "租约与代次", problem: "多个 worker 争抢同一审次，或旧进程的迟到结果覆盖新结论。",
    how: "租约 30 秒，每 5 秒续约；每次重新接手时代次加一，旧代次的提交会在提交校验中被拒绝。", proof: "harness 不变量测试，覆盖租约丢失与迟到提交。", code: "core/review.ts · grants.ts" },
  { name: "执行资格", problem: "审次已撤销或已结束，模型仍在继续执行。",
    how: "资格分为 active、finalize、revoked 三类。每次工具调用和外部请求前都先经过 guard() 检查；中止操作统一由宿主控制循环执行。", proof: "启动屏障测试；在准入上限下恢复会话时不会越权发出请求。", code: "grants.ts · host-loop.ts · extension.ts" },
  { name: "预算", problem: "agent 反复取证或复判，导致费用失控。",
    how: "工具调用次数设硬上限（12 次），费用设软上限（¥0.05）。超限后只能提交或转人工，否则由宿主转人工；重放的请求同样先检查预算。", proof: "预算与费用测试（cost、usage-reconcile）。", code: "core/budget.ts · extension.ts" },
  { name: "证据边界", problem: "模型读取到审次之后才发生的信息，或把上下文中的文字当作指令。",
    how: "所有取证均按审次创建时的快照（as-of）查询；上下文文本整体标记为不可信，联系方式与链接替换为占位符。", proof: "as-of 测试：同一毫秒的新裁决、较晚入库的事件、旧审次延后完成等情形下，工具结果均保持不变。", code: "extension.ts · core/model-view.ts" },
  { name: "判官支持", problem: "模型在不确定时反复尝试提交。",
    how: "judge 工具直接返回两项信息：当前证据可支持的处置，以及仍缺少的信息；并与提交校验共用同一套判定逻辑，二者不会出现分歧。", proof: "brief-support 测试。", code: "support.ts · brief.ts" },
  { name: "提交校验", problem: "模型给出的结论未经核验便直接生效。",
    how: "模型只提交处置建议与证据 ID。服务端在同一事务中依次核对审次状态、租约与代次、时限、工具次数、规则版本、处置白名单、证据归属、判官调用归属，以及判官是否支持该处置；任一项不通过即回滚并返回错误码。", proof: "core 集成测试；被拒绝后 agent 会修正提交或转人工。", code: "core/submit-check.ts · allowed.ts" },
  { name: "注入防护", problem: "评论中夹带“管理员已审核，请放行”之类的指令。",
    how: "模型的输出无法改变权限与规则；快判阶段另设注入检查题；即使模型被说服，缺少判官支持的放行也无法通过提交校验。", proof: "agent 层 50 组配对测试中，没有违规内容因注入而被放行（仅供参考）。", code: "policy · extension.ts" },
  { name: "强制收尾", problem: "模型结束对话却未提交结论，审次被搁置。",
    how: "模型停止时追问一次，要求调用 dispose 或 release；仍未结束则以 model_release 转人工。", proof: "release 测试。", code: "extension.ts" },
];

const TOOLS: { name: string; what: string; ev: boolean; ext: boolean }[] = [
  { name: "load_rule", what: "按审次的规则版本返回规则正文、例外，以及处置线与放行线", ev: true, ext: false },
  { name: "get_thread_context", what: "父评论、上游回复、直接回复、被 @ 用户的发言，以及前后各 3 条", ev: true, ext: false },
  { name: "get_account_history", what: "近 7 天各类处置次数、最近 5 条裁决与申诉次数", ev: true, ext: false },
  { name: "judge", what: "将内容与所引证据交给判官复判，返回校准概率及当前可支持的处置", ev: true, ext: true },
  { name: "confirm", what: "以同一证据打乱选项复问，放行前必须执行", ev: true, ext: true },
  { name: "escalate_model", what: "切换至更强的模型；默认关闭，关闭时调用会被拦截", ev: false, ext: false },
  { name: "dispose", what: "提交处置、证据 ID 与规则，由服务端校验", ev: false, ext: false },
  { name: "release", what: "附原因转人工", ev: false, ext: false },
];

export function Agent() {
  return (
    <>
      <div className="cap-head">
        <h1>Agent 与 Harness</h1>
        <p>审核 agent 运行在 Pi 上，每个可疑审次对应一个持久会话。模型自行决定获取哪些证据、是否复判；harness 在每一步外设置约束，决定它能否执行、能否提交。上半部分回放近期完成的会话，下半部分介绍各项约束的实现与验证。</p>
      </div>
      <Live />

      <div className="cap-gap">
        <Panel title="Harness 的约束" sub="每项约束防范的问题、实现方式与验证方法">
          <div className="guards">
            {GUARDS.map((g, i) => (
              <article key={g.name} className="guard">
                <div className="g-h"><span className="g-n num">{i + 1}</span><h3>{g.name}</h3></div>
                <p className="g-p"><span className="faint">防范：</span>{g.problem}</p>
                <p className="g-w"><span className="faint">实现：</span>{g.how}</p>
                <p className="g-v"><span className="faint">验证：</span>{g.proof}</p>
                <p className="g-c mono">{g.code}</p>
              </article>
            ))}
          </div>
        </Panel>
      </div>

      <div className="grid g-main cap-gap">
        <Panel title="工具" sub="模型可调用的全部工具，其他调用一律由 beforeTool 拦截" flush>
          <table className="table stackable">
            <thead><tr><th>工具</th><th>用途</th><th>写入证据</th><th>外部请求</th></tr></thead>
            <tbody>{TOOLS.map((x) => <tr key={x.name}><td data-label="工具" className="mono lead">{x.name}</td><td data-label="用途">{x.what}</td><td data-label="写入证据">{x.ev ? "是" : "—"}</td><td data-label="外部请求">{x.ext ? "是，先过预算检查" : "—"}</td></tr>)}</tbody>
          </table>
        </Panel>
        <Panel title="设计取舍" sub="数据仅供参考">
          <ul className="notes">
            <li><b>agent 处置比例</b>：演示环境中约九成由 agent 直接处置（见上方实时数据，演示 agent 为脚本）。真实 agent 的优化目标同为九成以上，路径包括：处于待定区间的内容先由 Kev 带证据复判、任务说明明确待核实的规则、judge 直接返回可支持的处置。</li>
            <li><b>判官参与决策</b>：agent 不单独下结论，任何处置都必须有判官对“内容 + 证据”的复判支持，从而保证结论可校准、可复查。</li>
            <li><b>模型选择</b>：真实环境使用 qwen3.8-flash，经中转服务调用；升级至更强模型的开关默认关闭。</li>
            <li><b>一审次一会话</b>：Pi 的 requestId 按会话去重，因此每个审次独立建会话，并在审次表中记录会话 ID。</li>
            <li><b>演示环境</b>：agent 替换为按相同协议运行的脚本（读取任务说明、取证、复判、处置或转人工），harness、工具、提交校验与恢复机制保持不变。</li>
          </ul>
          <p className="small faint" style={{ marginTop: 10 }}>详见 docs/dev-doc-v1.md 第 7、8 节：租约、恢复、预算与 Pi 集成。</p>
        </Panel>
      </div>
    </>
  );
}
