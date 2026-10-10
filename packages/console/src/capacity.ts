// Capacity page simulation (frontend only, no backend): one platform day compressed into a few minutes. Traffic follows
// a daily curve (commute and lunch peaks, evening high, night low); a pool of judge GPUs scales ahead of predicted peaks
// and on load; a degrade ladder holds the latency target when capacity runs short; idle capacity runs offline work.
// Every number is a model input, not a measurement, except the ones marked measured in SIM_FACTS. The backend plan for
// building it for real is docs/capacity-plan-2026-10-09.md.

/** platform peak inflow (contents a second) the simulation is scaled to */
export const PEAK = 300;
/** one judge GPU, contents a second: double confirmation on (estimate), off (measured: kevfast HTTP, fp8, 5060 Ti) */
export const CAP_NORMAL = 32;
export const CAP_FAST = 50;
export const MIN_CARDS = 2;
export const MAX_CARDS = 12;
/** minutes a new card needs before it serves (model load + graph capture; estimate) */
export const WARM_MIN = 4;
/** the LLM agent's concurrency budget, reviews a second */
export const AGENT_CAP = 30;
/** share of judged contents that go to the LLM agent: without / with the "Kev with evidence" tier in between */
export const AGENT_SHARE = 0.15;
export const AGENT_SHARE_EVIDENCE = 0.05;
/** latency target: published to reviewed, p95 (seconds) */
export const SLO_S = 3;

