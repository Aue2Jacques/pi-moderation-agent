// Capacity page simulation (frontend only, no backend): one platform day compressed into a few minutes, on the
// company's own GPU pool. Every card is always working — as a judge, or on offline work (training, clustering, OCR,
// rule rescans, other teams' batch jobs). Ahead of a predicted peak and on load, the scheduler preempts offline cards
// (cheapest to stop first) and turns them into judges; when traffic falls it hands them back. The switch costs are the
// ones measured on the 5060 Ti (python/kevfast/switch_bench.py); traffic shape, peak, pool size and job sizes are
// assumptions. The plan for building it is docs/gpu-scheduling-plan-2026-10-09.md.

/** platform peak inflow (contents a second) the simulation is scaled to */
export const PEAK = 300;
/** one judge GPU, contents a second: double confirmation on (estimate), off (measured: kevfast HTTP, fp8, 5060 Ti) */
export const CAP_NORMAL = 32;
export const CAP_FAST = 50;
export const CARDS = 12;
/** the LLM agent's concurrency budget, reviews a second */
export const AGENT_CAP = 30;
/** share of judged contents that go to the LLM agent: without / with the "Kev with evidence" tier in between */
export const AGENT_SHARE = 0.15;
export const AGENT_SHARE_EVIDENCE = 0.05;
/** latency target: published to reviewed, p95 (seconds) */
export const SLO_S = 3;
/** a card that changed role keeps it at least this long (minutes), so the pool does not flap */
export const MIN_HOLD = 15;

/** Switch steps, seconds, measured on the 5060 Ti (switch_bench, page cache warm) unless marked estimate. */
export const SWITCH = {
  pauseInfer: { s: 0.5, measured: true, label: "推理任务在当前批次结束后暂停（每批约 0.5 秒）" },
  pauseTrain: { s: 6, measured: true, label: "训练在当前优化步结束后暂停（每步约 6 秒）" },
  savePoint: { s: 1.6, measured: true, label: "保存断点：LoRA 与优化器状态，共 620 MB" },
  free: { s: 0.7, measured: true, label: "进程退出并释放显存" },
  judgeLoad: { s: 16.6, measured: true, label: "启动判官：加载模型并转换为 FP8" },
  judgeWarm: { s: 12.0, measured: true, label: "首个请求时录制 CUDA graphs" },
  drain: { s: 0.5, measured: false, label: "判官停止接收新请求，处理完在途请求" },
  jobLoad: { s: 20, measured: false, label: "离线任务启动并读取断点" },
};
export type SwitchKind = "infer_to_judge" | "train_to_judge" | "judge_to_offline";
export const SWITCH_STEPS: Record<SwitchKind, (keyof typeof SWITCH)[]> = {
  infer_to_judge: ["pauseInfer", "free", "judgeLoad", "judgeWarm"],
  train_to_judge: ["pauseTrain", "savePoint", "free", "judgeLoad", "judgeWarm"],
  judge_to_offline: ["drain", "free", "jobLoad"],
};
export const switchSeconds = (k: SwitchKind): number => SWITCH_STEPS[k].reduce((a, s) => a + SWITCH[s].s, 0);

export const SIM_FACTS: { k: string; v: string; measured: boolean }[] = [
  { k: "单卡吞吐（关闭复问，FP8）", v: `${CAP_FAST} 条/秒`, measured: true },
  { k: "单卡吞吐（开启复问）", v: `约 ${CAP_NORMAL} 条/秒`, measured: false },
  { k: "推理任务切换为判官", v: `约 ${Math.round(switchSeconds("infer_to_judge"))} 秒`, measured: true },
  { k: "训练切换为判官（含保存断点）", v: `约 ${Math.round(switchSeconds("train_to_judge"))} 秒`, measured: true },
  { k: "判官显存 / 训练峰值显存", v: "6.3 GB / 12.3 GB", measured: true },
  { k: "回归评测 3,002 条（单卡）", v: "约 6 分钟", measured: true },
  { k: "Kev 训练一版（单卡）", v: "约 2.7 小时", measured: true },
  { k: "卡池规模、平台峰值、日流量曲线与任务量", v: `${CARDS} 张 · ${PEAK} 条/秒`, measured: false },
];

