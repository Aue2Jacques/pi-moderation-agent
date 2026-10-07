// Error codes: docs/dev-doc-v1.md §5.5.
export const ERROR_CODES = {
  E_REVIEW_NOT_FOUND: 404,
  E_STATE_INVALID: 409,
  E_REQUEST_CONFLICT: 409,
  E_LEASE_HELD: 409,
  E_LEASE_LOST: 409,
  E_ATTEMPT_STALE: 409,
  E_DEADLINE_PASSED: 409,
  E_BUDGET_EXCEEDED: 409,
  E_BUDGET_COST: 409,
  E_VERSION_MISMATCH: 409,
  E_RULE_UNKNOWN: 422,
  E_ACTION_NOT_ALLOWED: 422,
  E_EVIDENCE_FOREIGN: 422,
  E_JUDGE_FOREIGN: 422,
  E_ACTION_NOT_SUPPORTED: 422,
  E_HUMAN_AUTH: 401,
  E_JUDGE_UNAVAILABLE: 503,
  E_BACKPRESSURE: 429,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class CoreError extends Error {
  readonly code: ErrorCode;
  readonly http: number;
  readonly detail: Record<string, unknown>;
  constructor(code: ErrorCode, message?: string, detail: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "CoreError";
    this.code = code;
    this.http = ERROR_CODES[code];
    this.detail = detail;
  }
}

export const isCoreError = (e: unknown): e is CoreError => e instanceof CoreError;

export type Result<T> = { ok: true; value: T } | { ok: false; code: ErrorCode; message: string; detail: Record<string, unknown> };

export function attempt<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    if (isCoreError(e)) return { ok: false, code: e.code, message: e.message, detail: e.detail };
    throw e;
  }
}
