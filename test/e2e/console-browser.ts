// Browser-level smoke test of the web console in demo mode (headless Chromium via playwright-core): submit a sample and
// watch the live timeline, decide a human task, file an appeal, open a review's restricted view; with the demo traffic
// running: lists and overview numbers change on their own (no reload), new rows are highlighted, the simulated reviewer
// is marked, the traffic control pauses / resumes and switches rate tiers; the overview's pipeline and throughput are
// drawn and move; images: a preset screenshot and an uploaded file go through the timeline with the vision step; at the
// top tier (50 a second) the overview runs for 30 s while the frame rate and long tasks are measured; every page at
// 1440 / 1024 / 390 px in both themes passes the text-overflow audit (overflow.ts); the narrow-screen drawer
// navigates; reduced motion turns animations off.
// Fails on any page error or console error.
// Needs a browser once: node_modules/.bin/playwright-core install chromium-headless-shell (plus its system libraries;
// on a machine without them, LD_LIBRARY_PATH / FONTCONFIG_FILE can point at locally extracted copies).
// usage: node --experimental-strip-types --no-warnings test/e2e/console-browser.ts [--shots dir]   (pnpm run e2e:browser)
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { launchDemo } from "./launch.ts";
import { overflowIssues } from "./overflow.ts";

const shotsArg = process.argv.indexOf("--shots");
const shots = shotsArg >= 0 ? process.argv[shotsArg + 1] : undefined;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0, passed = 0;
const check = (name: string, ok: boolean, detail = ""): void => { if (ok) passed++; else failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`); };
const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };

const app = await launchDemo({ DEMO_AGENT_MS: "300", DEMO_JUDGE_MS: "150", DEMO_TRAFFIC_PER_SEC: "1", DEMO_SIM_MIN_AGE_MS: "4000", DEMO_SIM_THINK_MS: "1500" });
const fpsArg = process.argv.indexOf("--fps-secs");
const FPS_SECS = fpsArg >= 0 ? Number(process.argv[fpsArg + 1]) : 30;
/** A small PNG (8x8, made-up pixels). */
function tinyPng(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let x = 0xffffffff; for (const v of b) x = table[(x ^ v) & 255]! ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(25 * 8); for (let i = 0; i < raw.length; i++) raw[i] = (i * 13) % 256;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let imageContent = "";
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => void d.accept());

  // 1. submit a sample from the tracking page and watch it to the agent's ruling
  await page.goto(`${app.base}/#/track`);
  await page.getByText("演示示例").waitFor();
  await page.locator("button.sample", { hasText: "agent 查上下文后放行" }).click();
  await page.locator(".step .st", { hasText: "取线程上下文" }).first().waitFor({ timeout: 20_000 });
  check("agent steps appear while the review runs", true);
  await page.locator(".verdict").first().waitFor({ timeout: 20_000 });
  const verdict = await page.locator(".verdict").first().innerText();
  check("the ruling shows up live (agent pass)", verdict.includes("放行") && verdict.includes("agent"), verdict);
  check("judge score rows are drawn", (await page.locator(".prob").count()) >= 3);
  check("pipeline reaches the last stage", (await page.locator(".stage.done").count()) >= 4);
  await shot(page, "1-track-agent-pass");

  // 2. a sample the agent hands to a person; decide it on the human desk
  await page.locator("button.sample", { hasText: "证据不足，交人工" }).click();
  await page.getByRole("link", { name: "去人工复核" }).waitFor({ timeout: 20_000 });
  await shot(page, "2-track-to-human");
  await page.getByRole("link", { name: "去人工复核" }).click();
  await page.getByRole("button", { name: "领取", exact: true }).click();
  await page.getByText("我已领取").waitFor();
  await page.locator("textarea").first().fill("看过上下文，不针对个人");
  await shot(page, "3-human-claimed");
  await page.getByRole("button", { name: "提交裁决" }).click();
  await page.getByText("已提交：放行").waitFor();
  check("human decision submitted from the desk", true);

  // 3. appeal the content the agent took down earlier? use the list of disposed contents
  await page.goto(`${app.base}/#/appeals`);
  await page.getByText("最近已处置的内容").waitFor();
  await page.locator(".candidates tbody tr.click").filter({ hasNot: page.locator(".sim") }).first().click();   // one of this script's contents, not demo traffic
  await page.getByRole("button", { name: "提交申诉" }).click();
  await page.getByText("已受理").waitFor();
  check("appeal accepted", true);
  await page.locator("td", { hasText: "→" }).first().waitFor();
  await page.waitForTimeout(4000);
  await shot(page, "4-appeals");

  // 4. review list -> detail: demo mode shows the original text directly (no restricted button; G still audits the read)
  await page.goto(`${app.base}/#/reviews`);
  await page.locator(".table tbody tr.click").first().waitFor();
  check("review list has rows", (await page.locator(".table tbody tr.click").count()) >= 3);
  await shot(page, "5-reviews");
  await page.locator(".table tbody tr.click").last().click();
  await page.locator(".content-text").first().waitFor();
  check("demo detail shows the original text without a button", (await page.getByRole("button", { name: /查看原文与证据/ }).count()) === 0);
  await shot(page, "6-detail-open");

  // 4a. agent & harness page: a finished agent session replays step by step; the page ends with the next stop
  await page.goto(`${app.base}/#/agent`);
  await page.locator(".feed-box .step").first().waitFor({ timeout: 60_000 });
  check("agent page replays a session", (await page.locator(".loop li.on").count()) === 1);
  check("agent page links the next stop", (await page.locator("a.next-stop").count()) === 1);
  await shot(page, "6b-agent");

  // 4b. images: a preset screenshot (agent, then takedown) and an uploaded file (agent, then a person)
  await page.goto(`${app.base}/#/track`);
  await page.locator("button.img-sample", { hasText: "辱骂截图" }).click();
  await page.locator(".sec-h h3", { hasText: "视觉编码" }).first().waitFor({ timeout: 20_000 });
  await page.locator(".verdict").first().waitFor({ timeout: 20_000 });
  check("preset screenshot: thumbnail, vision step and demo note on the timeline", (await page.locator(".thumb img").count()) >= 1 && (await page.locator(".note-demo").first().innerText()).includes("演示模式"));
  check("preset screenshot: the agent takes it down", (await page.locator(".verdict").first().innerText()).includes("下架"));
  await shot(page, "4b-track-image-preset");
  await page.locator('input[type="file"]').setInputFiles({ name: "随手一张.png", mimeType: "image/png", buffer: tinyPng() });
  await page.locator(".picked").waitFor();
  check("picked image previewed before submitting", (await page.locator(".picked img").count()) === 1);
  await page.getByRole("button", { name: "提交并追踪" }).click();
  await page.getByRole("link", { name: "去人工复核" }).waitFor({ timeout: 30_000 });
  check("uploaded image: shown from this tab, goes agent -> person", (await page.locator(".thumb img").count()) >= 1 && (await page.locator(".stage", { hasText: "视觉编码" }).count()) === 1);
  imageContent = decodeURIComponent(page.url().split("/track/")[1] ?? "");
  await shot(page, "4c-track-image-upload");
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  check("a non-image file is refused before upload", (await page.locator(".alert.bad").first().innerText()).includes("仅支持"));

  // 5. overview and rules, light and dark
  await page.goto(`${app.base}/#/overview`);
  await page.getByText("用时、转人工与申诉").waitFor();
  await page.waitForTimeout(1500);
  check("pipeline drawn: canvas and seven nodes plus the appeal source", (await page.locator(".flow canvas.dots").count()) === 1 && (await page.locator(".fnode").count()) === 8);
  check("throughput curve drawn", (await page.locator(".tput path.ln").getAttribute("d"))?.startsWith("M") ?? false);
  const big = async (): Promise<number> => Number((await page.locator(".hero-big .v .num").innerText()).replace(/[^\d.]/g, ""));
  await page.waitForTimeout(2500);
  check(`headline throughput is live (${await big()} /s)`, (await big()) > 0);
  await shot(page, "7-overview");
  await page.goto(`${app.base}/#/rules`);
  await page.getByText("场景策略").waitFor();
  await shot(page, "8-rules");
  await page.getByRole("button", { name: "切换到深色" }).click();
  await page.goto(`${app.base}/#/track`);
  await page.locator("button.sample", { hasText: "注入不改变处置" }).click();
  await page.locator(".verdict").first().waitFor({ timeout: 20_000 });
  await shot(page, "9-track-dark");
  await page.goto(`${app.base}/#/overview`);
  await page.getByText("用时、转人工与申诉").waitFor();
  await page.waitForTimeout(1000);
  await shot(page, "10-overview-dark");
  check("dark theme applied", (await page.getAttribute("html", "data-theme")) === "dark");

  // 6. live updates without reloading: the overview count and the review list move on their own
  const kpi = async (): Promise<number> => Number((await page.locator(".kpi").first().locator(".kpi-v").innerText()).replace(/\D/g, ""));
  const before = await kpi();
  await page.waitForTimeout(6000);
  check(`overview count moves without reload (${before} -> ${await kpi()})`, (await kpi()) > before);
  await page.goto(`${app.base}/#/reviews`);
  await page.locator(".table tbody tr.click").first().waitFor();
  const firstRow = async (): Promise<string> => page.locator(".table tbody tr.click").first().locator(".id").first().getAttribute("title").then((x) => x ?? "");
  const top = await firstRow();
  await page.locator(".table tbody tr.fresh").first().waitFor({ timeout: 15_000 });
  check("review list gets new rows on its own, highlighted", (await firstRow()) !== top);
  // the simulated reviewer works on simulated tasks and is marked as such
  await page.goto(`${app.base}/#/human`);
  await page.getByRole("tab", { name: "已完成" }).click();
  // (the open list stays on screen until the closed one is read, so wait for the reviewer's name itself)
  const bySim = page.locator("td", { hasText: "sim-reviewer" }).first();
  await bySim.waitFor({ timeout: 30_000 });
  check("simulated reviewer's decisions are marked", (await bySim.locator(".sim").count()) === 1);
  // traffic control: pause stops new contents, resume starts them again
  await page.getByRole("button", { name: "暂停模拟流量" }).click();
  await page.getByRole("button", { name: "继续模拟流量" }).waitFor();
  const gen = async (): Promise<number> => ((await (await fetch(`${app.base}/api/demo/traffic`)).json()) as { generated: number }).generated;
  const g0 = await gen();
  await page.waitForTimeout(3000);
  check("pausing the traffic stops it", (await gen()) === g0);
  await page.getByRole("button", { name: "继续模拟流量" }).click();
  await page.getByRole("button", { name: "暂停模拟流量" }).waitFor();
  await page.getByRole("radio", { name: "每秒 20 条" }).click();
  await page.waitForTimeout(500);
  const st = (await (await fetch(`${app.base}/api/demo/traffic`)).json()) as { per_sec: number };
  check(`rate tier from the top bar (${st.per_sec}/s)`, st.per_sec === 20);
  await page.locator(".traffic .tiers button.on", { hasText: "20" }).waitFor();

  // 6b. top tier: the overview runs for FPS_SECS seconds; frames and long tasks are counted in the page
  await fetch(`${app.base}/api/demo/traffic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ per_sec: 50 }) });
  await page.goto(`${app.base}/#/overview`);
  await page.locator(".flow canvas.dots").waitFor();
  await page.waitForTimeout(3000);
  const perf = await page.evaluate(async (secs: number) => {
    let frames = 0, worst = 0, last = performance.now();
    const long: number[] = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(e.duration); });
    try { po.observe({ type: "longtask", buffered: false }); } catch { /* not supported */ }
    const gaps: number[] = [];
    await new Promise<void>((done) => {
      const end = performance.now() + secs * 1000;
      const tick = (t: number): void => { frames++; gaps.push(t - last); worst = Math.max(worst, t - last); last = t; if (t < end) requestAnimationFrame(tick); else done(); };
      requestAnimationFrame(tick);
    });
    po.disconnect();
    gaps.sort((a, b) => a - b);
    return { fps: frames / secs, p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0, worst, long: long.length, longMs: long.reduce((a, b) => a + b, 0), dots: document.querySelectorAll(".feed-row").length };
  }, FPS_SECS);
  console.log(`     top tier, ${FPS_SECS} s on the overview: ${perf.fps.toFixed(1)} fps, frame gap p95 ${perf.p95.toFixed(1)} ms, worst ${perf.worst.toFixed(0)} ms, long tasks ${perf.long} (${perf.longMs.toFixed(0)} ms)`);
  check(`overview stays smooth at 50/s (${perf.fps.toFixed(1)} fps, p95 frame gap ${perf.p95.toFixed(0)} ms)`, perf.fps >= 24 && perf.p95 < 80);
  check(`latest-review list stays bounded (${perf.dots} rows)`, perf.dots <= 9);
  await shot(page, "11-overview-top-tier");
  await fetch(`${app.base}/api/demo/traffic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ per_sec: 5 }) });

  // 7. text-overflow audit: every page, three widths, both themes
  const ids = { detail: (await (await fetch(`${app.base}/api/review-list?limit=1&route=agent`)).json() as { items: { content_id: string }[] }).items[0]?.content_id ?? "" };
  const pages = ["overview", "track", `track/${encodeURIComponent(imageContent)}`, "reviews", `contents/${encodeURIComponent(ids.detail)}`, "human", "appeals", "rules"];
  const problems: string[] = [];
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 1024, 390]) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, locale: "zh-CN", colorScheme: theme });
      const p = await ctx.newPage();
      p.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      for (const name of pages) {
        await p.goto(`${app.base}/#/${name}`);
        await p.waitForTimeout(1200);
        for (const i of await overflowIssues(p)) problems.push(`${name} ${width} ${theme}: ${i.kind} ${i.px}px ${i.what} "${i.text}"`);
      }
      if (width === 390) {
        await p.getByRole("button", { name: "打开菜单" }).click();
        await p.locator(".side.open").getByRole("link", { name: "审次" }).click();
        await p.locator(".side:not(.open)").waitFor();
        check(`narrow drawer navigates (${theme})`, p.url().endsWith("#/reviews"));
      }
      await ctx.close();
    }
  }
  check(`no clipped or spilling text on any page (${pages.length} pages x 3 widths x 2 themes)`, problems.length === 0, problems.slice(0, 20).join("\n"));

  // 8. reduced motion: animations are switched off
  const rm = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  const rp = await rm.newPage();
  await rp.goto(`${app.base}/#/overview`);
  await rp.locator(".page").waitFor();
  const dur = await rp.locator(".page").evaluate((el) => getComputedStyle(el).animationDuration);
  check(`prefers-reduced-motion turns animations off (${dur})`, parseFloat(dur) < 0.01);
  await rm.close();
  check("no page or console errors", errors.length === 0, errors.join("\n"));
} catch (e) {
  failed++;
  console.error("FAIL unexpected error", e);
} finally {
  await browser?.close();
  await app.stop();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
