import { test, expect } from "@playwright/test";

/** Quick Look against the fake backend's synthetic campaign (written by the
 * real RootWriter at server start, under the test state dir): open it, make
 * an energy tag from the run notes, feed ch 8 from TR0 and strike ch 13,
 * and check the plot the server computed. Read-only throughout - the only
 * outputs are downloads. */

test("quick look: tag from notes, channel map, strike, plot, export", async ({ page }) => {
  await page.goto("/");
  await page.locator(".view-tabs button", { hasText: "Quick Look" }).click();

  // Works with or without a unit: it is outside the hardware lock.
  const folderSel = page.getByRole("combobox", { name: "Folder", exact: true });
  const synthetic = folderSel.locator("option", { hasText: "fake-testbeam (synthetic)" });
  await expect(synthetic).toHaveCount(1);
  await folderSel.selectOption({ label: await synthetic.textContent() ?? "" });
  await expect(page.locator(".ql-table tbody tr")).toHaveCount(12);
  // Experiment conditions become tags by themselves.
  await expect(page.locator(".ql-chip", { hasText: "bias_V" })).toBeVisible();

  // A tag from the notes: click the "2" in "e- 2GeV".
  await page.getByRole("button", { name: "+ Tag from name" }).click();
  const dlg = page.getByRole("dialog", { name: "Tag from run names" });
  await dlg.locator(".ql-tok", { hasText: /^2$/ }).click();
  await expect(dlg.locator("input").first()).toHaveValue("E");
  // Run 12's note has no "GeV": flagged as a miss; fix it by hand.
  await expect(dlg.locator(".ql-warn")).toContainText("1 of 12");
  await dlg.getByLabel("E for run 12").fill("60");
  await dlg.getByRole("button", { name: "Add tag" }).click();
  await expect(page.locator(".ql-chip", { hasText: "E" }).first()).toBeVisible();

  // vs Channel, one series per E.
  await page.getByRole("tab", { name: "vs Channel" }).click();
  await page.getByLabel("One series per").selectOption("E");

  // ch 8 reads TR0; ch 13 is struck.
  await page.getByRole("button", { name: "ch 8", exact: true }).click();
  await page.locator(".ql-pop select").selectOption("tr0:1");
  await page.locator(".ql-pop").getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "ch 13", exact: true }).click();
  await page.locator(".ql-pop").getByLabel("Strike ch 13 from the analysis").check();
  await page.locator(".ql-pop").getByRole("button", { name: "Done" }).click();

  // The full pass lands, the legend lists the energies in order, the plot
  // marks the struck channel and the TR0-fed one.
  await expect(page.locator(".ql-status")).toContainText("Computed on 12 runs", { timeout: 60_000 });
  const legend = page.locator(".ql-legend");
  await expect(legend).toContainText("E");
  for (const e of ["2", "4", "8", "12", "16", "20", "32", "60"]) {
    await expect(legend.locator("span", { hasText: new RegExp(`^${e}( |$)`) }).first()).toBeVisible();
  }
  await expect(page.locator(".ql-chart svg text", { hasText: "struck" })).toHaveCount(1);
  await expect(page.locator(".ql-chart svg text", { hasText: "TR0" })).toHaveCount(1);
  await expect(page.locator(".ql-health", { hasText: "clip" })).toHaveCount(1);
  await expect(page.locator(".ql-health", { hasText: "ped +6" })).toHaveCount(1);

  // Exports are downloads.
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect((await dl).suggestedFilename()).toBe("fake-testbeam-channel.csv");

  // The spatial map: one map per energy, ch 13 off.
  await page.getByRole("tab", { name: "Spatial" }).click();
  await expect(page.locator(".ql-map-fig")).toHaveCount(8);
  await expect(page.locator(".ql-map-fig").first().locator(".ql-cell.off")).toHaveCount(1);

  // Settings survive a reload (the browser keeps them; the server is never told).
  await page.reload();
  await expect(page.getByRole("tab", { name: "Spatial" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "ch 13 (struck)" })).toBeVisible();
});
