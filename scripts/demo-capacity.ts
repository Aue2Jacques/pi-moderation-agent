// Capacity of the demo setup: start the console the way a person does (scripts/console.ts --demo: real G and W
// processes, scripted judge and agent), step the demo traffic through rate tiers, and measure per tier what goes in
// and what comes out: contents generated and through the fast path a second, agent reviews finished a second, the
// queues (intake not yet judged, agent queued + running, human open), CPU and memory of G and W, and the size of
// app.db / session.sqlite. A tier "keeps up" when the fast path stays within 5% of the offered rate and neither the
// intake nor the agent queue grows over the measuring window (and the generator was not held back by backpressure).
// usage: node --experimental-strip-types --no-warnings scripts/demo-capacity.ts [--tiers 1,5,20,50] [--secs 60]
//        [--warm 20] [--json out.json] [--keep 4000]
//   --tiers 50 --secs 600: a soak run at one rate (app.db / session.sqlite size with demo retention on)
// It raises the accepted maximum (DEMO_MAX_PER_SEC) so tiers above the console's limit can be tried. Numbers depend on
// the machine; docs/console-2026-10-09.md §6.3 has the reference run.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import type { Stats, TrafficStatus } from "../packages/gateway/src/console-types.ts";
import { freePort, ROOT } from "../test/e2e/launch.ts";

