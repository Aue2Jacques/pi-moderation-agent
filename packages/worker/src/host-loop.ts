// Host control loop: the only place that aborts conversations (hooks cannot; HookApi has no conversation()). docs §8.4.
export type HostRequest = { conversationId: string; kind: "abort" | "release" | "finished"; reason: string };

export class HostLoop {
  readonly #queue: HostRequest[] = [];
  readonly #seen = new Set<string>();
  request(r: HostRequest): void {
    const key = `${r.conversationId}|${r.kind}|${r.reason}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#queue.push(r);
  }
  take(): HostRequest[] {
    const out = this.#queue.splice(0);
    for (const r of out) this.#seen.delete(`${r.conversationId}|${r.kind}|${r.reason}`);
    return out;
  }
  get pending(): number {
    return this.#queue.length;
  }
}
