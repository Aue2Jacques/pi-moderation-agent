// ID rules: docs/dev-doc-v1.md §2.3.
import { createHash, randomUUID } from "node:crypto";

export type Trigger = "fast" | "suspicious" | "appeal" | "recheck" | "rule_change";

export const TRIGGERS: readonly Trigger[] = ["fast", "suspicious", "appeal", "recheck", "rule_change"];

export function reviewId(contentId: string, trigger: Trigger, seq: number): string {
  return `${contentId}#${trigger}#${seq}`;
}

export function parseReviewId(id: string): { contentId: string; trigger: Trigger; seq: number } {
  const i = id.lastIndexOf("#");
  const j = id.lastIndexOf("#", i - 1);
  if (i < 0 || j < 0) throw new Error(`bad review_id: ${id}`);
  const trigger = id.slice(j + 1, i) as Trigger;
  const seq = Number(id.slice(i + 1));
  if (!TRIGGERS.includes(trigger) || !Number.isInteger(seq) || seq < 1) throw new Error(`bad review_id: ${id}`);
  return { contentId: id.slice(0, j), trigger, seq };
}

/** Default trigger_request_id: fast/suspicious use the content id; appeal/recheck come from the client; rule_change uses the bundle version. */
export function defaultTriggerRequestId(trigger: Trigger, contentId: string, extra?: string): string {
  switch (trigger) {
    case "fast":
    case "suspicious":
      return contentId;
    case "rule_change":
      if (!extra) throw new Error("rule_change needs rules_ver");
      return `rc:${extra}`;
    default:
      if (!extra) throw new Error(`${trigger} needs a client trigger_request_id`);
      return extra;
  }
}

export const evidenceId = (reviewIdValue: string, n: number): string => `${reviewIdValue}#e${n}`;
export const outboxEventId = (reviewIdValue: string, kind: "ruling" | "release"): string => `${reviewIdValue}#${kind}`;
export const abortCommandId = (reviewIdValue: string, attempt: number): string => `${reviewIdValue}#abort#${attempt}`;
export const workerId = (host: string, pid: number, startMs: number): string => `w-${host}-${pid}-${startMs}`;

export const uuid = (): string => randomUUID();

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Digest of a judge request as handed to the client (dev plan R9a): the client's identity plus everything in the
 *  request — content, every cited evidence view (rule texts and summaries too), questions, shuffle seed. input_sha
 *  stays the logical key (content-bearing evidence only) used to group and verify answers. */
export function requestDigest(client: { provider: string; api: string }, request: unknown): string {
  return sha256(canonical({ provider: client.provider, api: client.api, request }));
}

/** Deterministic JSON: sorted keys, no whitespace. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

export const questionSha = (q: { kind: string; rule_id?: string; exception_id?: string; instructions: string; criteria: Record<string, string> }): string =>
  sha256(canonical(q));
