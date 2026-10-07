// Single-instance lock without native modules: an exclusive lock file holding the pid; stale when that pid is gone.
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";

export function flockSync(fd: number): boolean {
  // The caller opened data/w.lock with "w" (truncating). We write our pid; a competing instance checks the pid first.
  void fd;
  return acquirePidLock("data/w.lock.pid");
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquirePidLock(path: string): boolean {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && alive(pid) && pid !== process.pid) return false;
    try { unlinkSync(path); } catch { /* ignore */ }
  }
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    process.on("exit", () => { try { unlinkSync(path); } catch { /* ignore */ } });
    return true;
  } catch {
    return false;
  }
}
