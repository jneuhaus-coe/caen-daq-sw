import { test, expect } from "./fixtures";

/** Quick Look's controls, on the fake backend's synthetic experiment. The
 * numbers themselves are the smoke test's job (test_quick_look_*); this
 * checks that each control reaches the plot. */

test("quick look: facets, series, filters, channels, processing", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await page.locator(".view-tabs button", { hasText: "Quick Look" }).click();
  const folderSel = page.getByRole("combobox", { name: "Folder", exact: true });
  await folderSel.selectOption({ label: "fake-testbeam (synthetic) · 12 runs" });
  await expect(page.locator(".ql-table tbody tr")).toHaveCount(12);

  // Facets: energy from the notes (run 12's has none: fixed by hand), and
  // particle from the folder names by pattern.
  const dlg = page.getByRole("dialog", { name: "Facet from run names" });
  await page.getByRole("button", { name: "+ Facet from name" }).click();
  await dlg.locator(".ql-tok", { hasText: /^2$/ }).click();
  await dlg.getByLabel("E for run 12").fill("60");
  await dlg.getByRole("button", { name: "Add facet" }).click();
  await page.getByRole("button", { name: "+ Facet from name" }).click();
  await dlg.getByRole("radio", { name: "Run folder" }).click();
  await dlg.getByRole("button", { name: "Edit pattern" }).click();
  await dlg.getByLabel("Pattern (regular expression)").fill("GeV-(\\w+)");
  await dlg.getByLabel("2 · Facet name").fill("particle");
  await dlg.getByRole("button", { name: "Add facet" }).click();
  // A facet chip toggles its column.
  await page.getByRole("button", { name: /^bias_V/ }).click();
  await expect(page.getByRole("columnheader", { name: "bias_V column" })).toBeVisible();

  // Channels: ch 8 from TR0 (⋯ opens its source), ch 13 struck by a click.
  await page.getByRole("button", { name: "Source of ch 8…" }).click();
  await page.getByLabel("Source of ch 8", { exact: true }).selectOption("tr0:1");
  await page.locator(".ql-pop").getByRole("button", { name: "Done" }).click();
  await page.getByRole("checkbox", { name: "ch 13", exact: true }).click();

  // One line per E x particle: 11 combinations, 8 shown.
  await page.getByRole("tab", { name: "vs Channel" }).click();
  await page.getByRole("button", { name: "One line per" }).click();
  const menu = page.getByRole("dialog", { name: "One line per" });
  await menu.getByRole("checkbox", { name: "E", exact: true }).check();
  await menu.getByRole("checkbox", { name: "particle" }).check();
  await page.keyboard.press("Escape");
  const legend = page.locator(".ql-legend");
  await expect(legend.locator("span", { hasText: /^4 · pi/ })).toBeVisible();
  await expect(page.locator(".ql-warn", { hasText: "3 more series" })).toBeVisible();

  // vs Facet takes a text facet as a categorical axis.
  await page.getByRole("tab", { name: "vs Facet" }).click();
  await page.getByLabel("X axis facet").selectOption("particle");
  await expect(page.locator(".ql-chart svg text", { hasText: /^pi$/ })).toBeVisible();
  await page.getByRole("tab", { name: "vs Channel" }).click();

  // Where particle = e pins particle out of the split; the chip's value
  // changes in place, and particle is not offered as a second filter.
  await page.getByRole("button", { name: "+ where" }).click();
  await page.getByLabel("Filter facet").selectOption("particle");
  await page.getByLabel("Filter value").selectOption("e");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(legend.locator("span", { hasText: /^20( |$)/ })).toBeVisible();
  await page.getByLabel("Where particle", { exact: true }).selectOption("pi");
  await expect(legend.locator("span", { hasText: /^32( |$)/ })).toBeVisible();
  await expect(legend.locator("span", { hasText: /^20( |$)/ })).toHaveCount(0);
  await page.getByRole("button", { name: "+ where" }).click();
  await expect(page.getByLabel("Filter facet").locator("option", { hasText: "particle" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Run checks, and an unticked run dims.
  await expect(page.locator(".ql-status")).toContainText("Computed on 12 runs", { timeout: 60_000 });
  await expect(page.locator(".ql-health", { hasText: "ped +6" })).toHaveCount(1);
  const run9 = page.getByLabel("Include run 9", { exact: true });
  await run9.uncheck();
  await expect(page.locator(".ql-table tbody tr", { has: run9 })).toHaveClass(/dim/);

  // Waveforms: every channel, the struck one masked; the processing strip
  // opens for its settings and always says what is integrated.
  await page.getByRole("tab", { name: "Waveforms" }).click();
  await expect(page.locator(".ql-panel")).toHaveCount(16);
  await expect(page.locator(".ql-panel", { hasText: "excluded" })).toHaveCount(1);
  const procToggle = page.getByRole("button", { name: "Processing" });
  await procToggle.click();
  await page.getByLabel("Baseline subtraction").selectOption("none");
  await expect(page.locator(".ql-strip")).toContainText("no baseline subtraction · integrated 60–120 ns");

  // Placed from a reference, each series gets a window, and the legend's
  // window column paints: press the first, drag across two more - all off.
  await page.getByLabel("Integrate", { exact: true }).selectOption("reference");
  const boxes = page.locator(".ql-legend [role=checkbox]");
  await expect(boxes).toHaveCount(4);              // the pions, run 9 unticked
  const at = async (i: number) => { const b = (await boxes.nth(i).boundingBox())!; return [b.x + b.width / 2, b.y + b.height / 2] as const; };
  await page.mouse.move(...await at(0));
  await page.mouse.down();
  await page.mouse.move(...await at(1), { steps: 4 });
  await page.mouse.move(...await at(2), { steps: 4 });
  await page.mouse.up();
  for (const [i, v] of [[0, "false"], [1, "false"], [2, "false"], [3, "true"]] as const) {
    await expect(boxes.nth(i)).toHaveAttribute("aria-checked", v);
  }

  // A cut is edited in place: Enter applies, Escape leaves it as it was.
  await page.getByRole("button", { name: "+ cut" }).click();
  await page.getByLabel("Minimum").fill("50");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Edit cut Σ charge ≥ 50 pC" }).click();
  await page.getByLabel("Maximum").fill("400");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Edit cut Σ charge 50–400 pC" }).click();
  await page.getByLabel("Minimum").fill("999");
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit cut Σ charge 50–400 pC" })).toBeFocused();

  // Settings survive a reload.
  await page.reload();
  await expect(page.getByRole("tab", { name: "Waveforms" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("checkbox", { name: "ch 13 (struck)" })).not.toBeChecked();
  await expect(procToggle).toHaveAttribute("aria-expanded", "true");
});
