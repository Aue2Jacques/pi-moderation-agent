// Child process for test/harness/lock.test.ts: try the worker's single-instance lock once, print GOT or BUSY,
// and hold it for HOLD_MS (so contenders overlap) before exiting.
import { acquireSingleInstanceLock } from "../../packages/worker/src/flock.ts";

const got = acquireSingleInstanceLock(process.argv[2]!);
process.stdout.write(got ? "GOT\n" : "BUSY\n");
if (got) setTimeout(() => {}, Number(process.env.HOLD_MS ?? 400));
