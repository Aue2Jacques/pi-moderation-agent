// Review state machine: docs/dev-doc-v1.md §3.2. Terminal states never leave.
import { CoreError } from "./errors.ts";
import type { ReviewState } from "./types.ts";

export type TransitionId = "S1" | "S2" | "S2'" | "S3" | "S3'" | "S4" | "S5" | "S6" | "S7" | "S8" | "S9" | "S10" | "S11";

export const TRANSITIONS: Readonly<Record<TransitionId, { from: ReviewState | null; to: ReviewState | "new_review" }>> = {
  S1: { from: null, to: "disposed" },
  S2: { from: null, to: "queued" },
  "S2'": { from: null, to: "human_queue" },
  S3: { from: "queued", to: "investigating" },
  "S3'": { from: "investigating", to: "investigating" },
  S4: { from: "investigating", to: "investigating" },
  S5: { from: "investigating", to: "disposed" },
  S6: { from: "investigating", to: "human_queue" },
  S7: { from: "investigating", to: "human_queue" },
  S8: { from: "investigating", to: "queued" },
  S9: { from: "human_queue", to: "human_disposed" },
  S10: { from: "disposed", to: "new_review" },     // also from human_disposed
  S11: { from: "queued", to: "human_queue" },
};

export const TERMINAL: ReadonlySet<ReviewState> = new Set(["disposed", "human_disposed"]);
export const isTerminal = (s: ReviewState): boolean => TERMINAL.has(s);

const ALLOWED: ReadonlySet<string> = new Set(
  Object.values(TRANSITIONS)
    .filter((t) => t.to !== "new_review")
    .map((t) => `${t.from ?? "-"}>${t.to}`),
);

/** Throws E_STATE_INVALID unless `from -> to` is a row of §3.2. `from=null` means review creation. */
export function assertTransition(from: ReviewState | null, to: ReviewState): void {
  if (from !== null && isTerminal(from)) throw new CoreError("E_STATE_INVALID", `terminal state ${from} cannot transition`, { from, to });
  if (!ALLOWED.has(`${from ?? "-"}>${to}`)) throw new CoreError("E_STATE_INVALID", `no transition ${from} -> ${to}`, { from, to });
}

export function canTransition(from: ReviewState | null, to: ReviewState): boolean {
  try {
    assertTransition(from, to);
    return true;
  } catch {
    return false;
  }
}
