// Temperature scaling and ECE (docs §9.2). Pure.
export type Probs = Record<string, number>;

export function applyTemperature(probs: Probs, T: number): Probs {
  const keys = Object.keys(probs);
  const logits = keys.map((k) => Math.log(Math.max(probs[k]!, 1e-12)) / T);
  const m = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - m));
  const z = exps.reduce((a, b) => a + b, 0);
  const out: Probs = {};
  keys.forEach((k, i) => { out[k] = exps[i]! / z; });
  return out;
}

export type Sample = { probs: Probs; label: string };

/** Grid-search T in [0.25, 8] minimizing NLL on the dev set. Returns T and NLL before/after. */
export function fitTemperature(samples: readonly Sample[]): { T: number; nllBefore: number; nllAfter: number } {
  const nll = (T: number): number => {
    let s = 0;
    for (const x of samples) s -= Math.log(Math.max(applyTemperature(x.probs, T)[x.label] ?? 1e-12, 1e-12));
    return s / samples.length;
  };
  let best = 1;
  let bestNll = nll(1);
  for (let t = 0.25; t <= 8.0001; t *= 1.05) {
    const v = nll(t);
    if (v < bestNll - 1e-12) { bestNll = v; best = t; }
  }
  return { T: Number(best.toFixed(4)), nllBefore: nll(1), nllAfter: bestNll };
}

/** Expected calibration error on the max-probability prediction, `bins` equal-width bins. */
export function ece(samples: readonly Sample[], bins = 15): number {
  const acc = new Array<number>(bins).fill(0);
  const conf = new Array<number>(bins).fill(0);
  const cnt = new Array<number>(bins).fill(0);
  for (const x of samples) {
    const [pred, p] = Object.entries(x.probs).reduce((a, b) => (b[1] > a[1] ? b : a));
    const b = Math.min(bins - 1, Math.floor(p * bins));
    cnt[b]!++;
    conf[b]! += p;
    acc[b]! += pred === x.label ? 1 : 0;
  }
  let e = 0;
  for (let b = 0; b < bins; b++) if (cnt[b]! > 0) e += (cnt[b]! / samples.length) * Math.abs(acc[b]! / cnt[b]! - conf[b]! / cnt[b]!);
  return e;
}

export type CalibFile = { T: number; n: number; ece_before: number; ece_after: number; fitted_at: number; bucket: { judge: string; rules_ver: string; scene: string; n_options: number } };
export const calibKey = (b: CalibFile["bucket"]): string => `${b.judge}|${b.rules_ver}|${b.scene}|${b.n_options}`;

// ---------- runtime calibrators (round-9 item 5) ----------
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CalibBucket, Calibrator } from "@mod/core";

const bucketKey = (b: CalibBucket): string => calibKey({ judge: b.judge, rules_ver: b.rulesVer, scene: b.scene, n_options: b.nOptions });

/** Explicit smoke mode: raw probabilities copied through, pinned as calib@identity. Never the default. */
export function identityCalibrator(): Calibrator {
  return { calibVer: "calib@identity", mode: "identity", apply: (_b, raw) => ({ probs: { ...raw }, temperature: 1 }) };
}

/** Strict mode with no files at all: every answer stays uncalibrated → only "suspicious" decisions are possible. */
export function noCalibrator(): Calibrator {
  return { calibVer: "calib@none", mode: "strict", apply: () => null };
}

/**
 * Strict mode from fitted files `<dir>/<judge>/*.json` (CalibFile). calibVer = sha of all file contents, so changing or
 * deleting a file changes the pin and old reviews stop matching. Missing bucket → null.
 */
export function loadCalibrator(dir: string, judge: string): Calibrator {
  const files = new Map<string, CalibFile>();
  const h = createHash("sha256");
  const sub = join(dir, judge);
  let names: string[] = [];
  try { if (statSync(sub).isDirectory()) names = readdirSync(sub).filter((f) => f.endsWith(".json")).sort(); } catch { names = []; }
  for (const f of names) {
    const raw = readFileSync(join(sub, f), "utf8");
    h.update(`${f}\n${raw}\n`);
    const c = JSON.parse(raw) as CalibFile;
    if (typeof c.T !== "number" || !(c.T > 0) || !c.bucket) throw new Error(`bad calib file ${f}`);
    files.set(calibKey(c.bucket), c);
  }
  if (files.size === 0) return noCalibrator();
  return {
    calibVer: `calib@${h.digest("hex").slice(0, 12)}`,
    mode: "strict",
    apply: (b, raw) => {
      const c = files.get(bucketKey(b));
      return c ? { probs: applyTemperature(raw as Probs, c.T), temperature: c.T } : null;
    },
  };
}
