// Rules and versions (read only): the bundle G runs with, scene policy, stored versions with their review counts,
// rollouts and gate runs, calibration files, threshold proposals from human feedback.
import type { RuleInfo, RulesInfo } from "../api.ts";
import { usePoll } from "../hooks.ts";
import { ACTION, CATEGORY, QUESTION, SCENE } from "../labels.ts";
import { Alert, Badge, Empty, Kpi, PageHead, Panel, dateTime, duration } from "../ui.tsx";

function Lines({ r }: { r: RuleInfo }) {
  const row = (label: string, l: { block: number; pass: number }) => (
    <div className="ln">
      <span className="small muted">{label}</span>
      <div className="track" role="img" aria-label={`${label}：放行线 ${l.pass}，处置线 ${l.block}`}>
        <div className="rail" />
        <div className="zone pass" style={{ left: 0, width: `${l.pass * 100}%` }} />
        <div className="zone block" style={{ left: `${l.block * 100}%`, right: 0 }} />
        <div className="line" style={{ left: `${l.pass * 100}%` }} /><div className="line" style={{ left: `${l.block * 100}%` }} />
      </div>
      <span className="v">放行 &lt; {l.pass} · 处置 ≥ {l.block}</span>
    </div>
  );
  return <div className="lines">{row("快判", r.thresholds)}{r.agent_thresholds ? row("agent", r.agent_thresholds) : <div className="small faint">agent 阶段沿用快判的线</div>}</div>;
}

