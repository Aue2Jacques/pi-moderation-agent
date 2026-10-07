// Redaction for logs, traces, dashboards and ordinary API responses (docs §13.4).
// Any key in RESTRICTED_KEYS is replaced by "[TEXT len=N sha=XXXX]".
import { sha256 } from "./ids.ts";

export const RESTRICTED_KEYS: ReadonlySet<string> = new Set(["text", "body", "reason", "content", "summary", "model_view", "modelView"]);

export function redactString(s: string): string {
  return `[TEXT len=${s.length} sha=${sha256(s).slice(0, 8)}]`;
}

export function redact<T>(value: T): T {
  return walk(value, false) as T;
}

function walk(v: unknown, restricted: boolean): unknown {
  if (typeof v === "string") return restricted ? redactString(v) : v;
  if (Array.isArray(v)) return v.map((x) => walk(x, restricted));
  if (v instanceof Error) return { name: v.name, message: redactString(v.message) };
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, restricted || RESTRICTED_KEYS.has(k));
    return out;
  }
  return v;
}
