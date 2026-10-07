// Append-only audit with hash chain (docs §2.2). Call inside a transaction.
import type { Db } from "./db.ts";
import { sha256 } from "./ids.ts";

export function appendAudit(db: Db, kind: string, refId: string, actor: string, payload: unknown, at: number): void {
  const last = db.prepare("SELECT hash FROM audit ORDER BY audit_id DESC LIMIT 1").get() as { hash: string } | undefined;
  const prev = last?.hash ?? "genesis";
  const body = JSON.stringify(payload);
  const hash = sha256(prev + kind + refId + actor + body + String(at));
  db.prepare("INSERT INTO audit(kind, ref_id, actor, payload, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?,?)").run(kind, refId, actor, body, prev, hash, at);
}

/** Recompute the chain; returns the first broken audit_id or null. */
export function verifyAuditChain(db: Db): number | null {
  const rows = db.prepare("SELECT audit_id, kind, ref_id, actor, payload, prev_hash, hash, created_at FROM audit ORDER BY audit_id").all() as {
    audit_id: number; kind: string; ref_id: string; actor: string; payload: string; prev_hash: string; hash: string; created_at: number;
  }[];
  let prev = "genesis";
  for (const r of rows) {
    if (r.prev_hash !== prev) return r.audit_id;
    if (sha256(prev + r.kind + r.ref_id + r.actor + r.payload + String(r.created_at)) !== r.hash) return r.audit_id;
    prev = r.hash;
  }
  return null;
}
