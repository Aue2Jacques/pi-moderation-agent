// Deterministic preprocessing (docs 附录 W §6.1): normalization, exact blacklist (Aho-Corasick-lite via Set scan),
// simhash near-duplicate lookup, per-account rate limit. No model calls here.
import { sha256 } from "@mod/core";

export function normalizeText(s: string): string {
  return s
    .normalize("NFKC")                         // full-width → half-width, compatibility forms
    .replace(/[​-‏⁠﻿]/g, "") // zero-width
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Exact multi-pattern match. Patterns are short; a Set scan over substrings of bounded length is enough for MVP. */
export class Blacklist {
  readonly #byLen = new Map<number, Set<string>>();
  readonly #maxLen: number;
  constructor(words: readonly string[]) {
    let max = 0;
    for (const w of words) {
      const n = normalizeText(w);
      if (!n) continue;
      max = Math.max(max, n.length);
      let s = this.#byLen.get(n.length);
      if (!s) { s = new Set(); this.#byLen.set(n.length, s); }
      s.add(n);
    }
    this.#maxLen = max;
  }
  hits(text: string): string[] {
    const t = normalizeText(text);
    const out = new Set<string>();
    for (const [len, set] of this.#byLen) {
      if (len > t.length) continue;
      for (let i = 0; i + len <= t.length; i++) {
        const sub = t.slice(i, i + len);
        if (set.has(sub)) out.add(sub);
      }
    }
    return [...out];
  }
  get maxLen(): number { return this.#maxLen; }
}

/** 64-bit simhash over character unigrams + bigrams (CJK-friendly; unigrams keep short texts stable under one-char edits). Returns a 16-hex string. */
export function simhash(text: string): string {
  const t = normalizeText(text);
  const grams: string[] = [];
  for (let i = 0; i < t.length; i++) grams.push(`u:${t[i]!}`);
  for (let i = 0; i + 1 < t.length; i++) grams.push(`b:${t.slice(i, i + 2)}`);
  if (grams.length === 0 && t.length) grams.push(t);
  const v = new Array<number>(64).fill(0);
  for (const g of grams) {
    const h = sha256(g).slice(0, 16);
    const hi = parseInt(h.slice(0, 8), 16);
    const lo = parseInt(h.slice(8, 16), 16);
    for (let b = 0; b < 32; b++) { v[b]! += (hi >>> b) & 1 ? 1 : -1; v[32 + b]! += (lo >>> b) & 1 ? 1 : -1; }
  }
  let hi = 0, lo = 0;
  for (let b = 0; b < 32; b++) { if (v[b]! > 0) hi |= 1 << b; if (v[32 + b]! > 0) lo |= 1 << b; }
  return (hi >>> 0).toString(16).padStart(8, "0") + (lo >>> 0).toString(16).padStart(8, "0");
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = (parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) { d += x & 1; x >>>= 1; }
  }
  return d;
}

/** In-memory near-duplicate index over recent content (bounded). */
export class SimhashIndex {
  readonly #items: { id: string; h: string }[] = [];
  readonly #max: number;
  constructor(max = 50_000) { this.#max = max; }
  add(id: string, h: string): void {
    this.#items.push({ id, h });
    if (this.#items.length > this.#max) this.#items.shift();
  }
  nearest(h: string, maxDistance = 3, limit = 5): { id: string; distance: number }[] {
    const out: { id: string; distance: number }[] = [];
    for (const it of this.#items) {
      const d = hamming(it.h, h);
      if (d <= maxDistance) out.push({ id: it.id, distance: d });
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, limit);
  }
  get size(): number { return this.#items.length; }
}

/** Sliding-window per-account rate limit. */
export class RateLimit {
  readonly #events = new Map<string, number[]>();
  readonly maxPerWindow: number;
  readonly windowMs: number;
  constructor(maxPerWindow: number, windowMs: number) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
  }
  /** Returns true when the account is over the limit after recording this event. */
  hit(accountId: string, at: number): boolean {
    const arr = (this.#events.get(accountId) ?? []).filter((t) => t > at - this.windowMs);
    arr.push(at);
    this.#events.set(accountId, arr);
    return arr.length > this.maxPerWindow;
  }
}

export type PreprocessResult = { normalized: string; textSha: string; blacklistHits: string[]; simhash: string; nearDuplicates: { id: string; distance: number }[]; rateLimited: boolean };

export function preprocess(text: string, accountId: string | null, at: number, deps: { blacklist: Blacklist; index: SimhashIndex; rate: RateLimit }, contentId: string): PreprocessResult {
  const normalized = normalizeText(text);
  const h = simhash(text);
  const nearDuplicates = deps.index.nearest(h);
  deps.index.add(contentId, h);
  return { normalized, textSha: sha256(normalized), blacklistHits: deps.blacklist.hits(text), simhash: h, nearDuplicates, rateLimited: accountId ? deps.rate.hit(accountId, at) : false };
}
