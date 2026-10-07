// Cost accounting in micro-yuan (1e-6 CNY), integer. docs §2, §7.5.
export type Usage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export type PriceTable = {
  pricesVer: string;
  /** micro-yuan per 1M tokens, keyed `provider/model` (durable's pi.usage key) or bare model id */
  perMillion: Readonly<Record<string, { input: number; output: number; cacheRead?: number }>>;
};

export function microOfUsage(prices: PriceTable, key: string, usage: Usage): number {
  const bare = key.split("/").pop() ?? key;
  const p = prices.perMillion[key] ?? prices.perMillion[bare] ?? Object.entries(prices.perMillion).find(([k]) => k.endsWith(`/${bare}`))?.[1];
  if (!p) throw new Error(`no price for ${key} in ${prices.pricesVer}`);
  const cacheRead = usage.cacheRead ?? 0;
  const inputBillable = Math.max(0, usage.input - cacheRead);
  return Math.round((inputBillable * p.input + cacheRead * (p.cacheRead ?? p.input) + usage.output * p.output) / 1_000_000);
}

/** Sum of durable's pi.usage.models bucket. */
export function microOfModels(prices: PriceTable, models: Readonly<Record<string, Usage>>): number {
  let total = 0;
  for (const [key, u] of Object.entries(models)) total += microOfUsage(prices, key, u);
  return total;
}

export const yuan = (micro: number): string => (micro / 1_000_000).toFixed(4);
