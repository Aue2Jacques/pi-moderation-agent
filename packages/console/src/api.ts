// HTTP client for G's console API. Types come from the gateway (one definition for both sides).
export type * from "../../gateway/src/console-types.ts";
import type { ConsoleConfig } from "../../gateway/src/console-types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const b = (body ?? {}) as { code?: string; message?: string; detail?: unknown };
    throw new ApiError(res.status, b.code ?? `HTTP_${res.status}`, b.message ?? b.code ?? res.statusText, b.detail);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, headers: Record<string, string> = {}): Promise<T> => fetch(path, { headers }).then((r) => handle<T>(r)),
  post: <T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> =>
    fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then((r) => handle<T>(r)),
};

// ---------- reviewer identity ----------
// Demo mode: the gateway hands out the demo reviewer's credentials (config.demo_auth). Real mode: the reviewer signs in
// once per tab; the token stays in sessionStorage only.

export type Reviewer = { reviewer: string; token: string };
const KEY = "console.reviewer";

export function loadReviewer(cfg: ConsoleConfig | null): Reviewer | null {
  if (cfg?.demo_auth) return cfg.demo_auth;
  try { const v = sessionStorage.getItem(KEY); return v ? (JSON.parse(v) as Reviewer) : null; } catch { return null; }
}
export function saveReviewer(r: Reviewer | null): void {
  try { if (r) sessionStorage.setItem(KEY, JSON.stringify(r)); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable: keep it in memory only */ }
}
export const authHeaders = (r: Reviewer): Record<string, string> => ({ authorization: `Bearer ${r.token}`, "x-reviewer": r.reviewer });

/** Error text for a failed call: code + message, in one line. */
export const errText = (e: unknown): string => (e instanceof ApiError ? `${e.code}${e.message && e.message !== e.code ? `：${e.message}` : ""}` : e instanceof Error ? e.message : String(e));
