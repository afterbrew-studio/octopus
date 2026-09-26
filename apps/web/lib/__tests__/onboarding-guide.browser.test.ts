import { expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

it.skipIf(!process.env.PLAYWRIGHT_MODULE_PATH)("follows one repository through preparation and the first review in a browser", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH!);
  const build = await Bun.build({
    entrypoints: [new URL("./fixtures/onboarding-guide-ui.tsx", import.meta.url).pathname], target: "browser",
    plugins: [{ name: "onboarding-fixture", setup(builder) {
      builder.onResolve({ filter: /^(next\/navigation|@\/lib\/pubby-client)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
      builder.onResolve({ filter: /^@\// }, ({ path }) => ({ path: Bun.resolveSync(`./${path.slice(2)}`, new URL("../../", import.meta.url).pathname) }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: path === "next/navigation"
        ? "export const useRouter=()=>window.onboardingFixture.router; export const useSearchParams=()=>new URLSearchParams(location.search);"
        : "export const getPubbyClient=()=>({subscribe:()=>window.onboardingFixture.channel});" }));
    } }],
  });
  expect(build.success, build.logs.join("\n")).toBe(true);
  const bundle = await build.outputs[0].text();
  // Render with the application's actual Tailwind tokens and components.
  const postcss = createRequire(import.meta.resolve("@tailwindcss/postcss"))("postcss");
  const { default: tailwind } = await import("@tailwindcss/postcss");
  const cssPath = new URL("../../app/globals.css", import.meta.url).pathname;
  const css = await postcss([tailwind()]).process(await Bun.file(cssPath).text(), { from: cssPath });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/fixture.js") return new Response(bundle, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/fixture.css") return new Response(css.css, { headers: { "Content-Type": "text/css" } });
    return new Response('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body style="font-family:Arial,sans-serif"><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.route("**/*", (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await page.goto(`${server.url}dashboard?period=30d`);
    await page.getByText("2/4 steps completed").waitFor();
    await page.evaluate("window.onboardingFixture.repositories.push({...window.onboardingFixture.repositories[0],id:'discovered',fullName:'team/discovered'});window.onboardingFixture.emit('repos-discovered')");
    await page.waitForFunction("!!document.querySelector('option[value=discovered]')");
    expect(await page.getByRole("link", { name: "Open repository to create a PR" }).getAttribute("href")).toBe("https://github.com/team/first");
    await page.getByLabel("Repository for your first review").selectOption("second");
    expect(new URL(page.url()).searchParams.get("period")).toBe("30d");
    expect(await page.getByRole("link", { name: "View repository", exact: true }).getAttribute("href")).toBe("/repositories?repo=second");
    await page.evaluate("window.onboardingFixture.repositories[1].indexStatus='indexing'; window.onboardingFixture.emit('index-status')");
    await page.getByRole("status").filter({ hasText: "Preparing automatically" }).waitFor();
    expect(await page.getByText("2/4 steps completed").count()).toBe(1);
    if (process.env.ONBOARDING_SCREENSHOTS) {
      await mkdir(process.env.ONBOARDING_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.ONBOARDING_SCREENSHOTS}/guide-desktop.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    if (process.env.ONBOARDING_SCREENSHOTS) await page.screenshot({ path: `${process.env.ONBOARDING_SCREENSHOTS}/guide-mobile.png`, fullPage: true });
    await page.evaluate("window.onboardingFixture.latestReview={id:'pr',number:12,status:'failed',url:'https://github.com/team/second/pull/12'};window.onboardingFixture.emit('review-status')");
    await page.getByText("3/4 steps completed").waitFor();
    await page.getByText(/The review failed/).waitFor();
    expect(await page.getByText("Your first review is complete", { exact: true }).count()).toBe(0);
    await page.evaluate("window.onboardingFixture.completedReview=window.onboardingFixture.latestReview;window.onboardingFixture.emit('review-status')");
    await page.getByText("4/4 steps completed").waitFor();
    expect(await page.getByRole("link", { name: "Read your review on PR #12" }).getAttribute("href")).toBe("https://github.com/team/second/pull/12");
    await page.getByRole("button", { name: "Hide first review guide" }).click();
    expect(await page.getByLabel("First review setup").count()).toBe(0);
    expect(await page.evaluate("document.cookie")).toContain("onboarding_first_review_dismissed_fixture-org=1");
    await page.evaluate("window.onboardingFixture.orgId='another-org';window.onboardingFixture.router.refresh()");
    await page.getByLabel("First review setup").waitFor();
    expect(await page.evaluate("document.cookie.includes('onboarding_first_review_dismissed_another-org=1')")).toBe(false);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 60_000);
