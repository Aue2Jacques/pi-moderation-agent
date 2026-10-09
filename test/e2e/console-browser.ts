// Browser-level smoke test of the web console in demo mode (headless Chromium via playwright-core): submit a sample and
// watch the live timeline, decide a human task, file an appeal, open a review's restricted view, visit every page in
// both themes. Fails on any page error or console error.
// Needs a browser once: node_modules/.bin/playwright-core install chromium-headless-shell (plus its system libraries;
// on a machine without them, LD_LIBRARY_PATH / FONTCONFIG_FILE can point at locally extracted copies).
// usage: node --experimental-strip-types --no-warnings test/e2e/console-browser.ts [--shots dir]   (pnpm run e2e:browser)
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { launchDemo } from "./launch.ts";

const shotsArg = process.argv.indexOf("--shots");
const shots = shotsArg >= 0 ? process.argv[shotsArg + 1] : undefined;
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0, passed = 0;
const check = (name: string, ok: boolean, detail = ""): void => { if (ok) passed++; else failed++; console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`); };
const shot = async (page: Page, name: string): Promise<void> => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };

const app = await launchDemo({ DEMO_AGENT_MS: "300", DEMO_JUDGE_MS: "150" });
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
  check("pipeline reaches the last stage", (await page.locator(".pipe.done").count()) >= 4);
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
  await page.locator(".tbl tbody tr.click").first().click();
  await page.getByRole("button", { name: "提交申诉" }).click();
  await page.getByText("已受理").waitFor();
  check("appeal accepted", true);
  await page.locator("td", { hasText: "→" }).first().waitFor();
  await page.waitForTimeout(4000);
  await shot(page, "4-appeals");

  // 4. review list -> detail -> restricted view (confirm dialog accepted, audited server side)
  await page.goto(`${app.base}/#/reviews`);
  await page.locator(".tbl tbody tr.click").first().waitFor();
  check("review list has rows", (await page.locator(".tbl tbody tr.click").count()) >= 3);
  await shot(page, "5-reviews");
  await page.locator(".tbl tbody tr.click").last().click();
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
