// Rules and versions (read only): the bundle G runs with, scene policy, stored versions with their review counts,
// rollouts and gate runs, calibration files, threshold proposals from human feedback.
import type { RuleInfo, RulesInfo } from "../api.ts";
import { usePoll } from "../hooks.ts";
import { ACTION, CATEGORY, QUESTION, SCENE } from "../labels.ts";
import { Alert, Card, Empty, dateTime, duration } from "../ui.tsx";

function Lines({ r }: { r: RuleInfo }) {
  const row = (label: string, l: { block: number; pass: number }) => (
    <div className="row" style={{ flexWrap: "nowrap", gap: 10 }}>
      <span className="small muted" style={{ width: 42 }}>{label}</span>
      <div className="track" style={{ flex: 1, minWidth: 140 }}>
        <div className="rail" />
        <div className="zone pass" style={{ left: 0, width: `${l.pass * 100}%` }} />
        <div className="zone block" style={{ left: `${l.block * 100}%`, right: 0 }} />
        <div className="line" style={{ left: `${l.pass * 100}%` }} /><div className="line" style={{ left: `${l.block * 100}%` }} />
      </div>
      <span className="small num nowrap">放行 &lt; {l.pass} · 处置 ≥ {l.block}</span>
    </div>
  );
  return <div className="stack" style={{ gap: 4 }}>{row("快判", r.thresholds)}{r.agent_thresholds ? row("agent", r.agent_thresholds) : <div className="small faint">agent 阶段沿用快判的线</div>}</div>;
}

