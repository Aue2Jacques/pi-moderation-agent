// Single-instance lock (dev plan 2026-10-08 R1): an exclusive SQLite lock on a dedicated file, held for the life of
// the process. Underneath it is an fcntl lock, which the OS drops when the process dies however it dies, so there is
// no stale state to clean up. A second holder — another process, or another connection in this process — gets
// SQLITE_BUSY at once (busy_timeout 0). Replaces the pid-file lock, which had a check-then-delete race: two
// contenders that both saw a stale pid could each delete the other's fresh file and both "acquire".
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const held = new Map<string, DatabaseSync>();

/** true when this process now holds the lock at `path`; false when anyone (including this process) already does. */
export function acquireSingleInstanceLock(path: string): boolean {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  } catch {
    db.close();
    return false;
  }
  try { chmodSync(path, 0o600); } catch { /* best effort; the lock itself does not depend on it */ }
  held.set(path, db);   // keep the connection referenced: closing it (or exiting) releases the lock
  return true;
}

/** Release a lock this process holds (tests; a worker simply exits). */
export function releaseSingleInstanceLock(path: string): void {
  held.get(path)?.close();
  held.delete(path);
}