const args = process.argv.slice(2);
const opt = (f: string, d: string): string => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
const tiers = opt("--tiers", "1,5,20,50").split(",").map(Number);
const secs = Number(opt("--secs", "60"));
const warm = Number(opt("--warm", "20"));
const out = opt("--json", "");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Metrics = { queue_intake: number; queue_agent: number; queue_human: number };
const port = await freePort();
const data = mkdtempSync(join(tmpdir(), "demo-capacity-"));
const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/console.ts", "--demo", "--port", String(port), "--data", data, "--rate", "0"], {
  cwd: ROOT, env: { ...process.env, DEMO_MAX_PER_SEC: "1000", DEMO_KEEP_CONTENTS: opt("--keep", "4000") }, stdio: ["ignore", "pipe", "pipe"], detached: true,
});
const log: string[] = [];
const pids: { g: number | undefined; w: number | undefined } = { g: undefined, w: undefined };
await new Promise<void>((ok, fail) => {
  const t = setTimeout(() => fail(new Error(`console did not start:\n${log.join("")}`)), 120_000);
  proc.stdout!.on("data", (d: Buffer) => {
    const s = d.toString();
    log.push(s);
    if (s.includes("worker up")) { clearTimeout(t); ok(); }
  });
  proc.stderr!.on("data", (d: Buffer) => log.push(d.toString()));
  proc.on("exit", (code) => { clearTimeout(t); fail(new Error(`console exited ${code}:\n${log.join("")}`)); });
});
// G and W are the launcher's children, in start order
const kids = readFileSync(`/proc/${proc.pid}/task/${proc.pid}/children`, "utf8").trim().split(/\s+/).map(Number);
pids.g = kids[0]; pids.w = kids[1];
const base = `http://127.0.0.1:${port}`;
const get = async <T>(p: string): Promise<T> => (await (await fetch(base + p)).json()) as T;
const setRate = (perSec: number): Promise<Response> => fetch(`${base}/api/demo/traffic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ per_sec: perSec, paused: false }) });
const ticks = (pid: number | undefined): number => { if (!pid) return 0; const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" "); return Number(f[11]) + Number(f[12]); };
const rssMb = (pid: number | undefined): number => { if (!pid) return 0; const m = /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8")); return m ? Math.round(Number(m[1]) / 1024) : 0; };
const size = (p: string): number => { try { return statSync(p).size; } catch { return 0; } };
const mb = (b: number): number => Math.round(b / 1e5) / 10;
const HZ = 100;

type Row = {
  tier: number; offered: number; fast: number; agent_done: number; human_done: number;
  intake_q: { start: number; end: number; max: number }; agent_q: { start: number; end: number; max: number }; human_q: { start: number; end: number; max: number };
  cpu_g: number; cpu_w: number; rss_g: number; rss_w: number; app_db_mb: number; session_mb: number; reviews_in_db: number; pruned: number; keeps_up: boolean;
};
const rows: Row[] = [];
try {
  for (const tier of tiers) {
    await setRate(tier);
    await sleep(warm * 1000);
    const s0 = await get<Stats>("/api/stats"), t0 = await get<TrafficStatus>("/api/demo/traffic"), m0 = await get<Metrics>("/api/metrics");
    const c0 = { g: ticks(pids.g), w: ticks(pids.w), at: Date.now() };
    const iq: number[] = [m0.queue_intake], aq: number[] = [s0.agent.open], hq: number[] = [s0.human.open];
    const end = Date.now() + secs * 1000;
    while (Date.now() < end) {
      await sleep(2000);
      const [m, s] = await Promise.all([get<Metrics>("/api/metrics"), get<Stats>("/api/stats")]);
      iq.push(m.queue_intake); aq.push(s.agent.open); hq.push(s.human.open);
    }
    const s1 = await get<Stats>("/api/stats"), t1 = await get<TrafficStatus>("/api/demo/traffic");
    const dt = (Date.now() - c0.at) / 1000;
    const per = (a: number, b: number): number => Math.round(((b - a) / dt) * 100) / 100;
    const q = (xs: number[]): { start: number; end: number; max: number } => ({ start: xs[0]!, end: xs[xs.length - 1]!, max: Math.max(...xs) });
    const offered = per(t0.generated, t1.generated), fast = per(s0.judged, s1.judged);
    const agentDone = per(s0.agent.disposed + s0.agent.released, s1.agent.disposed + s1.agent.released);
    // growing: the queue ended clearly higher than it started and higher than a few seconds of inflow
    const grows = (x: { start: number; end: number }, slack: number): boolean => x.end - x.start > Math.max(10, slack);
    const row: Row = {
      tier, offered, fast, agent_done: agentDone, human_done: per(s0.human.closed, s1.human.closed),
      intake_q: q(iq), agent_q: q(aq), human_q: q(hq),
      cpu_g: Math.round(((ticks(pids.g) - c0.g) / HZ / dt) * 100), cpu_w: Math.round(((ticks(pids.w) - c0.w) / HZ / dt) * 100),
      rss_g: rssMb(pids.g), rss_w: rssMb(pids.w),
      app_db_mb: mb(size(join(data, "app.db")) + size(join(data, "app.db-wal"))), session_mb: mb(size(join(data, "session.sqlite")) + size(join(data, "session.sqlite-wal"))),
      reviews_in_db: 0, pruned: t1.retention?.pruned ?? 0, keeps_up: false,
    };
    // the generator skips contents while G's backpressure pauses intake, so "offered" must also reach the tier
    row.keeps_up = offered >= 0.95 * tier && fast >= 0.95 * offered && !grows(row.intake_q, 2 * tier) && !grows(row.agent_q, 2 * tier);
    row.reviews_in_db = (await get<{ total: number }>("/api/review-list?limit=1")).total;
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  try { process.kill(-proc.pid!, "SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* gone */ }
  rmSync(data, { recursive: true, force: true });
}
console.log(`\nmachine: ${cpus().length} x ${cpus()[0]?.model ?? "?"}, ${Math.round(totalmem() / 1e9)} GB; ${secs} s per tier after ${warm} s warm-up`);
console.log("| 档位（条/秒） | 实际生成 | 快判完成 | agent 完成 | 人工完成 | 接入队列 起/止/峰 | agent 队列 起/止/峰 | 人工队列 起/止/峰 | G CPU | W CPU | G / W 内存 MB | app.db MB | session MB | 跟得上 |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  const f = (x: { start: number; end: number; max: number }): string => `${x.start} / ${x.end} / ${x.max}`;
  console.log(`| ${r.tier} | ${r.offered} | ${r.fast} | ${r.agent_done} | ${r.human_done} | ${f(r.intake_q)} | ${f(r.agent_q)} | ${f(r.human_q)} | ${r.cpu_g}% | ${r.cpu_w}% | ${r.rss_g} / ${r.rss_w} | ${r.app_db_mb} | ${r.session_mb} | ${r.keeps_up ? "是" : "否"} |`);
}
if (out) writeFileSync(out, JSON.stringify({ machine: { cpus: cpus().length, model: cpus()[0]?.model, mem_gb: Math.round(totalmem() / 1e9) }, secs, warm, rows }, null, 2));
process.exit(0);
