// System status: the operator-only details that used to sit on the overview — the gateway's live window metrics, the
// demo traffic generator (mix, simulated reviewer, retention) and the versions in force (rules, calibration, models).
import { useConsole } from "../App.tsx";
import type { TrafficKind, TrafficStatus } from "../api.ts";
import { useEventSource } from "../hooks.ts";
import { useLive } from "../live.tsx";
import { AnimatedNumber } from "../motion.tsx";
import { Empty, Kpi, PageHead, Panel, duration, yuan } from "../ui.tsx";

type Metrics = {
  intake_rate: number; queue_intake: number; queue_agent: number; queue_human: number; p50_fast: number; p95_fast: number; outstanding_total: number;
  replay_paused: boolean; pass_pct: number; block_pct: number; suspicious_pct: number; cost_micro_per_1k: number; release_pct: number; judge_abstain_pct: number; outbox_pending: number;
};

const KIND: Record<TrafficKind, string> = { normal: "正常", marketing: "营销", abuse: "辱骂", mild: "轻度辱骂", banter: "需看上下文", repeat: "需看账号历史", injection: "注入" };
const mb = (b: number | null | undefined): string => (b === null || b === undefined ? "—" : `${(b / 1e6).toFixed(1)} MB`);

function TrafficPanel({ t }: { t: TrafficStatus }) {
  const sum = t.generated || 1;
  const r = t.retention ?? null;
  return (
    <Panel title="模拟流量" sub={t.paused || t.per_sec === 0 ? "已暂停" : `每秒约 ${t.per_sec} 条`}>
      <div className="stack" style={{ gap: 16 }}>
        <div className="trio">
          <Kpi label="已生成" value={<AnimatedNumber value={t.generated} format={(x) => Math.round(x).toLocaleString("en-US")} />} />
          <Kpi label="模拟审核员已处理" value={<AnimatedNumber value={t.sim_reviewer.decided} format={(x) => Math.round(x).toLocaleString("en-US")} />} />
          <Kpi label="模拟申诉" value={<AnimatedNumber value={t.appeals} />} />
        </div>
        <div className="meter two">
          {(Object.keys(KIND) as TrafficKind[]).map((k) => (
            <div className="item" key={k}><span className="l">{KIND[k]}</span><span className="n">{t.by_kind[k].toLocaleString("en-US")}</span>
              <div className="track"><div className="fill" style={{ width: `${(100 * t.by_kind[k]) / sum}%` }} /></div></div>
          ))}
        </div>
        <dl className="kv">
          <dt>模拟审核员</dt><dd>{t.sim_reviewer.id}，每分钟可处理 {t.sim_reviewer.per_min} 条；处理中 {t.sim_reviewer.thinking} 条，待处理 {t.sim_reviewer.open_sim_tasks} 条</dd>
          <dt>保留</dt><dd>{r ? <>保留最近 {r.keep.toLocaleString("en-US")} 条，已清理较早的 {r.pruned.toLocaleString("en-US")} 条，累计统计不受影响。数据库 {mb(r.db_bytes)}</> : "不清理"}</dd>
        </dl>
        <div className="small faint">以上内容由演示程序按设定比例自动生成，ID 以 sim- 开头。模拟审核员仅处理这些内容，不处理手动提交的内容。</div>
      </div>
    </Panel>
  );
}

export function System() {
  const { config } = useConsole();
  const live = useLive();
  const { data: m, connected } = useEventSource<Metrics>("/api/metrics");
  return (
    <>
      <PageHead title="系统状态" desc="供运维查看的细节：网关实时指标、当前生效的版本，以及演示环境的模拟流量。" />
      <div className="grid g-2 align-start">
        <div className="stack" style={{ gap: 16 }}>
          <Panel title="网关实时指标" sub={connected ? "每秒更新" : "未连接"}>
            {!m ? <Empty>等待数据…</Empty> : (
              <dl className="kv">
                <dt>接入速率</dt><dd className="num">{m.intake_rate.toFixed(2)} 条/秒</dd>
                <dt>队列：接入 / agent / 人工</dt><dd className="num">{m.queue_intake} / {m.queue_agent} / {m.queue_human}</dd>
                <dt>快判 p50 / p95</dt><dd className="num nowrap">{duration(m.p50_fast)} / {duration(m.p95_fast)}</dd>
                <dt>未完成</dt><dd className="num">{m.outstanding_total}{m.replay_paused ? "（积压过多，已暂停接收）" : ""}</dd>
                <dt>近 1 分钟：放行 / 处置 / 存疑</dt><dd className="num">{m.pass_pct}% / {m.block_pct}% / {m.suspicious_pct}%</dd>
                <dt>每千条费用</dt><dd className="num">{yuan(m.cost_micro_per_1k, 3)}</dd>
                <dt>近 5 分钟转人工占比</dt><dd className="num">{m.release_pct}%</dd>
                <dt>判官弃答率 · 待投递</dt><dd className="num">{m.judge_abstain_pct}% · {m.outbox_pending}</dd>
              </dl>
            )}
          </Panel>
          <Panel title="当前版本">
            <dl className="kv">
              <dt>规则</dt><dd className="mono wrap-any">{config.rules_ver}</dd>
              <dt>校准（{config.calib_mode}）</dt><dd className="mono wrap-any">{config.calib_ver}</dd>
              <dt>价格表</dt><dd className="mono wrap-any">{config.prices_ver}</dd>
              <dt>判官</dt><dd className="mono wrap-any">{config.judge_model}</dd>
              <dt>agent 模型</dt><dd className="mono wrap-any">{config.agent_model ?? "—"}</dd>
              <dt>运行模式</dt><dd>{config.mode === "demo" ? "演示环境" : "正式环境"}</dd>
            </dl>
          </Panel>
        </div>
        {live.frame?.traffic ? <TrafficPanel t={live.frame.traffic} /> : <Panel title="模拟流量"><Empty>当前环境没有模拟流量</Empty></Panel>}
      </div>
    </>
  );
}