export function Rules() {
  const q = usePoll<RulesInfo>("/api/rules", 10_000);
  if (q.error) return <Alert tone="bad">{q.error}</Alert>;
  if (!q.data) return <Empty>加载中…</Empty>;
  const d = q.data;
  return (
    <>
      <div className="grid cols-3">
        <div className="card stat"><div className="label">当前规则包</div><div className="value mono" style={{ fontSize: 18 }}>{d.current.rules_ver}</div><div className="foot">{d.current.rules.length} 条规则 · {d.current.scenes.length} 个场景</div></div>
        <div className="card stat"><div className="label">校准</div><div className="value mono" style={{ fontSize: 18 }}>{d.calibration.calib_ver}</div><div className="foot">模式 {d.calibration.mode === "strict" ? "strict（无拟合的题只会疑似）" : "identity（联调）"}</div></div>
        <div className="card stat"><div className="label">候选包 / 灰度</div><div className="value" style={{ fontSize: 18 }}>{d.candidate ? <span className="mono">{d.candidate.rules_ver}</span> : "无"}</div><div className="foot">{d.candidate ? `灰度 ${d.candidate.rollout_pct}%（0 即回退）` : "发布用 scripts/rules-release.ts：影子检查 → 闸门 → 灰度"}</div></div>
      </div>

      <Card title="规则" sub="规则写成问题，判官对每个问题给概率；处置按线比较校准后的概率">
        <div className="stack" style={{ gap: 18 }}>
          {d.current.rules.map((r) => (
            <div key={r.rule_id} className="grid" style={{ gridTemplateColumns: "minmax(0, 1fr) minmax(320px, 0.9fr)", gap: 20 }}>
              <div className="stack" style={{ gap: 6 }}>
                <div className="row"><b>{QUESTION[r.rule_id] ?? r.rule_id}</b><span className="mono faint">{r.rule_id}</span><span className="tag">{CATEGORY[r.category] ?? r.category}</span><span className="tag">默认{ACTION[r.default_action as keyof typeof ACTION] ?? r.default_action}</span><span className="tag">严重度 {r.severity}</span></div>
                <div className="small">{r.text}</div>
                <div className="small muted">判官问题：{r.question.instructions}</div>
                <div className="chips">{Object.entries(r.question.options).map(([k, v]) => <span className="chip" key={k} title={v}>{k}：{v}</span>)}</div>
                <div className="small faint">场景：{r.scenes.map((s) => SCENE[s] ?? s).join("、")}{r.exceptions.length ? ` · 例外：${r.exceptions.join("、")}` : " · 无例外"}</div>
              </div>
              <Lines r={r} />
            </div>
          ))}
        </div>
      </Card>

      <Card title="场景策略" tight>
        <table className="tbl">
          <thead><tr><th>场景</th><th>必须覆盖</th><th>可用处置</th><th>待审可见性</th><th>agent 截止</th><th>人工时限</th><th>放行需复问</th><th>注入检查线</th></tr></thead>
          <tbody>{d.current.scenes.map((s) => (
            <tr key={s.scene}><td>{SCENE[s.scene] ?? s.scene}</td><td>{s.required_categories.map((c) => CATEGORY[c] ?? c).join("、") || "—"}</td><td>{s.allowed_actions.map((a) => ACTION[a as keyof typeof ACTION] ?? a).join("、")}</td>
              <td className="mono small">{s.pending_visibility}</td><td className="num">{duration(s.deadline_ms)}</td><td className="num">{duration(s.human_sla_ms)}</td><td>{s.confirm_pass ? "是" : "否"}</td><td className="num">{s.injection_guard ?? "—"}</td></tr>
          ))}</tbody>
        </table>
      </Card>

      <div className="grid cols-2">
        <Card title="已存规则版本" sub="审次绑定自己的版本，旧审次按旧版本继续" tight>
          <table className="tbl"><thead><tr><th>版本</th><th>规则</th><th className="num">审次</th><th>首次载入</th></tr></thead>
            <tbody>{d.versions.map((v) => <tr key={v.rules_ver}><td><span className="mono">{v.rules_ver}</span>{v.current ? <span className="tag good" style={{ marginLeft: 6 }}>当前</span> : null}</td><td className="small">{v.rule_ids.join("、")}</td><td className="num">{v.reviews}</td><td className="small faint num">{dateTime(v.created_at)}</td></tr>)}</tbody>
          </table>
        </Card>
        <Card title="灰度与闸门" tight>
          {d.rollouts.length === 0 && d.gate_runs.length === 0 ? <Empty>本库没有灰度或闸门记录</Empty> : (
            <table className="tbl"><thead><tr><th>类型</th><th>版本 / 记录</th><th className="num">比例 / 结果</th><th>时间</th></tr></thead>
              <tbody>
                {d.rollouts.map((r) => <tr key={`${r.kind}-${r.version}`}><td>灰度</td><td className="mono">{r.version}</td><td className="num">{r.rollout_pct}%</td><td className="small faint">{dateTime(r.loaded_at)}</td></tr>)}
                {d.gate_runs.map((g) => <tr key={g.gate_run_id}><td>闸门</td><td className="mono small">{g.gate_run_id}</td><td className="num">{g.passed ? <span className="tag good">通过</span> : <span className="tag bad">未过</span>}</td><td className="small faint">{dateTime(g.created_at)}</td></tr>)}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="grid cols-2">
        <Card title="校准文件" sub="温度缩放，按判官 × 规则版本 × 场景 × 题目分桶" tight>
          {d.calibration.files.length === 0 ? <Empty>没有校准文件</Empty> : (
            <table className="tbl"><thead><tr><th>题目</th><th>场景</th><th>规则版本</th><th className="num">T</th><th className="num">样本</th><th className="num">ECE 前→后</th></tr></thead>
              <tbody>{d.calibration.files.map((f, i) => <tr key={i}><td>{QUESTION[f.question] ?? f.question}</td><td>{SCENE[f.scene] ?? f.scene}</td><td className="mono small">{f.rules_ver}</td><td className="num">{f.T}</td><td className="num">{f.n ?? "—"}</td><td className="num small">{f.ece_before?.toFixed(3) ?? "—"} → {f.ece_after?.toFixed(3) ?? "—"}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
        <Card title="阈值提议" sub="由人工裁决回流生成，需影子检查与批准" tight>
          {d.proposals.length === 0 ? <Empty>还没有提议（scripts/feedback-propose.ts）</Empty> : (
            <table className="tbl"><thead><tr><th>提议</th><th>基于</th><th>状态</th><th>时间</th></tr></thead>
              <tbody>{d.proposals.map((p) => <tr key={p.proposal_id}><td className="mono small">{p.proposal_id.slice(0, 8)}</td><td className="mono small">{p.base_rules_ver}</td><td>{p.status}</td><td className="small faint">{dateTime(p.created_at)}</td></tr>)}</tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