/** demand multiplier by hour (0..23), relative to PEAK; interpolated in between */
const SHAPE = [0.35, 0.22, 0.14, 0.1, 0.08, 0.1, 0.2, 0.45, 0.78, 0.62, 0.5, 0.6, 0.9, 0.74, 0.5, 0.48, 0.55, 0.7, 0.86, 0.9, 0.95, 1.0, 0.84, 0.6];
export function planned(minute: number): number {
  const h = ((minute % 1440) + 1440) % 1440 / 60;
  const i = Math.floor(h), f = h - i;
  return PEAK * (SHAPE[i]! * (1 - f) + SHAPE[(i + 1) % 24]! * f);
}
export function phaseOf(minute: number): string {
  const h = Math.floor(((minute % 1440) + 1440) % 1440 / 60);
  if (h >= 7 && h < 10) return "早高峰";
  if (h >= 11 && h < 14) return "午间高峰";
  if (h >= 17 && h < 19) return "晚高峰";
  if (h >= 19 && h < 23) return "晚间高位";
  if (h >= 1 && h < 6) return "深夜低谷";
  return "平峰";
}

export type JobKind = "eval" | "rescan" | "ocr" | "cluster" | "trust" | "train" | "batch";
export const JOB_INFO: Record<JobKind, { label: string; short: string; train: boolean; maxCards: number; measured: boolean }> = {
  eval: { label: "回归评测：测试集 3,002 条", short: "评测", train: false, maxCards: 1, measured: true },
  rescan: { label: "规则回扫：近 7 天内容", short: "回扫", train: false, maxCards: 4, measured: false },
  ocr: { label: "图片文字识别与语音转写", short: "OCR", train: false, maxCards: 4, measured: false },
  cluster: { label: "评论向量聚类：识别水军与引流团伙", short: "聚类", train: false, maxCards: 3, measured: false },
  trust: { label: "账号信誉分重算", short: "信誉", train: false, maxCards: 2, measured: false },
  train: { label: "Kev 增量训练：使用当天的 agent 与人工结论", short: "训练", train: true, maxCards: 1, measured: true },
  batch: { label: "其他团队的批处理任务", short: "批处理", train: false, maxCards: CARDS, measured: false },
};
/** preemption order: the cheapest to stop first; training last (it has to save a resume point) */
const PREEMPT: JobKind[] = ["batch", "ocr", "rescan", "cluster", "trust", "eval", "train"];
/** which job a freed card picks: the platform's own work first, by priority; then other teams' batch work */
const PICK: JobKind[] = ["eval", "train", "cluster", "trust", "rescan", "ocr", "batch"];
export type Job = { kind: JobKind; need: number; done: number };
const JOBS = (done = false): Job[] => ([["eval", 6], ["train", 160], ["cluster", 120], ["trust", 60], ["rescan", 180], ["ocr", 300]] as [JobKind, number][])
  .map(([kind, need]) => ({ kind, need, done: done ? need : 0 }));

export type Role = "judge" | "offline" | "switching" | "failed";
export type Card = { id: number; role: Role; job: JobKind | null; toward: "judge" | "offline" | null; since: number; util: number; batch: number; mixed: boolean; downFor: number };
export type Level = 0 | 1 | 2 | 3;
export const LEVELS: { level: Level; name: string; what: string; cost: string }[] = [
  { level: 0, name: "正常", what: "开启复问，所有内容先审后发", cost: "—" },
  { level: 1, name: "关闭复问", what: "单卡吞吐提升约 1.5 倍（32 → 50 条/秒）", cost: "违规漏放率由 1.5% 升至 2.1%（测算）" },
  { level: 2, name: "先限流、后补审", what: "agent 来不及处理的可疑内容先限流（仅作者可见），低峰时补审", cost: "可疑内容的可见时间推迟" },
  { level: 3, name: "低风险先发后审", what: "信誉良好的账号与低风险场景先发布，低峰时补审", cost: "少量违规内容短时可见" },
];
export type Point = { t: number; demand: number; cap: number; judges: number; offline: number; fastS: number; doneS: number; level: Level };
export type SimEvent = { t: number; text: string; tone: "info" | "warn" | "bad" | "good" };
export type Flags = { predict: boolean; degrade: boolean; evidence: boolean };
export type LastSwitch = { t: number; card: number; kind: SwitchKind; job: JobKind | null };
export type Sim = {
  t: number; cards: Card[]; level: Level; calm: number; q: number; agentQ: number; deferred: number; backfilled: number;
  jobs: Job[]; batchDone: number; history: Point[]; events: SimEvent[]; spikeUntil: number; spikeFrom: number; minutes: number;
  lastRelease: number; switches: number; lastSwitch: LastSwitch | null; flags: Flags; demand: number; fastS: number; agentS: number; doneS: number;
  agentShare: number; poolUtil: number; seed: number;
};

