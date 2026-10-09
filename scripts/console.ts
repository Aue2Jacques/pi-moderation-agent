// One command for the web console: build it if needed, start G (which serves it) and W, stop both on Ctrl-C.
// usage: node --experimental-strip-types scripts/console.ts [--demo] [--keep] [--build] [--port 8080] [--data dir]
//                                                            [--traffic N | --no-traffic]
//   --demo   demo mode (DEMO=1): scripted judge and agent, no .env, no API key; its own app.db under data/demo/
//            (or --data dir), emptied on every start unless --keep
//   --traffic N / --no-traffic   demo mode only: generated contents per minute (DEMO_TRAFFIC_PER_MIN, default 20) / none
//   (none)   real mode: G and W read .env as usual (JEV_BASE_URL may point at Jev or kevfast; RELAY_* for the agent)
//   --build  rebuild the console even when packages/console/dist exists
// pnpm run demo / pnpm run console are the short forms.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const has = (f: string): boolean => args.includes(f);
const opt = (f: string, d: string): string => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1]! : d; };
const demo = has("--demo");
const port = Number(opt("--port", process.env["G_PORT"] ?? "8080"));
if (!demo && (has("--traffic") || has("--no-traffic"))) { console.error("[console] --traffic / --no-traffic only apply to --demo"); process.exit(2); }

const dist = join(ROOT, "packages", "console", "dist");
if (has("--build") || !existsSync(join(dist, "index.html"))) {
  console.log("[console] building packages/console ...");
  const b = spawnSync("pnpm", ["--filter", "@mod/console", "run", "build"], { cwd: ROOT, stdio: "inherit" });
  if (b.status !== 0) { console.error("[console] build failed"); process.exit(1); }
}

const env: NodeJS.ProcessEnv = { ...process.env, G_PORT: String(port), W_PORT: String(port + 1), CONSOLE_DIR: dist };
if (demo) {
  const dir = resolve(opt("--data", join(ROOT, "data", "demo")));
  if (!has("--keep")) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (has("--no-traffic")) env["DEMO_TRAFFIC_PER_MIN"] = "0";
  else if (has("--traffic")) env["DEMO_TRAFFIC_PER_MIN"] = opt("--traffic", "20");
  Object.assign(env, { DEMO: "1", APP_DB: join(dir, "app.db"), SESSION_DB: join(dir, "session.sqlite"), W_LOCK: join(dir, "w.lock.db"), HUMAN_REVIEW_TOKEN: env["HUMAN_REVIEW_TOKEN"] ?? "demo-token" });
}

const children: ChildProcess[] = [];
const prefix = (name: string, child: ChildProcess): void => {
  for (const [stream, out] of [[child.stdout, process.stdout], [child.stderr, process.stderr]] as const) {
    let buf = "";
    stream?.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) out.write(`[${name}] ${l}\n`);
    });
  }
};
const start = (name: string, entry: string): ChildProcess => {
  const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", entry], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  prefix(name, c);
  c.on("exit", (code, sig) => { console.log(`[console] ${name} exited (${sig ?? code})`); stop(code ?? 1); });
  children.push(c);
  return c;
};
let stopping = false;
function stop(code = 0): void {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const g = start("G", "packages/gateway/src/main.ts");
g.stdout?.on("data", function onUp(d: Buffer) {
  if (!d.toString("utf8").includes("gateway up")) return;
  g.stdout?.off("data", onUp);
  start("W", "packages/worker/src/main.ts");
  console.log(`[console] ${demo ? "demo" : "real"} mode: http://127.0.0.1:${port}/  (Ctrl-C stops G and W)`);
});
