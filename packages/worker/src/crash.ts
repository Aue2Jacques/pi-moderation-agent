// Fault injection (docs §11.5). Only active when CRASH_AT names this point; kills the process the way a real crash would.
export type CrashPoint = "A" | "B" | "C" | "D" | "J" | "S1" | "S2";   // J: inside the judge tool after tool_request opened, before the external call (H-22 replay count); S1: conversation bound, before submit; S2: submitted, before submission_id bound

/** `attempt` lets a test crash only a later generation (CRASH_ATTEMPT); without CRASH_ATTEMPT every pass through the point crashes. */
export function crashAt(point: CrashPoint, attempt?: number): void {
  const only = process.env["CRASH_ATTEMPT"];
  if (process.env["CRASH_AT"] === point && (only === undefined || Number(only) === attempt)) {
    process.stderr.write(`CRASH_AT=${point}\n`);
    process.kill(process.pid, "SIGKILL");
  }
}