export const START_MIN = 6 * 60;

export function newSim(flags: Flags = { predict: true, degrade: true, evidence: true }): Sim {
  const cards: Card[] = Array.from({ length: CARDS }, (_, i) => ({ id: i + 1, role: i < 3 ? "judge" : "offline", job: i < 3 ? null : "batch", toward: null, since: START_MIN - 60, util: 0, batch: 0, mixed: false, downFor: 0 }));
  return { t: START_MIN, cards, level: 0, calm: 0, q: 0, agentQ: 0, deferred: 0, backfilled: 0, jobs: JOBS(true), batchDone: 0, history: [],
    events: [{ t: START_MIN, text: "06:00：3 张卡运行判官，其余 9 张执行离线任务（昨晚的平台任务已完成，当前为其他团队的批处理）", tone: "info" }],
    spikeUntil: -1, spikeFrom: -1, minutes: 0, lastRelease: -999, switches: 0, lastSwitch: null, flags, demand: 0, fastS: 0.05, agentS: 2.5, doneS: 0.4,
    agentShare: AGENT_SHARE_EVIDENCE, poolUtil: 0, seed: 7 };
}

function rand(s: Sim): number {
  s.seed = (s.seed * 1103515245 + 12345) & 0x7fffffff;
  return s.seed / 0x7fffffff;
}
export const simClock = (m: number): string => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;
function log(s: Sim, text: string, tone: SimEvent["tone"] = "info"): void {
  s.events.unshift({ t: s.t, text, tone });
  if (s.events.length > 80) s.events.length = 80;
}

/** a hot topic: 2.2x the planned inflow for 25 minutes (not predicted) */
export function spike(s: Sim): void {
  s.spikeFrom = s.t; s.spikeUntil = s.t + 25;
  log(s, "突发热点：流量在 3 分钟内升至计划值的 2.2 倍，预测未覆盖", "warn");
}
/** fail one judge card: health checks remove it, its share moves to the others, the scheduler backfills from offline */
export function failCard(s: Sim): void {
  const judges = s.cards.filter((c) => c.role === "judge");
  if (judges.length <= 1) return;
  const c = judges[Math.floor(rand(s) * judges.length)]!;
  c.role = "failed"; c.job = null; c.downFor = 0; c.util = 0; c.batch = 0; c.mixed = false;
  log(s, `GPU ${c.id} 健康检查失败，已移出路由，流量由其余 ${judges.length - 1} 张判官卡承接`, "bad");
}

function nextJob(s: Sim): JobKind {
  for (const k of PICK) {
    if (k === "batch") return "batch";
    const j = s.jobs.find((x) => x.kind === k);
    if (!j || j.done >= j.need) continue;
    const on = s.cards.filter((c) => (c.role === "offline" || (c.role === "switching" && c.toward === "offline")) && c.job === k).length;
    if (on < JOB_INFO[k].maxCards) return k;
  }
  return "batch";
}

