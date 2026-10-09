// Browser-level smoke test of the web console in demo mode (headless Chromium via playwright-core): submit a sample and
// watch the live timeline, decide a human task, file an appeal, open a review's restricted view; with the demo traffic
// running: lists and overview numbers change on their own (no reload), new rows are highlighted, the simulated reviewer
// is marked, the traffic control pauses / resumes; every page at 1440 / 1024 / 390 px in both themes passes the
// text-overflow audit (overflow.ts); the narrow-screen drawer navigates; reduced motion turns animations off.
// Fails on any page error or console error.
// Needs a browser once: node_modules/.bin/playwright-core install chromium-headless-shell (plus its system libraries;
// on a machine without them, LD_LIBRARY_PATH / FONTCONFIG_FILE can point at locally extracted copies).
// usage: node --experimental-strip-types --no-warnings test/e2e/console-browser.ts [--shots dir]   (pnpm run e2e:browser)
import { mkdirSync } from "node:fs";
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

const app = await launchDemo({ DEMO_AGENT_MS: "300", DEMO_JUDGE_MS: "150", DEMO_TRAFFIC_PER_MIN: "60", DEMO_SIM_MIN_AGE_MS: "4000", DEMO_SIM_THINK_MS: "1500" });
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
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

  // 4. review list -> detail -> restricted view (confirm dialog accepted, audited server side)
  await page.goto(`${app.base}/#/reviews`);
  await page.locator(".table tbody tr.click").first().waitFor();
  check("review list has rows", (await page.locator(".table tbody tr.click").count()) >= 3);
  await shot(page, "5-reviews");
  await page.locator(".table tbody tr.click").last().click();
  await page.getByRole("button", { name: /查看原文与证据/ }).click();
  await page.getByText("受限视图：原文").waitFor();
  check("restricted view shows the original text", true);
  await shot(page, "6-detail-restricted");

  // 5. overview and rules, light and dark
  await page.goto(`${app.base}/#/overview`);
  await page.getByText("各路占比").waitFor();
  await page.waitForTimeout(1500);
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
  await page.getByText("各路占比").waitFor();
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

  // 7. text-overflow audit: every page, three widths, both themes
  const ids = { detail: (await (await fetch(`${app.base}/api/review-list?limit=1&route=agent`)).json() as { items: { content_id: string }[] }).items[0]?.content_id ?? "" };
  const pages = ["overview", "track", "reviews", `contents/${encodeURIComponent(ids.detail)}`, "human", "appeals", "rules"];
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
