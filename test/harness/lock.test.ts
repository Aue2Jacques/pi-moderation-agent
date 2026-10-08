// R1 (dev plan 2026-10-08): the worker's single-instance lock must admit exactly one holder.
// The pid-file lock it replaces failed these: a second acquire in the same process returned true (deterministic), and
// with a stale pid file, concurrent contenders could both acquire — counted as simultaneous holders, 2 of 20 rounds
// with 10 contenders and 2 of 20 with 24 had 2–3 holders (measured 2026-10-08). At that rate the 12-round race test
// catches a racy lock only about 70% of the time; the same-process test is the deterministic one. Against a correct
// lock the race test must never fail.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireSingleInstanceLock, releaseSingleInstanceLock } from "../../packages/worker/src/flock.ts";

const contender = join(import.meta.dirname, "lock-contender.ts");
const args = (path: string) => ["--experimental-strip-types", "--no-warnings", contender, path];

// Start n contenders at once; each that acquires keeps holding. Count holders only after every contender has
// answered, then kill them all — so a lock released by an early exit can never be counted as a second holder.
function race(path: string, n: number): Promise<number> {
  return new Promise((done) => {
    const kids = Array.from({ length: n }, () => spawn(process.execPath, args(path), { env: { ...process.env, HOLD_MS: "60000" } }));
    let got = 0, answered = 0, closed = 0;
    for (const p of kids) {
      let out = "";
      p.on("close", () => { if (++closed === n) done(got); });   // listen from the start: BUSY contenders exit at once
      p.stdout.on("data", (b) => {
        out += String(b);
        if (!out.includes("\n")) return;
        if (out.startsWith("GOT")) got++;
        if (++answered === n) for (const q of kids) q.kill("SIGKILL");
      });
    }
  });
}

describe("R1 single-instance lock", () => {
  it("a second acquire in the same process is refused, and succeeds after release", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "w.lock.db");
    expect(acquireSingleInstanceLock(path)).toBe(true);
    expect(acquireSingleInstanceLock(path)).toBe(false);
    releaseSingleInstanceLock(path);
    expect(acquireSingleInstanceLock(path)).toBe(true);
    releaseSingleInstanceLock(path);
  });

  it("concurrent processes: exactly one holder per round, also over the file a previous holder left behind", async () => {
    // one path for all rounds: from round 2 on, contenders race over the leftover file of the previous round's holder
    // (the situation that tripped the pid-file lock)
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "w.lock.db");
    for (let round = 0; round < 12; round++) expect(await race(path, 24)).toBe(1);
  }, 120_000);

  it("a holder killed with SIGKILL releases the lock", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "lock-")), "w.lock.db");
    const holder = spawn(process.execPath, args(path), { env: { ...process.env, HOLD_MS: "60000" } });
    await new Promise<void>((ok) => holder.stdout.on("data", (b) => { if (String(b).includes("GOT")) ok(); }));
    expect(spawnSync(process.execPath, args(path), { encoding: "utf8" }).stdout.trim()).toBe("BUSY");
    holder.kill("SIGKILL");
    await new Promise((ok) => holder.on("close", ok));
    const after = spawnSync(process.execPath, args(path), { encoding: "utf8", env: { ...process.env, HOLD_MS: "0" } });
    expect(after.stdout.trim()).toBe("GOT");
  }, 30_000);
});
