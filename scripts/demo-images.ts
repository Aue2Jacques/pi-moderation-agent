// Renders the demo's preset "comment screenshots" (demo/images/*.png): a white comment card with an avatar placeholder,
// a made-up name and a short made-up comment, 480 px wide (the width the Kev image tests found fastest at the same
// accuracy, reports/2026-10-09-kev-inference-speed.md §11). The texts are the ones in DEMO_IMAGE_SAMPLES
// (packages/worker/src/demo.ts), which the demo's scripted judge uses as the screenshot's known content.
// Fonts: whatever sans-serif CJK font the local Chromium finds (here WenQuanYi Micro Hei); the images are generated
// once and committed, no font file is shipped.
// usage: node --experimental-strip-types --no-warnings scripts/demo-images.ts   (needs playwright-core's Chromium)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { DEMO_IMAGE_SAMPLES } from "../packages/worker/src/demo.ts";

const OUT = join(import.meta.dirname, "..", "demo", "images");
mkdirSync(OUT, { recursive: true });
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const card = (x: (typeof DEMO_IMAGE_SAMPLES)[number]): string => `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #ffffff; font-family: "WenQuanYi Micro Hei", "Noto Sans CJK SC", sans-serif; color: #18191c; }
  .c { width: 480px; box-sizing: border-box; padding: 18px 20px 16px; display: grid; grid-template-columns: 40px 1fr; gap: 0 12px; }
  .av { width: 40px; height: 40px; border-radius: 50%; background: ${x.avatar}; }
  .n { font-size: 14px; color: #61666d; margin: 2px 0 6px; }
  .t { font-size: 17px; line-height: 1.6; }
  .m { font-size: 12.5px; color: #9499a0; margin-top: 10px; display: flex; gap: 18px; }
</style></head><body><div class="c"><div class="av"></div><div><div class="n">${esc(x.name)}</div><div class="t">${esc(x.screenshot)}</div>
  <div class="m"><span>${esc(x.when)}</span><span>赞 ${x.likes}</span><span>回复</span></div></div></div></body></html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 480, height: 200 }, deviceScaleFactor: 1 });
for (const x of DEMO_IMAGE_SAMPLES) {
  await page.setContent(card(x));
  await page.locator(".c").screenshot({ path: join(OUT, x.file) });
  console.log(`demo/images/${x.file}`);
}
await browser.close();
