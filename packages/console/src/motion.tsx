// Motion helpers, kept small and optional: numbers that roll to their new value, "which rows are new since the last
// render" for list entrance highlights, and a stagger index for items that were already there when a view opened.
// Everything respects prefers-reduced-motion (numbers jump, CSS animations are switched off in styles.css).
import { useEffect, useRef, useState } from "react";

const reduced = (): boolean => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

/** A number that rolls from its previous value to the new one (ease-out, `ms` long). */
export function AnimatedNumber({ value, format = (x) => String(Math.round(x)), ms = 650 }: { value: number; format?: (x: number) => string; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef(0);
  useEffect(() => {
    const start = from.current;
    if (start === value || reduced()) { from.current = value; setShown(value); return; }
    const t0 = performance.now();
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      const v = start + (value - start) * e;
      from.current = v;
      setShown(v);
      if (k < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [value, ms]);
  return <span className="num">{format(shown)}</span>;
}

/** Ids that appeared in the list within the last `ms` (empty on the first render and right after the list switched
 *  to another query, so opening a page or changing a filter does not flash every row). */
export function useFreshIds(ids: readonly string[] | null, scope = "", ms = 1600): Set<string> {
  const seen = useRef<{ scope: string; at: Map<string, number> } | null>(null);
  const now = Date.now();
  const fresh = new Set<string>();
  if (!ids) return fresh;
  if (!seen.current || seen.current.scope !== scope) {
    seen.current = { scope, at: new Map(ids.map((id) => [id, 0] as const)) };   // the first read of a list is not "new"
    return fresh;
  }
  const at = seen.current.at;
  for (const id of ids) {
    if (!at.has(id)) at.set(id, now);
    if (now - at.get(id)! < ms) fresh.add(id);
  }
  if (at.size > 4 * ids.length + 200) { const keep = new Set(ids); for (const k of [...at.keys()]) if (!keep.has(k)) at.delete(k); }
  return fresh;
}

/** How many items were present when the component mounted: those stagger in, later ones appear on their own. */
export function useInitialCount(n: number): number {
  const first = useRef<number | null>(null);
  if (first.current === null) first.current = n;
  return first.current;
}
