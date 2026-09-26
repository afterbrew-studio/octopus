import { expect, it } from "bun:test";

// Optional real-browser check, with all billing/Stripe effects replaced by local
// fixtures. Point PLAYWRIGHT_MODULE_PATH at an existing Playwright installation.
it.skipIf(!process.env.PLAYWRIGHT_MODULE_PATH)("preserves auto-reload drafts through card setup and requires an explicit settings save", async () => {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH!);
  const build = await Bun.build({
    entrypoints: [new URL("./fixtures/auto-reload-card-ui.tsx", import.meta.url).pathname],
    target: "browser",
    plugins: [{ name: "isolated-billing", setup(builder) {
      builder.onResolve({ filter: /^\.\/actions$/ }, () => ({ path: "actions", namespace: "fixture" }));
      builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "fixture" }));
      builder.onResolve({ filter: /^@stripe\/stripe-js$/ }, () => ({ path: "stripe", namespace: "fixture" }));
      builder.onResolve({ filter: /^\.\/purchase-dialog$/ }, () => ({ path: "purchase", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ loader: "js", contents: {
        actions: `
          export async function updateAutoReload(_, data) { window.billingFixture.saves.push(Object.fromEntries(data)); return window.billingFixture.saveError ? {error:window.billingFixture.saveError} : {success:true}; }
          export async function updateBillingEmail() { return {}; }
          export async function updateSpendLimit() { return {}; }
          export async function loadMoreTransactions() { return []; }
          export async function subscribeToPlan() { throw Error('Subscription must not run'); }
          export async function setSubscriptionCancel() { throw Error('Subscription must not run'); }
          export async function createCardSetupIntent() { return {clientSecret:'fixture-only'}; }
          export async function finalizeCardSetup() {
            if(window.billingFixture.finalizeFails) return {error:'Fixture finalization failure'};
            window.billingFixture.savedCard=true; return {success:true};
          }`,
        navigation: `export function useRouter(){return {refresh:()=>window.billingFixture.refresh()};}`,
        purchase: `export function PurchaseDialog(){return null;}`,
        stripe: `export async function loadStripe(){return {
          elements:()=>({create:()=>({mount:node=>{node.textContent='Isolated payment form; no card entry';},on:(_,fn)=>queueMicrotask(fn)})}),
          confirmSetup:async()=>window.billingFixture.cardResult==='success'
            ? {setupIntent:{id:'seti_fixture',status:'succeeded'}} : {error:{message:'Fixture authentication failure'}}
        };}`,
      }[path]! }));
    }}],
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0].text();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    return new URL(request.url).pathname === "/fixture.js"
      ? new Response(bundle, { headers: { "Content-Type": "text/javascript" } })
      : new Response('<html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
  }});
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const externalRequests: string[] = [];
    await page.route("**/*", (route: { request(): { url(): string }; continue(): Promise<void>; abort(): Promise<void> }) => {
      if (new URL(route.request().url()).hostname !== "127.0.0.1") {
        externalRequests.push("blocked external request");
        return route.abort();
      }
      return route.continue();
    });
    await page.goto(server.url.href);
    const toggle = page.getByRole("switch", { name: "Enable auto-reload", includeHidden: true });
    const save = page.getByRole("button", { name: "Save Auto-Reload", exact: true });
    await toggle.click();
    await page.getByLabel("When balance falls below").fill("17");
    await page.getByLabel("Reload amount", { exact: true }).fill("85");
    await save.click();
    const dialog = page.getByRole("dialog", { name: "Add card" });
    await dialog.waitFor();
    expect(await page.evaluate("window.billingFixture.saves.length")).toBe(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    expect(await page.getByLabel("When balance falls below").inputValue()).toBe("17");
    expect(await page.getByLabel("Reload amount", { exact: true }).inputValue()).toBe("85");
    await save.click();
    await dialog.getByRole("button", { name: "Save card", exact: true }).click();
    await page.getByText("Fixture authentication failure", { exact: true }).waitFor();
    expect(await page.evaluate("window.billingFixture.saves.length")).toBe(0);
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    expect(await page.getByLabel("When balance falls below").inputValue()).toBe("17");
    expect(await page.getByLabel("Reload amount", { exact: true }).inputValue()).toBe("85");
    await page.evaluate("window.billingFixture.cardResult='success'; window.billingFixture.finalizeFails=true");
    await dialog.getByRole("button", { name: "Save card", exact: true }).click();
    await page.getByText("Fixture finalization failure", { exact: true }).waitFor();
    expect(await page.evaluate("window.billingFixture.saves.length")).toBe(0);
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    expect(await page.getByLabel("When balance falls below").inputValue()).toBe("17");
    expect(await page.getByLabel("Reload amount", { exact: true }).inputValue()).toBe("85");
    await page.evaluate("window.billingFixture.finalizeFails=false");
    await dialog.getByRole("button", { name: "Save card", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByText("Card saved. Review your settings, then select Save Auto-Reload to apply them.", { exact: true }).waitFor();
    expect(await page.evaluate("window.billingFixture.saves.length")).toBe(0);
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    expect(await page.getByLabel("When balance falls below").inputValue()).toBe("17");
    expect(await page.getByLabel("Reload amount", { exact: true }).inputValue()).toBe("85");
    // Unmount/remount the amount fields by toggling the unsaved draft.
    await toggle.click();
    await toggle.click();
    expect(await page.getByLabel("When balance falls below").inputValue()).toBe("17");
    expect(await page.getByLabel("Reload amount", { exact: true }).inputValue()).toBe("85");
    await save.click();
    await page.getByText("Auto-reload updated.", { exact: true }).waitFor();
    expect(await page.evaluate("window.billingFixture.saves")).toEqual([{ enabled: "true", thresholdAmount: "17", reloadAmount: "85" }]);
    // Disabling must still save without requiring a card.
    await page.reload();
    await save.click();
    await page.getByText("Auto-reload updated.", { exact: true }).waitFor();
    expect(await page.evaluate("window.billingFixture.saves")).toEqual([{ enabled: "false", thresholdAmount: "10", reloadAmount: "50" }]);
    for (const saveError of ["", "Fixture backend payment-method guard"]) {
      await page.goto(new URL("?lookupFailed=1", server.url).href);
      await page.evaluate((error: string) => { (window as unknown as { billingFixture: { saveError: string } }).billingFixture.saveError = error; }, saveError);
      await toggle.click();
      await page.getByLabel("When balance falls below").fill("17");
      await page.getByLabel("Reload amount", { exact: true }).fill("85");
      await save.click();
      await page.getByText(saveError || "Auto-reload updated.", { exact: true }).waitFor();
      expect(await dialog.count()).toBe(0);
      expect(await page.evaluate("window.billingFixture.saves")).toEqual([{ enabled: "true", thresholdAmount: "17", reloadAmount: "85" }]);
      expect(await toggle.getAttribute("aria-checked")).toBe("true");
      expect(await page.getByLabel("When balance falls below").inputValue()).toBe("17");
      expect(await page.getByLabel("Reload amount", { exact: true }).inputValue()).toBe("85");
    }
    await page.goto(new URL("?enabled=1", server.url).href);
    expect(await toggle.getAttribute("aria-checked")).toBe("true");
    await page.getByLabel("Reload amount", { exact: true }).fill("85");
    await save.click();
    await page.getByText("Auto-reload updated.", { exact: true }).waitFor();
    expect(await dialog.count()).toBe(0);
    expect(await page.evaluate("window.billingFixture.saves")).toEqual([{ enabled: "true", thresholdAmount: "10", reloadAmount: "85" }]);
    expect(externalRequests).toEqual([]);
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 60_000);
