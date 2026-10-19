import { test as base, type Page } from "@playwright/test";

/** One browser page per worker, reused by every test.
 *
 * Chromium spends ~3.2 s on the FIRST navigation of every new page (measured
 * on Playwright 1.62 / macOS: the page loads in ~25 ms, then its timers stall
 * until ~3.2 s; the same with the GPU off and in either headless mode). A
 * fresh page per test made that the floor of every test. Navigating a page
 * that already exists takes ~20 ms.
 *
 * Each test still starts clean: no routes, no storage, and a fresh load of
 * the app. The server's state was always shared (one fake board, one worker,
 * file order); now the page is too. */
export const test = base.extend<object, { sharedPage: Page }>({
  sharedPage: [async ({ browser }, use, workerInfo) => {
    const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
    await use(await context.newPage());
    await context.close();
  }, { scope: "worker" }],

  page: async ({ sharedPage: page }, use) => {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    page.removeAllListeners("dialog");
    // about:blank (the first test) has no storage to clear.
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
    await use(page);
  },
});

export { expect } from "@playwright/test";
