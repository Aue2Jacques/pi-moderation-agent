// Release gate binding (docs §10): rollout is allowed only when a passed gate_run exists for the exact config sha.
import { tx, type Db } from "./db.ts";
import { canonical, sha256 } from "./ids.ts";

export type GateConfig = { rulesVer: string; calibVer: string; judgeModel: string; agentModel: string; pricesVer: string };
export const configSha = (c: GateConfig): string => sha256(canonical(c));

export function recordGateRun(db: Db, id: string, cfg: GateConfig, passed: boolean, report: unknown, at: number): void {
  tx(db, () => db.prepare("INSERT OR IGNORE INTO gate_run(gate_run_id, config_sha, passed, report, created_at) VALUES (?,?,?,?,?)").run(id, configSha(cfg), passed ? 1 : 0, JSON.stringify(report), at));
}

export function gateAllows(db: Db, cfg: GateConfig): boolean {
  return !!db.prepare("SELECT 1 FROM gate_run WHERE config_sha=? AND passed=1 LIMIT 1").get(configSha(cfg));
}

export function setRollout(db: Db, kind: string, version: string, sha: string, pct: number, at: number): void {
  tx(db, () => db.prepare("INSERT INTO version_pin(kind, version, sha, loaded_at, rollout_pct) VALUES (?,?,?,?,?) ON CONFLICT(kind, version) DO UPDATE SET rollout_pct=excluded.rollout_pct, loaded_at=excluded.loaded_at").run(kind, version, sha, at, pct));
}
