// Fault injection (docs §11.5). Only active when CRASH_AT names this point; kills the process the way a real crash would.
export type CrashPoint = "A" | "B" | "C" | "D" | "S1" | "S2";   // S1: conversation bound, before submit; S2: submitted, before submission_id bound

export function crashAt(point: CrashPoint): void {
  if (process.env["CRASH_AT"] === point) {
    process.stderr.write(`CRASH_AT=${point}\n`);
    process.kill(process.pid, "SIGKILL");
  }
}
