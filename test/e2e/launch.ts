// Start the console the way a person does (scripts/console.ts --demo) on a free port and a temporary data dir, and
// stop it again. Shared by the end-to-end scripts in this directory.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");

export const freePort = (): Promise<number> => new Promise((ok, fail) => {
  const s = createServer();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); });
});

export type Launched = { base: string; proc: ChildProcess; log: string[]; stop: () => Promise<void> };

/** Launch the demo; resolves once G and W are both up. `env` overrides pacing (DEMO_AGENT_MS etc.). */
export async function launchDemo(env: NodeJS.ProcessEnv = {}): Promise<Launched> {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), "console-e2e-"));
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/console.ts", "--demo", "--port", String(port), "--data", data], {
    cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const log: string[] = [];
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`console did not start:\n${log.join("")}`)), 90_000);
    const seen = { g: false, w: false };
    const on = (d: Buffer): void => {
      const s = d.toString();
      log.push(s);
      if (s.includes("gateway up")) seen.g = true;
      if (s.includes("worker up")) seen.w = true;
      if (seen.g && seen.w) { clearTimeout(t); ok(); }
    };
    proc.stdout!.on("data", on);
    proc.stderr!.on("data", (d: Buffer) => log.push(d.toString()));
    proc.on("exit", (code) => { clearTimeout(t); fail(new Error(`console exited ${code}:\n${log.join("")}`)); });
  });
  const stop = async (): Promise<void> => {
    proc.removeAllListeners("exit");
    try { process.kill(-proc.pid!, "SIGTERM"); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 800));
    try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already gone */ }
    rmSync(data, { recursive: true, force: true });
  };
  return { base: `http://127.0.0.1:${port}`, proc, log, stop };
}