function toJudge(s: Sim, c: Card): void {
  const kind: SwitchKind = c.job && JOB_INFO[c.job].train ? "train_to_judge" : "infer_to_judge";
  s.lastSwitch = { t: s.t, card: c.id, kind, job: c.job };
  s.switches++;
  log(s, `GPU ${c.id}：暂停「${JOB_INFO[c.job ?? "batch"].short}」${kind === "train_to_judge" ? "并保存断点" : ""}，切换为判官，约 ${Math.round(switchSeconds(kind))} 秒`, "info");
  c.role = "switching"; c.toward = "judge"; c.since = s.t; c.util = 0; c.batch = 0; c.mixed = false;
}
function toOffline(s: Sim, c: Card): void {
  const job = nextJob(s);
  s.lastSwitch = { t: s.t, card: c.id, kind: "judge_to_offline", job };
  s.switches++;
  log(s, `GPU ${c.id}：退出判官，转入「${JOB_INFO[job].short}」，约 ${Math.round(switchSeconds("judge_to_offline"))} 秒`, "good");
  c.role = "switching"; c.toward = "offline"; c.job = job; c.since = s.t; c.util = 0; c.batch = 0; c.mixed = false;
}

/** advance one simulated minute (every switch takes well under a minute, so a switching card is back next minute) */
export function step(s: Sim): void {
  s.t += 1; s.minutes += 1;
  const spikeMul = s.t < s.spikeUntil ? Math.min(2.2, 1 + 1.2 * ((s.t - s.spikeFrom) / 3)) : 1;
  if (s.spikeUntil > 0 && s.t === s.spikeUntil) log(s, "热点回落", "info");
  const demand = planned(s.t) * spikeMul * (0.96 + 0.08 * rand(s));
  s.demand = demand;
  if (s.t % 1440 === 0) { s.jobs = JOBS(); log(s, "零点：今晚的平台任务进入队列（评测、训练、聚类、信誉分、回扫、OCR）", "info"); }

  // last minute's switches complete; repaired cards come back as offline workers
  for (const c of s.cards) {
    if (c.role === "switching") { c.role = c.toward === "judge" ? "judge" : "offline"; if (c.role === "judge") c.job = null; c.toward = null; }
    if (c.role === "failed" && ++c.downFor >= 30) { c.role = "offline"; c.job = nextJob(s); c.since = s.t; log(s, `GPU ${c.id} 修复完成，回到卡池执行「${JOB_INFO[c.job].short}」`, "good"); }
  }

  // how many judges: now (+15%) and, with prediction, 10 minutes ahead (+10%); plus one hot spare
  const capPer = s.level >= 1 ? CAP_FAST : CAP_NORMAL;
  const judges = s.cards.filter((c) => c.role === "judge");
  const ahead = s.flags.predict ? planned(s.t + 10) * 1.1 : 0;
  const usable = s.cards.filter((c) => c.role !== "failed").length;
  const need = Math.min(usable, Math.max(2, Math.ceil(Math.max(demand * 1.15, ahead) / CAP_NORMAL) + (s.flags.predict ? 1 : 0)));
  if (judges.length < need) {
    const pool = s.cards.filter((c) => c.role === "offline").sort((a, b) => PREEMPT.indexOf(a.job ?? "batch") - PREEMPT.indexOf(b.job ?? "batch"));
    const take = pool.slice(0, need - judges.length);
    for (const c of take) toJudge(s, c);
    if (take.length) log(s, s.flags.predict && ahead > demand * 1.15 ? `预测 10 分钟后约 ${Math.round(planned(s.t + 10))} 条/秒，从离线任务借调 ${take.length} 张卡` : `当前负载 ${Math.round(demand)} 条/秒超出余量，从离线任务借调 ${take.length} 张卡`, "info");
  } else if (judges.length > need + 1 && s.t - s.lastRelease >= 5) {
    const c = judges.filter((x) => s.t - x.since >= MIN_HOLD).pop();
    if (c) { toOffline(s, c); s.lastRelease = s.t; }
  }

  // serving
  const serving = s.cards.filter((c) => c.role === "judge");
  const C = Math.max(1, serving.length) * capPer;
  const preFirst = s.level >= 3 ? demand * 0.3 : 0;
  const inflow = demand - preFirst;
  s.deferred += preFirst * 60;
  const offered = inflow * 60 + s.q;
  const served = Math.min(C * 60, offered);
  s.q = offered - served;
  const u = Math.min(1, inflow / C);
  s.fastS = 0.04 + 0.5 * u * u + s.q / C;

  // agent tier
  s.agentShare = s.flags.evidence ? AGENT_SHARE_EVIDENCE : AGENT_SHARE;
  const agentIn = (served / 60) * s.agentShare;
  if (s.level >= 2 && agentIn > AGENT_CAP) s.deferred += (agentIn - AGENT_CAP) * 60;
  s.agentQ = Math.max(0, s.agentQ + (Math.min(agentIn, s.level >= 2 ? AGENT_CAP : agentIn) - AGENT_CAP) * 60);
  s.agentS = 2.5 + s.agentQ / AGENT_CAP;
  s.doneS = s.fastS + (s.agentShare > 0.05 ? s.agentS : 0.35);

  // degrade ladder: only when the whole pool is not enough (or during the minute a switch takes)
  if (s.flags.degrade) {
    const prev = s.level;
    if (s.level < 1 && (u > 0.92 || s.q > 0)) s.level = 1;
    if (s.level < 2 && agentIn > AGENT_CAP) s.level = 2;
    if (s.level < 3 && s.fastS > SLO_S * 0.6) s.level = 3;
    if (s.level > prev) { s.calm = 0; log(s, `升至第 ${s.level} 档：${LEVELS[s.level]!.name}`, "warn"); }
    else if (u < 0.6 && s.q === 0 && agentIn < AGENT_CAP * 0.8 && s.level > 0) {
      if (++s.calm >= 10) { s.level = (s.level - 1) as Level; s.calm = 0; log(s, `压力解除，回到第 ${s.level} 档：${LEVELS[s.level]!.name}`, "good"); }
    } else s.calm = 0;
  } else if (s.level !== 0) s.level = 0;

  // judge cards with room run offline inference in the same process at low priority (backfill first): "mixed"
  let spare = s.level === 0 ? Math.max(0, serving.length - (inflow / capPer) * 1.15) : 0;
  if (spare > 0 && s.deferred > 0) {
    const n = Math.min(s.deferred, spare * capPer * 60);
    s.deferred -= n; s.backfilled += n; spare -= n / (capPer * 60);
    if (s.deferred <= 0) log(s, `高峰期暂缓的内容已全部补审，在判官卡上以低优先级执行（累计约 ${s.backfilled >= 10_000 ? `${Math.round(s.backfilled / 10_000)} 万` : Math.round(s.backfilled)} 条）`, "good");
  }
  const mixedCards = Math.floor(spare);

  // offline cards make progress on their jobs; a finished job's cards pick the next one
  for (const c of s.cards) {
    if (c.role !== "offline") continue;
    const j = c.job && c.job !== "batch" ? s.jobs.find((x) => x.kind === c.job) : undefined;
    if (j) {
      j.done = Math.min(j.need, j.done + 1);
      if (j.done >= j.need) { log(s, `离线任务完成：${JOB_INFO[j.kind].label}`, "good"); for (const o of s.cards) if (o.role === "offline" && o.job === j.kind) o.job = nextJob(s); }
    } else { s.batchDone += 1; if (c.job === "batch" && s.t % 15 === c.id % 15) { const better = nextJob(s); if (better !== "batch") c.job = better; } }
  }

  // per-card view
  serving.forEach((c, i) => {
    const wobble = 1 + 0.07 * Math.sin(i * 1.7 + s.t / 6);
    c.mixed = i >= serving.length - mixedCards;
    c.util = Math.min(1, u * wobble + (c.mixed ? 0.25 : 0));
    c.batch = Math.max(1, Math.min(32, Math.round(Math.min(1, u * wobble) * 32)));
  });
  for (const c of s.cards) if (c.role === "offline") { c.util = 0.92; c.batch = 0; c.mixed = false; }
  const busy = s.cards.reduce((a, c) => a + (c.role === "judge" ? Math.max(c.util, 0.35) : c.role === "offline" ? 0.92 : 0), 0);
  s.poolUtil = busy / CARDS;

  s.history.push({ t: s.t, demand, cap: C, judges: serving.length, offline: s.cards.filter((c) => c.role === "offline").length, fastS: s.fastS, doneS: s.doneS, level: s.level });
  if (s.history.length > 1440) s.history.shift();
}