export function Rules() {
  const q = usePoll<RulesInfo>("/api/rules", 10_000);
  const head = <PageHead title="规则与版本" desc="规则写成问题，判官对每个问题给概率；处置按线比较校准后的概率。发布用 scripts/rules-release.ts：影子检查、闸门、灰度。" />;
  if (q.error) return <>{head}<Alert tone="bad">{q.error}</Alert></>;
  if (!q.data) return <>{head}<Panel><Empty>加载中…</Empty></Panel></>;
  const d = q.data;
  return (
    <>
      {head}
      <div className="kpis" style={{ ["--n" as string]: 3 }}>
        <Kpi label="当前规则包" value={<span className="ver">{d.current.rules_ver}</span>} foot={`${d.current.rules.length} 条规则 · ${d.current.scenes.length} 个场景`} />
        <Kpi label="校准" value={<span className="ver">{d.calibration.calib_ver}</span>} foot={d.calibration.mode === "strict" ? "strict：没有拟合的题只会判为疑似" : "identity：联调模式"} />
        <Kpi label="候选包 / 灰度" value={d.candidate ? <span className="ver">{d.candidate.rules_ver}</span> : <span className="ver">无</span>} foot={d.candidate ? `灰度 ${d.candidate.rollout_pct}%（0 即回退）` : "没有候选包"} />
      </div>

      <Panel title="规则" sub={`${d.current.rules.length} 条`} flush>
        {d.current.rules.map((r) => (
          <div key={r.rule_id} className="rule">
            <div className="stack" style={{ gap: 8 }}>
              <div className="row"><b>{QUESTION[r.rule_id] ?? r.rule_id}</b><span className="mono faint">{r.rule_id}</span><Badge>{CATEGORY[r.category] ?? r.category}</Badge><Badge>默认{ACTION[r.default_action as keyof typeof ACTION] ?? r.default_action}</Badge><Badge>严重度 {r.severity}</Badge></div>
              <div className="rule-text">{r.text}</div>
              <div className="rule-text muted">判官问题：{r.question.instructions}</div>
              <div className="chips">{Object.entries(r.question.options).map(([k, v]) => <span className="chip" key={k}>{k}：{v}</span>)}</div>
              <div className="small faint">场景：{r.scenes.map((s) => SCENE[s] ?? s).join("、")}{r.exceptions.length ? ` · 例外：${r.exceptions.join("、")}` : " · 无例外"}</div>
            </div>
            <Lines r={r} />
          </div>
        ))}
      </Panel>

      <Panel title="场景策略" flush>
        <div className="table-x">
          <table className="table">
            <thead><tr><th>场景</th><th>必须覆盖</th><th>可用处置</th><th>待审可见性</th><th className="num">agent 截止</th><th className="num">人工时限</th><th>放行需复问</th><th className="num">注入检查线</th></tr></thead>
            <tbody>{d.current.scenes.map((s) => (
              <tr key={s.scene}><td className="nowrap">{SCENE[s.scene] ?? s.scene}</td><td>{s.required_categories.map((c) => CATEGORY[c] ?? c).join("、") || "—"}</td><td>{s.allowed_actions.map((a) => ACTION[a as keyof typeof ACTION] ?? a).join("、")}</td>
                <td className="mono small">{s.pending_visibility}</td><td className="num nowrap">{duration(s.deadline_ms)}</td><td className="num nowrap">{duration(s.human_sla_ms)}</td><td>{s.confirm_pass ? "是" : "否"}</td><td className="num">{s.injection_guard ?? "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>

      <div className="grid g-2">
        <Panel title="已存规则版本" sub="审次绑定自己的版本，旧审次按旧版本继续" flush>
          <table className="table stackable"><thead><tr><th>版本</th><th>规则</th><th className="num">审次</th><th>首次载入</th></tr></thead>
            <tbody>{d.versions.map((v) => <tr key={v.rules_ver}><td className="lead"><span className="row" style={{ gap: 6 }}><span className="mono wrap-any">{v.rules_ver}</span>{v.current ? <Badge tone="good">当前</Badge> : null}</span></td><td data-label="规则" className="small">{v.rule_ids.join("、")}</td><td data-label="审次" className="num">{v.reviews}</td><td data-label="首次载入" className="small faint num nowrap">{dateTime(v.created_at)}</td></tr>)}</tbody>
          </table>
        </Panel>
        <Panel title="灰度与闸门" flush>
          {d.rollouts.length === 0 && d.gate_runs.length === 0 ? <Empty>本库没有灰度或闸门记录</Empty> : (
            <table className="table stackable"><thead><tr><th>类型</th><th>版本 / 记录</th><th className="num">比例 / 结果</th><th>时间</th></tr></thead>
              <tbody>
                {d.rollouts.map((r) => <tr key={`${r.kind}-${r.version}`}><td data-label="类型">灰度</td><td data-label="版本" className="mono wrap-any">{r.version}</td><td data-label="比例" className="num">{r.rollout_pct}%</td><td data-label="时间" className="small faint nowrap">{dateTime(r.loaded_at)}</td></tr>)}
                {d.gate_runs.map((g) => <tr key={g.gate_run_id}><td data-label="类型">闸门</td><td data-label="记录" className="mono small wrap-any">{g.gate_run_id}</td><td data-label="结果" className="num">{g.passed ? <Badge tone="good">通过</Badge> : <Badge tone="bad">未过</Badge>}</td><td data-label="时间" className="small faint nowrap">{dateTime(g.created_at)}</td></tr>)}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="grid g-2">
        <Panel title="校准文件" sub="温度缩放，按判官 × 规则版本 × 场景 × 题目分桶" flush>
          {d.calibration.files.length === 0 ? <Empty>没有校准文件</Empty> : (
            <div className="table-x">
              <table className="table"><thead><tr><th>题目</th><th>场景</th><th>规则版本</th><th className="num">T</th><th className="num">样本</th><th className="num">ECE 前→后</th></tr></thead>
                <tbody>{d.calibration.files.map((f, i) => <tr key={i}><td className="nowrap">{QUESTION[f.question] ?? f.question}</td><td className="nowrap">{SCENE[f.scene] ?? f.scene}</td><td className="mono small">{f.rules_ver}</td><td className="num">{f.T}</td><td className="num">{f.n ?? "—"}</td><td className="num small nowrap">{f.ece_before?.toFixed(3) ?? "—"} → {f.ece_after?.toFixed(3) ?? "—"}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="阈值提议" sub="由人工裁决回流生成，需影子检查与批准" flush>
          {d.proposals.length === 0 ? <Empty>还没有提议（scripts/feedback-propose.ts）</Empty> : (
            <table className="table stackable"><thead><tr><th>提议</th><th>基于</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>{d.proposals.map((p) => <tr key={p.proposal_id}><td className="lead mono small">{p.proposal_id.slice(0, 8)}</td><td data-label="基于" className="mono small wrap-any">{p.base_rules_ver}</td><td data-label="状态">{p.status}</td><td data-label="时间" className="small faint nowrap">{dateTime(p.created_at)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
