// Small data hooks: hash routing, polling fetch, server-sent events.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "./api.ts";

export function useHashRoute(): [string[], (path: string) => void] {
  const read = (): string[] => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState<string[]>(read);
  useEffect(() => {
    const on = (): void => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((path: string) => { window.location.hash = path.startsWith("#") ? path : `#${path}`; }, []);
  return [parts, go];
}

export type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** GET `path` now and every `intervalMs` (0: once). A null path waits. The last good value stays while reloading. */
export function usePoll<T>(path: string | null, intervalMs = 0, headers?: Record<string, string>): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const hdr = JSON.stringify(headers ?? {});
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = (): void => {
      setLoading(true);
      api.get<T>(path, JSON.parse(hdr) as Record<string, string>)
        .then((v) => { if (alive) { setData(v); setError(null); } })
        .catch((e) => { if (alive) setError(errText(e)); })
        .finally(() => { if (alive) setLoading(false); });
    };
    load();
    const t = intervalMs > 0 ? setInterval(load, intervalMs) : undefined;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [path, intervalMs, hdr, tick]);
  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}

/** Subscribe to an SSE endpoint; `event` names the event type (default: unnamed messages). */
export function useEventSource<T>(path: string | null, event?: string): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  const ref = useRef<EventSource | null>(null);
  useEffect(() => {
    setData(null);
    if (!path) return;
    const es = new EventSource(path);
    ref.current = es;
    const on = (e: MessageEvent<string>): void => { try { setData(JSON.parse(e.data) as T); } catch { /* ignore a malformed frame */ } };
    if (event) es.addEventListener(event, on as EventListener); else es.onmessage = on;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => { es.close(); ref.current = null; setConnected(false); };
  }, [path, event]);
  return { data, connected };
}

/** Current time, refreshed every `ms` (for relative times and SLA countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
