// Live state of the whole console from G's global stream (GET /api/events): one EventSource per tab, shared through
// context. The overview reads stats straight from the latest frame; lists re-read their own query only when the
// frame's counter for that list changed (useLiveQuery), so nothing polls on a timer and nothing reloads the page.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, errText, type LiveFrame, type ReviewListItem } from "./api.ts";

export type LiveState = {
  frame: LiveFrame | null;
  connected: boolean;
  /** latest reviews seen on the stream (snapshot + changes), newest first */
  recent: ReviewListItem[];
};

const LiveCtx = createContext<LiveState>({ frame: null, connected: false, recent: [] });
export const useLive = (): LiveState => useContext(LiveCtx);

const RECENT_MAX = 40;

/** Upsert changed rows into the recent list (newest created first). A snapshot replaces the list. */
export function mergeRecent(prev: ReviewListItem[], changed: ReviewListItem[], snapshot: boolean): ReviewListItem[] {
  const m = new Map((snapshot ? [] : prev).map((r) => [r.review_id, r] as const));
  for (const r of changed) m.set(r.review_id, r);
  return [...m.values()].sort((a, b) => b.created_at - a.created_at || (a.review_id < b.review_id ? 1 : -1)).slice(0, RECENT_MAX);
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LiveState>({ frame: null, connected: false, recent: [] });
  useEffect(() => {
    const es = new EventSource("/api/events");
    const on = (e: MessageEvent<string>): void => {
      let f: LiveFrame;
      try { f = JSON.parse(e.data) as LiveFrame; } catch { return; }
      setState((s) => ({ frame: f, connected: true, recent: mergeRecent(s.recent, f.changed, f.snapshot) }));
    };
    es.addEventListener("live", on as EventListener);
    es.onopen = () => setState((s) => ({ ...s, connected: true }));
    es.onerror = () => setState((s) => ({ ...s, connected: false }));   // EventSource reconnects by itself; G sends a snapshot again
    return () => es.close();
  }, []);
  return <LiveCtx.Provider value={state}>{children}</LiveCtx.Provider>;
}

export type LiveQuery<T> = { data: T | null; error: string | null; reload: () => void };

/**
 * GET `path` now, and again whenever `version` changes — at most once per `minGapMs` (a burst of changes becomes one
 * read). A changed path (other filters, another page) reads at once. The last good value stays while re-reading.
 */
export function useLiveQuery<T>(path: string | null, version: string | undefined, headers?: Record<string, string>, minGapMs = 1000): LiveQuery<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const last = useRef<{ path: string | null; at: number }>({ path: null, at: 0 });
  const hdr = JSON.stringify(headers ?? {});
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = (): void => {
      last.current = { path, at: Date.now() };
      api.get<T>(path, JSON.parse(hdr) as Record<string, string>)
        .then((v) => { if (alive) { setData(v); setError(null); } })
        .catch((e) => { if (alive) setError(errText(e)); });
    };
    const wait = last.current.path === path ? Math.max(0, minGapMs - (Date.now() - last.current.at)) : 0;
    const t = setTimeout(load, wait);
    return () => { alive = false; clearTimeout(t); };
  }, [path, version, hdr, tick, minGapMs]);
  // a reload after the user's own action reads at once
  return { data, error, reload: () => { last.current.at = 0; setTick((x) => x + 1); } };
}