export const SIM_FACTS: { k: string; v: string; measured: boolean }[] = [
  { k: "单卡吞吐（关复问，FP8）", v: `${CAP_FAST} 条/秒`, measured: true },
  { k: "单卡吞吐（复问开）", v: `约 ${CAP_NORMAL} 条/秒`, measured: false },
  { k: "快判单条延迟", v: "约 40 毫秒", measured: true },
  { k: "回归评测 3,002 条（单卡）", v: "约 6 分钟", measured: true },
  { k: "Kev 训练一版（单卡）", v: "约 2.7 小时", measured: true },
  { k: "新卡就绪", v: `约 ${WARM_MIN} 分钟`, measured: false },
  { k: "平台峰值、日曲线形状、agent 并发上限", v: `${PEAK} 条/秒 · 早晚高峰 · ${AGENT_CAP} 次/秒`, measured: false },
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

export type CardState = "off" | "warming" | "on" | "failed";
export type Card = { id: number; state: CardState; warm: number; util: number; batch: number; role: "online" | "offline" | "idle"; downFor: number };
export type Level = 0 | 1 | 2 | 3;
export const LEVELS: { level: Level; name: string; what: string; cost: string }[] = [
  { level: 0, name: "正常", what: "复问开，所有内容先审后发", cost: "—" },
  { level: 1, name: "关复问", what: "单卡吞吐约 1.5 倍（32 → 50 条/秒）", cost: "违规漏放 1.5% → 2.1%（测算）" },
  { level: 2, name: "先限流后补审", what: "agent 排不上的可疑内容先限流（仅作者可见），低峰补审", cost: "可疑内容可见性推迟" },
  { level: 3, name: "低风险先发后审", what: "信誉高的账号、低风险场景先发布，低峰补审", cost: "少量违规短时可见" },
];
export type Job = { id: string; label: string; need: number; done: number; measured: boolean };
export type Point = { t: number; demand: number; cap: number; cards: number; fastS: number; doneS: number; level: Level; offline: number };
export type SimEvent = { t: number; text: string; tone: "info" | "warn" | "bad" | "good" };
export type Flags = { predict: boolean; degrade: boolean; evidence: boolean };
export type Sim = {
  t: number; cards: Card[]; level: Level; calm: number; q: number; agentQ: number; deferred: number; backfilled: number;
  jobs: Job[]; history: Point[]; events: SimEvent[]; spikeUntil: number; spikeFrom: number; cardMinutes: number; minutes: number;
  lastDown: number; flags: Flags; demand: number; fastS: number; agentS: number; doneS: number; agentShare: number; seed: number;
};

/** the nightly offline jobs; `done`: start finished (the simulation starts in the morning, last night's run is done) */
const JOBS = (done = false): Job[] => [
  { id: "eval", label: "回归评测：测试集 3,002 条", need: 6, done: 0, measured: true },
  { id: "cluster", label: "全天评论向量聚类：识别水军和引流团伙", need: 60, done: 0, measured: false },
  { id: "trust", label: "账号信誉分：离线重算", need: 40, done: 0, measured: false },
  { id: "rescan", label: "规则回扫：最近 7 天内容", need: 90, done: 0, measured: false },
  { id: "train", label: "Kev 增量训练（当天 agent / 人工结论）", need: 160, done: 0, measured: true },
].map((j) => ({ ...j, done: done ? j.need : 0 }));

export const START_MIN = 6 * 60;

export function newSim(flags: Flags = { predict: true, degrade: true, evidence: true }): Sim {
  const cards: Card[] = Array.from({ length: MAX_CARDS }, (_, i) => ({ id: i + 1, state: i < 4 ? "on" : "off", warm: 0, util: 0, batch: 0, role: "idle", downFor: 0 }));
  return { t: START_MIN, cards, level: 0, calm: 0, q: 0, agentQ: 0, deferred: 0, backfilled: 0, jobs: JOBS(true), history: [], events: [{ t: START_MIN, text: "模拟开始：4 张卡在线；昨晚的离线任务已完成", tone: "info" }],
    spikeUntil: -1, spikeFrom: -1, cardMinutes: 0, minutes: 0, lastDown: -999, flags, demand: 0, fastS: 0.05, agentS: 2.5, doneS: 0.4, agentShare: AGENT_SHARE_EVIDENCE, seed: 7 };
}

function rand(s: Sim): number {
  s.seed = (s.seed * 1103515245 + 12345) & 0x7fffffff;
  return s.seed / 0x7fffffff;
}
const fmt = (m: number): string => `${String(Math.floor((m % 1440) / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const simClock = fmt;
function log(s: Sim, text: string, tone: SimEvent["tone"] = "info"): void {
  s.events.unshift({ t: s.t, text, tone });
  if (s.events.length > 60) s.events.length = 60;
}

/** a hot topic: 2.2x the planned inflow for 25 minutes (not predicted) */
export function spike(s: Sim): void {
  s.spikeFrom = s.t; s.spikeUntil = s.t + 25;
  log(s, "突发热点：流量在 3 分钟内涨到计划的 2.2 倍（预测里没有）", "warn");
}
/** fail one serving card: health checks remove it, its share moves to the others */
export function failCard(s: Sim): void {
  const on = s.cards.filter((c) => c.state === "on");
  if (on.length <= 1) return;
  const c = on[Math.floor(rand(s) * on.length)]!;
  c.state = "failed"; c.downFor = 0; c.util = 0; c.batch = 0;
  log(s, `卡 ${c.id} 健康检查失败，已从路由摘除，流量转到其余 ${on.length - 1} 张卡`, "bad");
}

/** advance one simulated minute */
export function step(s: Sim): void {
  s.t += 1; s.minutes += 1;
  const spikeMul = s.t < s.spikeUntil ? Math.min(2.2, 1 + 1.2 * ((s.t - s.spikeFrom) / 3)) : 1;
  if (s.spikeUntil > 0 && s.t === s.spikeUntil) log(s, "热点回落", "info");
  const demand = planned(s.t) * spikeMul * (0.96 + 0.08 * rand(s));
  s.demand = demand;

  for (const c of s.cards) {
    if (c.state === "warming" && --c.warm <= 0) { c.state = "on"; log(s, `卡 ${c.id} 就绪，加入路由`, "good"); }
    if (c.state === "failed" && ++c.downFor >= 8) { c.state = "off"; log(s, `卡 ${c.id} 已下线检修，名额让给新卡`, "info"); }
  }

  // autoscaling: ahead of the planned curve (predict) and on current load
  const capPer = s.level >= 1 ? CAP_FAST : CAP_NORMAL;
  const on = s.cards.filter((c) => c.state === "on");
  const warming = s.cards.filter((c) => c.state === "warming");
  const ahead = s.flags.predict ? planned(s.t + 15) / (CAP_NORMAL * 0.8) : 0;
  const target = Math.max(MIN_CARDS, Math.min(MAX_CARDS, Math.ceil(Math.max(demand / (CAP_NORMAL * 0.85), ahead))));
  const active = on.length + warming.length;
  if (active < target) {
    const free = s.cards.filter((c) => c.state === "off").slice(0, target - active);
    for (const c of free) { c.state = "warming"; c.warm = WARM_MIN; }
    if (free.length) {
      const why = ahead >= demand / (CAP_NORMAL * 0.85) && s.flags.predict ? `预测 15 分钟后约 ${Math.round(planned(s.t + 15))} 条/秒，提前加 ${free.length} 张卡` : `负载 ${Math.round(demand)} 条/秒超出余量，临时加 ${free.length} 张卡`;
      log(s, why, "info");
    } else if (on.length + warming.length < MAX_CARDS) { /* every free card is failed */ }
  } else if (active > target + 1 && s.t - s.lastDown >= 20 && on.length > MIN_CARDS && warming.length === 0) {
    const c = [...on].reverse().find((x) => x.role !== "online") ?? on[on.length - 1]!;
    c.state = "off"; c.util = 0; c.batch = 0; s.lastDown = s.t;
    log(s, `流量回落，退掉卡 ${c.id}（按小时计费，空着就是浪费）`, "good");
  }

  // L3: low-risk contents from trusted accounts publish first and are reviewed later
  const nowOn = s.cards.filter((c) => c.state === "on");
  const C = Math.max(1, nowOn.length) * capPer;
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
  let agentOver = 0;
  if (s.level >= 2 && agentIn > AGENT_CAP) { agentOver = agentIn - AGENT_CAP; s.deferred += agentOver * 60; }
  s.agentQ = Math.max(0, s.agentQ + (Math.min(agentIn, s.level >= 2 ? AGENT_CAP : agentIn) - AGENT_CAP) * 60);
  s.agentS = 2.5 + s.agentQ / AGENT_CAP;
  // p95 of published -> reviewed: the agent's share decides whether the 95th percentile is an agent review
  s.doneS = s.fastS + (s.agentShare > 0.05 ? s.agentS : 0.35);

  // degrade ladder
  if (s.flags.degrade) {
    const prev = s.level;
    if (s.level < 1 && (u > 0.92 || s.q > 0)) s.level = 1;
    if (s.level < 2 && agentIn > AGENT_CAP) s.level = 2;
    if (s.level < 3 && s.fastS > SLO_S * 0.6) s.level = 3;
    if (s.level > prev) { s.calm = 0; log(s, `降级到第 ${s.level} 档：${LEVELS[s.level]!.name}`, "warn"); }
    else if (u < 0.6 && s.q === 0 && agentIn < AGENT_CAP * 0.8 && s.level > 0) {
      if (++s.calm >= 10) { s.level = (s.level - 1) as Level; s.calm = 0; log(s, `压力解除，恢复到第 ${s.level} 档：${LEVELS[s.level]!.name}`, "good"); }
    } else s.calm = 0;
  } else if (s.level !== 0) s.level = 0;

  // idle capacity: keep 15% headroom for online traffic, the rest runs offline work (backfill first)
  let spare = s.level === 0 ? Math.max(0, nowOn.length - (inflow / capPer) * 1.15) : 0;
  const hasWork = s.deferred > 0 || s.jobs.some((j) => j.done < j.need);
  const offlineCards = spare;
  if (spare > 0 && s.deferred > 0) {
    const n = Math.min(s.deferred, spare * capPer * 60);
    s.deferred -= n; s.backfilled += n; spare -= n / (capPer * 60);
    if (s.deferred <= 0) log(s, `高峰时暂缓的内容已全部补审（累计约 ${s.backfilled >= 10_000 ? `${Math.round(s.backfilled / 10_000)} 万` : Math.round(s.backfilled)} 条）`, "good");
  }
  for (const j of s.jobs) {
    if (spare <= 0) break;
    if (j.done >= j.need) continue;
    const use = Math.min(spare, j.need - j.done);
    j.done += use; spare -= use;
    if (j.done >= j.need) log(s, `离线任务完成：${j.label}`, "good");
  }
  if (s.t % 1440 === 0) { s.jobs = JOBS(); log(s, "零点：今晚的离线任务开始排队，用空出来的卡跑", "info"); }

  // per-card view: affinity keeps some cards a little busier; spare cards show as offline
  let offlineLeft = hasWork ? Math.floor(offlineCards) : 0;
  nowOn.forEach((c, i) => {
    const wobble = 1 + 0.07 * Math.sin(i * 1.7 + s.t / 6);
    if (offlineLeft > 0 && i >= nowOn.length - offlineLeft) { c.role = "offline"; c.util = 0.9; c.batch = 32; return; }
    c.role = "online";
    const share = Math.min(1, u * wobble * (nowOn.length / Math.max(1, nowOn.length - offlineLeft)));
    c.util = share; c.batch = Math.max(1, Math.min(32, Math.round(share * 32)));
  });
  for (const c of s.cards) if (c.state !== "on") { c.role = "idle"; c.util = 0; c.batch = 0; }

  s.cardMinutes += nowOn.length + s.cards.filter((c) => c.state === "warming").length;
  s.history.push({ t: s.t, demand, cap: C, cards: nowOn.length, fastS: s.fastS, doneS: s.doneS, level: s.level, offline: hasWork ? Math.max(0, offlineCards) : 0 });
  if (s.history.length > 1440) s.history.shift();
}

/** card-hours used vs keeping MAX_CARDS on all day */
export function savings(s: Sim): number {
  return s.minutes ? 1 - s.cardMinutes / (MAX_CARDS * s.minutes) : 0;
}
