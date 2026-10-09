// Motion helpers, kept small and optional: numbers that roll to their new value, "which rows are new since the last
// render" for list entrance highlights, and a stagger index for items that were already there when a view opened.
// Everything respects prefers-reduced-motion (numbers jump, CSS animations are switched off in styles.css).
import { useEffect, useRef } from "react";

export const prefersReducedMotion = (): boolean => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
const reduced = prefersReducedMotion;

/** A number that rolls from its previous value to the new one (ease-out, `ms` long). The rolling frames write the
 *  text directly, so a screen full of moving numbers does not re-render React sixty times a second. */
export function AnimatedNumber({ value, format = (x) => String(Math.round(x)), ms = 650 }: { value: number; format?: (x: number) => string; ms?: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const from = useRef(value);
  const fmt = useRef(format);
  fmt.current = format;
  useEffect(() => {
    const node = el.current;
    const start = from.current;
    if (!node) return;
    // write into React's own text node, so a later render keeps updating the same node
    const put = (v: number): void => { const t = node.firstChild; if (t && t.nodeType === 3) t.nodeValue = fmt.current(v); else node.textContent = fmt.current(v); };
    if (start === value || reduced()) { from.current = value; put(value); return; }
    const t0 = performance.now();
    let frame = 0;
    const step = (t: number): void => {
      const k = Math.min(1, (t - t0) / ms);
      const v = start + (value - start) * (1 - Math.pow(1 - k, 3));
      from.current = v;
      put(v);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, ms]);
  return <span ref={el} className="num">{format(from.current)}</span>;
}

/** Ids that appeared in the list within the last `ms` (empty on the first render and right after the list switched
 *  to another query, so opening a page or changing a filter does not flash every row). More than `max` new ids at once
 *  (a busy stream replacing most of a page): none are marked, so a whole table does not repaint its highlight. */
export function useFreshIds(ids: readonly string[] | null, scope = "", ms = 1600, max = 8): Set<string> {
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
  return fresh.size > max ? new Set() : fresh;
}

/** How many items were present when the component mounted: those stagger in, later ones appear on their own. */
export function useInitialCount(n: number): number {
  const first = useRef<number | null>(null);
  if (first.current === null) first.current = n;
  return first.current;
}
