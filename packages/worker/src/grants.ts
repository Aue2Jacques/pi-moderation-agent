// Execution-eligibility table (docs §7.3). In-process only; rebuilt at startup.
import type { Pins } from "@mod/core";

export type GrantMode = "active" | "finalize" | "revoked";

export type Grant = {
  mode: GrantMode;
  reviewId: string;
  contentId: string;
  attempt: number;
  pins: Pins;
  modelId: string;
  budgetTools: number;
  budgetMicro: number;
  /** wall clock when the current tool round started (for roundHadBlocked) */
  roundStartedAt: number;
};

export class Grants {
  readonly #byConversation = new Map<string, Grant>();
  readonly #byReview = new Map<string, string>();

  set(conversationId: string, grant: Grant): void {
    this.#byConversation.set(conversationId, grant);
    this.#byReview.set(grant.reviewId, conversationId);
  }
  get(conversationId: string): Grant | undefined {
    return this.#byConversation.get(conversationId);
  }
  conversationOf(reviewId: string): string | undefined {
    return this.#byReview.get(reviewId);
  }
  delete(conversationId: string): void {
    const g = this.#byConversation.get(conversationId);
    if (g) this.#byReview.delete(g.reviewId);
    this.#byConversation.delete(conversationId);
  }
  entries(): [string, Grant][] {
    return [...this.#byConversation.entries()];
  }
  count(mode?: GrantMode): number {
    return mode ? [...this.#byConversation.values()].filter((g) => g.mode === mode).length : this.#byConversation.size;
  }
}
