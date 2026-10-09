/// <reference lib="dom" />
// Text-overflow audit run inside the page (playwright `page.evaluate`): finds text that is cut off or spills out of
// its box. Reported: the page scrolls sideways; an element sticks out of the viewport (outside any scroll container);
// text clipped by overflow / ellipsis / line clamp with no `title` to read it from; text wider than its box that
// spills over its neighbours. Shared by the browser smoke test and the screenshot review.
import type { Page } from "playwright-core";

export type OverflowIssue = { kind: "page-x" | "off-screen" | "clipped" | "spill"; what: string; text: string; px: number };

/** Runs in the browser; must not reference anything outside its own body. */
function audit(): OverflowIssue[] {
  const out: OverflowIssue[] = [];
  const vw = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > vw + 1) out.push({ kind: "page-x", what: "document", text: "", px: document.documentElement.scrollWidth - vw });
  const describe = (el: Element): string => {
    const cls = typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    const parent = el.parentElement;
    const pcls = parent && typeof parent.className === "string" && parent.className ? `.${parent.className.trim().split(/\s+/)[0]}` : "";
    return `${parent?.tagName.toLowerCase() ?? ""}${pcls} > ${el.tagName.toLowerCase()}${cls}`;
  };
  const scrolls = (el: Element): boolean => { const o = getComputedStyle(el).overflowX; return o === "auto" || o === "scroll"; };
  const inScroller = (el: Element): boolean => { for (let p = el.parentElement; p; p = p.parentElement) if (scrolls(p)) return true; return false; };
  const hidden = (el: Element): boolean => { for (let p: Element | null = el; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true; } return false; };
  for (const el of Array.from(document.querySelectorAll("body *"))) {
    if (el instanceof SVGElement || el.tagName === "OPTION" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.tagName === "INPUT") continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (r.right > vw + 1 && !inScroller(el) && !el.closest(".side:not(.open)") && !hidden(el)) out.push({ kind: "off-screen", what: describe(el), text: text.slice(0, 40), px: Math.round(r.right - vw) });
    const clipping = cs.overflowX === "hidden" || cs.overflowX === "clip" || cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none");
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim());
    if (clipping && !scrolls(el) && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2) && !el.closest("[title]") && !hidden(el)) {
      out.push({ kind: "clipped", what: describe(el), text: text.slice(0, 40), px: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight) });
    } else if (own && cs.display !== "inline" && cs.overflowX === "visible" && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && !hidden(el)) {
      out.push({ kind: "spill", what: describe(el), text: text.slice(0, 40), px: el.scrollWidth - el.clientWidth });
    }
  }
  return out;
}

export async function overflowIssues(page: Page): Promise<OverflowIssue[]> {
  return page.evaluate(audit);
}
