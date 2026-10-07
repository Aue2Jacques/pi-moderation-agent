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
