import { test, expect, Page } from "@playwright/test";

/** The UI against the fake board: what a person does with a mouse, verified
 * against what the server then holds. Every hardware-facing assertion checks
 * /api/config - the board (here, the fake) is the source of truth, and a test
 * that only reads the DOM would pass while the write silently failed. */

const cfg = async (page: Page) =>
  (await page.request.get("/api/config")).json();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The board opens on a background thread; controls unlock when it is up.
  await expect(page.locator(".hw-lock")).toBeEnabled({ timeout: 15_000 });
});

test("loads with the fake unit connected and all 16 channels", async ({ page }) => {
  await expect(page.getByText("DT5742B-SIM")).toBeVisible();
  // Default config: bank 0 enabled and open (8 tiles); bank 1 disabled and
  // collapsed. Expanding it shows the other 8.
  await expect(page.locator(".tile")).toHaveCount(8);
  await page.locator(".bank-head", { hasText: "Bank 1" }).click();
  await expect(page.locator(".tile")).toHaveCount(16);
  await expect(page.locator(".pill.state")).toHaveText("idle");
  // The event counter is always drawn (n=0 when idle), so tiles never
  // resize when events start arriving.
  await expect(page.locator(".tile-foot .n").first()).toHaveText(/^n=\d+$/);
});

test("unit settings split: campaign on Experiment, trigger tuning on Live", async ({ page }) => {
  // Live keeps only what is tuned while watching the plots: Fast trigger is
  // present, Sampling frequency is not (it moved to Experiment).
  await expect(page.locator(".setting-row", { hasText: "Fast trigger" }).first())
    .toBeVisible();
  await expect(page.locator("main + aside .setting-row",
    { hasText: "Sampling frequency" })).toHaveCount(0);
  // Campaign settings, required first then the gated optionals, live on the
  // Experiment view.
  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  const grid = page.locator(".exp-grid .settings-grid").first();
  await expect(grid.locator("> *").nth(0)).toContainText("Sampling frequency");
  await expect(grid.locator(".settings-divider")).toBeVisible();
  await expect(grid.locator(".setting-row.optional").first()).toBeVisible();
  await page.locator(".view-tabs button", { hasText: "Live" }).click();
});

test("TR threshold is shown in TR-calibrated volts", async ({ page }) => {
  // Fake board default threshold 20000 through the MANUAL's arithmetic
  // (UM4270 9.8.3): (20000 - 26214) / 13.2 mV = -470.76 mV at the TR0 input.
  // Shown to as many digits as name the exact word: "-0.471" (the old
  // fixed mV rounding) reads back as DAC 19997, not the 20000 it holds.
  const row = page.locator(".setting-row", { hasText: "TR threshold" }).first();
  const input = row.locator('input[type="number"]');
  await expect(input).toHaveValue("-0.47076");
  // The change toast must quote the SAME calibration as the field - it once
  // translated the DAC word back through the channel model and announced a
  // nonsense positive voltage for a negative threshold.
  await input.fill("-0.049");
  await input.press("Enter");
  await expect(page.getByText(/tr threshold: -0\.049 V/).first()).toBeVisible();
});

test("moving the TR offset leaves the raw threshold untouched", async ({ page }) => {
  // RAW semantics: threshold and offset are independent absolute levels.
  // An offset move must never rewrite the threshold DAC behind the
  // operator's back - the card's "vs offset" readout shows the new depth.
  const before = (await cfg(page)).groups[0].fast_trigger_threshold;

  const offRow = page.locator(".setting-row", { hasText: "TR DC offset" }).first();
  const input = offRow.locator('input[type="number"]');
  await input.fill("0.1");
  await input.press("Enter");
  await expect.poll(async () => (await cfg(page)).groups[0].fast_trigger_dc_offset)
    .not.toBe(32768);
  expect((await cfg(page)).groups[0].fast_trigger_threshold).toBe(before);
});

test("unchecking an optional setting writes its default to the unit", async ({ page }) => {
  // Customize "Dump header" (default off), then uncheck the row: the value
  // must return to the default ON THE SERVER, not merely in the form.
  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  const row = page.locator(".setting-row.optional", { hasText: "Dump header" });
  const box = row.locator('input[type="checkbox"]').first();
  await box.check();                                  // engage
  await row.locator('input[type="checkbox"]').nth(1).check();  // the value itself
  await expect.poll(async () => (await cfg(page)).output_header).toBe(true);
  await box.uncheck();                                // pin back to default
  await expect.poll(async () => (await cfg(page)).output_header).toBe(false);
});

test("a typed out-of-range value is clamped before it reaches the unit", async ({ page }) => {
  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  const row = page.locator(".setting-row.optional", { hasText: "Events per readout" });
  await row.locator('input[type="checkbox"]').first().check();
  const input = row.locator('input[type="number"]');
  await input.fill("5000");
  await input.press("Enter");
  await expect.poll(async () => (await cfg(page)).max_events_blt).toBe(1023);
  await expect(input).toHaveValue("1023");
});

test("the baseline guide is drawn when idle and follows the offset", async ({ page }) => {
  // Idle (no data): the ground marker shows where 0 V at the input lands on
  // the full-scale (code 0..4095) axis - the centre for a centred DAC.
  const rowOf = async () => page.evaluate(() => {
    const cv = document.querySelector(".tile canvas") as HTMLCanvasElement;
    const ctx = cv.getContext("2d")!;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    // Row with the most green-dominant pixels = the guide line.
    let best = -1, bestN = 0;
    for (let yy = 0; yy < cv.height; yy++) {
      let n = 0;
      for (let x = 0; x < cv.width; x++) {
        const p = (yy * cv.width + x) * 4;
        if (d[p + 3] > 60 && d[p + 1] > 140 && d[p] < 130) n++;
      }
      if (n > bestN) { bestN = n; best = yy; }
    }
    return { row: best, lit: bestN, height: cv.height };
  });
  // The power-on default 0x8F00 is 0 V of offset (V1742 manual sec 5.7).
  expect((await cfg(page)).channels[0].dc_offset).toBe(0x8F00);
  await expect(page.locator(".tile-dc input[type=number]").first()).toHaveValue("0.000");
  const centred = await rowOf();
  expect(centred.lit).toBeGreaterThan(50);
  expect(Math.abs(centred.row - centred.height / 2)).toBeLessThan(centred.height * 0.1);

  // +0.2 V raises the window centre to +0.2 V at the input (UM4270 sec
  // 9.1), so 0 V sits LOWER in the full-scale view.
  const field = page.locator(".tile-dc input[type=number]").first();
  await field.fill("0.2");
  await field.press("Enter");
  await expect.poll(async () => (await rowOf()).row).toBeGreaterThan(centred.row + 10);
  await field.fill("0");
  await field.press("Enter");
});

test("the DC-offset slider commits one write on release", async ({ page }) => {
  const before = (await cfg(page)).channels[0].dc_offset;
  const slider = page.locator(".dc-slider").first();
  await slider.focus();
  await slider.press("ArrowLeft");        // one 0.01 V step down; keyup commits
  const want = Math.round(0x8F00 + 32768 * -0.01);  // voltsToDac(-0.01): 0 V = 0x8F00
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).toBe(want);
  expect(before).not.toBe(want);
  // The typed field agrees with what the unit reports.
  await expect(page.locator(".tile-dc input[type=number]").first()).toHaveValue("-0.010");
});

test("typing a DC offset lands on the unit exactly", async ({ page }) => {
  const field = page.locator(".tile-dc input[type=number]").first();
  await field.fill("0.1");
  await field.press("Enter");
  const want = Math.round(0x8F00 + 32768 * 0.1);   // voltsToDac(+0.1)
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).toBe(want);
  // Enter commits but keeps focus, so the next tweak needs no click.
  await expect(field).toBeFocused();
  await field.press("ArrowUp");
  await field.press("Enter");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).not.toBe(want);
});

test("global channel controls: window, reset, and fit window to pulses", async ({ page }) => {
  const disp = async () => (await (await page.request.get("/api/display")).json())?.y_ranges ?? {};
  // Set the display window for every channel.
  const bar = page.locator(".chan-global");
  await bar.locator(".cg-group").first().locator(".cg-num").nth(0).fill("-0.2");
  await bar.locator(".cg-group").first().locator(".cg-num").nth(1).fill("0.2");
  await bar.locator(".cg-group").first().getByRole("button", { name: "set", exact: true }).click();
  await expect.poll(async () => {
    const y = await disp();
    return [0, 7, 15].every((c) => JSON.stringify(y[String(c)]) === "[-0.2,0.2]");
  }).toBe(true);
  // Reset returns every channel to the full window (no stored range).
  await bar.getByRole("button", { name: "reset", exact: true }).click();
  await expect.poll(async () => Object.keys(await disp()).length).toBe(0);
  // No all-channel DC offset any more.
  await expect(bar.getByRole("button", { name: "set all", exact: true })).toHaveCount(0);
  // Fit window to pulses: display only, one height for every channel, the
  // fake's negative pulse inside each window. Events first.
  const before = await cfg(page);
  await page.locator(".test-trigger input").fill("20");
  await page.locator(".test-trigger button", { hasText: "Fire" }).click();
  await page.waitForTimeout(2500);
  const fit = bar.getByRole("button", { name: "Fit window to pulses" });
  await expect(fit).toHaveAttribute("title", /Display only/);
  await fit.click();
  await expect.poll(async () => Object.keys(await disp()).length).toBeGreaterThan(0);
  const y = await disp();
  const heights = Object.values(y).map((r: any) => +(r[1] - r[0]).toFixed(4));
  expect(new Set(heights).size).toBe(1);
  expect(y["0"][0]).toBeLessThan(-0.15);       // room for the ~-195 mV pulse
  expect(y["0"][1]).toBeGreaterThan(0);        // baseline (0 V) inside
  const after = await cfg(page);
  expect(after.channels).toEqual(before.channels);   // no setting touched
  await bar.getByRole("button", { name: "reset", exact: true }).click();
  await expect.poll(async () => Object.keys(await disp()).length).toBe(0);
  await page.getByRole("button", { name: /Disable Acquisition/ }).click();
});

test("clicking a Y label edits the display range, and it persists", async ({ page }) => {
  const tile = page.locator(".tile").first();
  await tile.locator("button.ax.y.max").click();
  const editor = tile.locator(".yedit input[type=number]");
  await editor.fill("0.25");
  await editor.press("Enter");
  await expect(tile.locator("button.ax.y.max")).toHaveText("+0.250 V");
  // The min stays where full scale had it: ADC code 0 at ch0's offset,
  // in input volts = window centre - 0.5 V.
  const centre = ((await cfg(page)).channels[0].dc_offset - 0x8F00) / 32768;
  const stored = async () =>
    (await (await page.request.get("/api/display")).json())?.y_ranges?.["0"];
  await expect.poll(async () => (await stored())?.[1]).toBe(0.25);
  expect((await stored())[0]).toBeCloseTo(centre - 0.5, 6);
  // Survives a full reload: the display prefs live on the server.
  await page.reload();
  await expect(page.locator(".tile").first().locator("button.ax.y.max"))
    .toHaveText("+0.250 V");
});

test("the 'full' button resets a channel's range to the full window", async ({ page }) => {
  const tile = page.locator(".tile").first();
  const field = tile.locator(".tile-dc input[type=number]");
  await field.fill("0");
  await field.press("Enter");
  await tile.locator("button.ax.y.max").click();
  await tile.locator(".yedit button", { hasText: "full" }).click();
  // Full scale = ADC codes 0..4095 in input volts: at offset 0 the top is
  // code 4095 = +0.49976 V.
  await expect(tile.locator("button.ax.y.max")).toHaveText("+0.500 V");
  await expect(tile.locator("button.ax.y.min")).toHaveText("-0.500 V");
  // The axis follows the offset register: +0.2 V moves the window up.
  await field.fill("0.2");
  await field.press("Enter");
  await expect(tile.locator("button.ax.y.max")).toHaveText("+0.700 V");
  await expect(tile.locator("button.ax.y.min")).toHaveText("-0.300 V");
  await field.fill("0");
  await field.press("Enter");
});

test("sessions: save, perturb, apply restores the unit, delete", async ({ page }) => {
  const mark = (await cfg(page)).channels[0].dc_offset;

  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  await page.locator(".session-save input").fill("pw-test");
  await page.locator(".session-save button").click();
  const row = page.locator(".session-row", { hasText: "pw-test" });
  await expect(row).toBeVisible();

  // Perturb through the UI (a Live-view channel field), then apply the
  // session from the Experiment view: the unit must go back.
  await page.locator(".view-tabs button", { hasText: "Live" }).click();
  const field = page.locator(".tile-dc input[type=number]").first();
  await field.fill("-0.3");
  await field.press("Enter");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).not.toBe(mark);

  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  await row.locator("button", { hasText: "Apply" }).click();
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).toBe(mark);
  await expect(page.getByText(/applied and read back/)).toBeVisible();

  page.on("dialog", (d) => d.accept());
  await row.locator("button.danger").click();
  await expect(row).toHaveCount(0);
});

test("Pulse Shift returns a fitting channel to 0 V of offset, never centring", async ({ page }) => {
  // Park ch0 somewhere else; the fake's pulse fits at 0x8F00, so Pulse
  // Shift puts it back there and moves nothing further.
  const field = page.locator(".tile-dc input[type=number]").first();
  await field.fill("-0.3");
  await field.press("Enter");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset)
    .toBeLessThan(28000);   // -0.3 V = 0x8F00 - 9830
  const btn = page.locator(".calib-btns button", { hasText: "Pulse Shift" });
  await expect(btn).toHaveAttribute("title", /slide a clipped pulse/);
  await btn.click();
  await expect(page.getByText(/Calibration done/)).toBeVisible({ timeout: 60_000 });
  const c = await cfg(page);
  expect(c.channels.every((ch: { dc_offset: number }) => ch.dc_offset === 0x8F00)).toBe(true);
  await expect(field).toHaveValue("0.000");
  // Center baselines is gone.
  await expect(page.locator(".calib-btns button", { hasText: "Center baselines" })).toHaveCount(0);
});

test("a calibration's persistence profile is there to review afterwards", async ({ page }) => {
  // The pile accumulates in every mode, so the events a calibration collected
  // are already stacked when the operator flips to Overlay to look.
  await page.locator(".calib-btns button", { hasText: "Pulse Shift" }).click();
  await expect(page.getByText(/Calibration done/)).toBeVisible({ timeout: 60_000 });
  await page.locator(".wave-mode button", { hasText: "Overlay" }).click();
  const lit = await page.evaluate(() => {
    const cv = document.querySelector(".tile canvas") as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
    return n;
  });
  // The fake's run is quick, so the pile is thin - but present.
  expect(lit).toBeGreaterThan(150);
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
});

test("the Fire button queues test triggers and events arrive", async ({ page }) => {
  const before = (await (await page.request.get("/api/status")).json()).events_seen;
  await page.locator(".test-trigger input").fill("5");
  await page.locator(".test-trigger button", { hasText: "Fire" }).click();
  await expect(page.getByText(/Firing 5 test triggers/)).toBeVisible();
  // Firing auto-starts acquisition; the queued triggers become events.
  await expect
    .poll(async () => (await (await page.request.get("/api/status")).json()).events_seen,
          { timeout: 10_000 })
    .toBeGreaterThanOrEqual(before + 5);
  await page.getByRole("button", { name: /Disable Acquisition/ }).click();
});

test("overlay mode paints a density pile and the choice persists", async ({ page }) => {
  // Acquire so single-event traces flow (the fake board emits ~5/s).
  await page.getByRole("button", { name: /Enable Acquisition/ }).click();
  await page.locator(".wave-mode button", { hasText: "Overlay" }).click();
  await expect(page.locator(".wave-mode button.on")).toHaveText("Overlay");

  // The density canvas actually paints: non-transparent pixels appear in the
  // first tile once a few events have arrived.
  await expect.poll(async () => page.evaluate(() => {
    const cv = document.querySelector(".tile canvas") as HTMLCanvasElement;
    const ctx = cv.getContext("2d")!;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return lit;
  }), { timeout: 10_000 }).toBeGreaterThan(500);

  // The choice is display state: it survives a reload via the server.
  await expect
    .poll(async () => (await (await page.request.get("/api/display")).json()).wave_mode)
    .toBe("overlay");
  await page.reload();
  await expect(page.locator(".wave-mode button.on")).toHaveText("Overlay");

  // Back to Avg for the tests that follow.
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
  await page.getByRole("button", { name: /Disable Acquisition/ }).click();
});

test("scope mode free-runs triggers and stops when left", async ({ page }) => {
  const status = async () => (await page.request.get("/api/status")).json();

  await page.locator(".wave-mode button", { hasText: "Scope" }).click();
  // Entering scope starts the free-running software triggers server-side...
  await expect.poll(async () => (await status()).scope_hz).toBe(2);
  // ...at the rate shown in the field beside the toggle.
  await expect(page.locator(".scope-rate input")).toHaveValue("2");
  // Events arrive with nothing queued: the scope feeds itself.
  const seen = (await status()).events_seen;
  await expect.poll(async () => (await status()).events_seen,
                    { timeout: 10_000 }).toBeGreaterThan(seen);
  // A single full-resolution trace paints in the first tile.
  await expect.poll(async () => page.evaluate(() => {
    const cv = document.querySelector(".tile canvas") as HTMLCanvasElement;
    const ctx = cv.getContext("2d")!;
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
    return lit;
  }), { timeout: 10_000 }).toBeGreaterThan(200);

  // The rate is adjustable in place.
  await page.locator(".scope-rate input").fill("5");
  await page.locator(".scope-rate input").press("Enter");
  await expect.poll(async () => (await status()).scope_hz).toBe(5);

  // The software channel-trigger travels to the server with its level.
  await page.locator(".scope-trig select").selectOption("0");
  await expect.poll(async () => (await status()).scope_trigger?.channel).toBe(0);
  await page.locator(".scope-trig input").fill("35");
  await page.locator(".scope-trig input").press("Enter");
  await expect.poll(async () => (await status()).scope_trigger?.level_mv).toBe(35);
  // Back to trigger-on-anything.
  await page.locator(".scope-trig select").selectOption("");
  await expect.poll(async () => (await status()).scope_trigger ?? null).toBe(null);

  // Leaving scope stops the firing - no orphaned trigger source.
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
  await expect.poll(async () => (await status()).scope_hz).toBe(null);
  await page.getByRole("button", { name: /Disable Acquisition/ }).click();
});

test("the TR0 card appears when the fast trigger is digitized", async ({ page }) => {
  await page.getByRole("button", { name: /Enable Acquisition/ }).click();
  // "fast trigger" is unique to the TR0 waveform card's subtitle (the TR0
  // Trigger settings panel is a different heading).
  const trCard = page.locator(".card", { has: page.locator("h2", { hasText: "fast trigger" }) });
  await expect(trCard).toBeVisible({ timeout: 10_000 });
  const red = () => trCard.evaluate((card) => {
    const cv = card.querySelector("canvas") as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 100 && d[i] > 180 && d[i + 1] < 130) n++;
    }
    return n;
  });
  // The trigger line exists ONLY at TR offset 0x8000 (UM4270 sec 9.8.3).
  const offRow = page.locator(".setting-row", { hasText: "TR DC offset" }).first();
  const off = offRow.locator('input[type="number"]');
  await off.fill("0");
  await off.press("Enter");
  await expect.poll(async () => (await cfg(page)).groups[0].fast_trigger_dc_offset)
    .toBe(32768);
  await expect.poll(red, { timeout: 10_000 }).toBeGreaterThan(50);
  await off.fill("0.1");
  await off.press("Enter");
  await expect.poll(red, { timeout: 10_000 }).toBeLessThan(5);
  await off.fill("0");
  await off.press("Enter");
  await page.getByRole("button", { name: /Disable Acquisition/ }).click();
});

test("recording a run writes run_N.root and the number advances", async ({ page }) => {
  // Fresh test state starts at run 1; the placeholder shows the inference.
  await expect(page.locator("#runno")).toHaveAttribute("placeholder", "1");

  await page.locator("#runname").fill("ui-suite");
  // Record first opens the run-notes dialog; the note lands in the metadata.
  await page.locator(".rec-group button.record").click();
  await page.locator(".rec-modal textarea").fill("LuAG crystal, 3 GeV electrons");
  await page.locator(".rec-modal button.record").click();
  await expect(page.locator(".rec-group.on")).toBeVisible();
  // The fake board emits ~5 events/s; a moment later there is data to keep.
  await expect
    .poll(async () => (await (await page.request.get("/api/status")).json()).recorded)
    .toBeGreaterThan(0);
  await page.locator("button.danger", { hasText: "Stop recording" }).click();
  // The click resolves before the server has closed the writer; the metadata
  // event count exists only once recording has actually ended.
  await expect
    .poll(async () => (await (await page.request.get("/api/status")).json()).recording)
    .toBe(false);

  const runs = await (await page.request.get("/api/runs")).json();
  expect(runs.runs.length).toBe(1);
  expect(runs.runs[0].events).toBeGreaterThan(0);
  expect(runs.runs[0].note).toBe("LuAG crystal, 3 GeV electrons");
  // ...and the listing shows it.
  await expect(page.locator(".run-note").first())
    .toHaveText("LuAG crystal, 3 GeV electrons");
  // The number advanced, and an explicit override is respected next.
  await expect(page.locator("#runno")).toHaveAttribute("placeholder", "2");
  await page.locator("#runno").fill("42");
  await page.locator("#runname").fill("ui-suite-2");
  // An empty note is fine - the dialog never blocks a shift in a hurry.
  await page.locator(".rec-group button.record").click();
  await page.locator(".rec-modal button.record").click();
  await expect(page.locator(".rec-group.on")).toBeVisible();
  await page.locator("button.danger", { hasText: "Stop recording" }).click();
  await expect
    .poll(async () => (await (await page.request.get("/api/status")).json()).recording)
    .toBe(false);
  await expect
    .poll(async () => (await (await page.request.get("/api/status")).json()).next_run_number)
    .toBe(43);
});

test("a bounded recording closes itself at N events", async ({ page }) => {
  await page.locator("#runname").fill("bounded");
  await page.locator("#recmax").fill("3");
  await page.locator(".rec-group button.record").click();
  await page.locator(".rec-modal button.record").click();
  await expect(page.locator(".rec-group.on")).toBeVisible();
  // The run ends on its own; acquisition keeps going.
  await expect(page.locator(".rec-group.on")).toHaveCount(0, { timeout: 15_000 });
  const st = await (await page.request.get("/api/status")).json();
  expect(st.running).toBe(true);
  await page.getByRole("button", { name: /Disable Acquisition/ }).click();
  const runs = await (await page.request.get("/api/runs")).json();
  expect(runs.runs.find((r: any) => r.id.startsWith("bounded")).events).toBe(3);
});

test("a second run joins an existing folder when picked without timestamp", async ({ page }) => {
  const status = async () => (await page.request.get("/api/status")).json();
  // Timestamp off, so the folder carries the bare campaign name.
  await page.locator(".rec-stamp input").uncheck();
  await page.locator("#runname").fill("campaign");
  await page.locator(".rec-group button.record").click();
  await expect(page.locator(".rec-dest")).toContainText("new run folder");
  await page.locator(".rec-modal button.record").click();
  await expect(page.locator(".rec-group.on")).toBeVisible();
  await page.locator("button.danger", { hasText: "Stop recording" }).click();
  await expect.poll(async () => (await status()).recording).toBe(false);
  const dirs0 = (await (await page.request.get("/api/runs")).json()).runs.length;

  // Same name, timestamp still off: the dialog announces it JOINS the
  // folder, and no new directory appears - the campaign stays together.
  await page.locator(".rec-group button.record").click();
  await expect(page.locator(".rec-dest")).toContainText("existing folder");
  await page.locator(".rec-modal button.record").click();
  await expect(page.locator(".rec-group.on")).toBeVisible();
  await page.locator("button.danger", { hasText: "Stop recording" }).click();
  await expect.poll(async () => (await status()).recording).toBe(false);

  const runs = (await (await page.request.get("/api/runs")).json()).runs;
  expect(runs.length).toBe(dirs0);
  const camp = runs.find((r: { id: string }) => r.id === "campaign");
  expect(camp.files).toBeGreaterThanOrEqual(3);   // 2 x run_N.root + metadata
  await page.locator(".rec-stamp input").check(); // leave it as found
});

test("experiment conditions reach the server and the record dialog", async ({ page }) => {
  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  await page.locator(".cond-add").click();
  await page.locator(".cond-key").last().fill("XCET 40");
  await page.locator(".cond-val").last().fill("40 bar");
  // The debounced save lands server-side...
  await expect.poll(async () => {
    const r = await (await page.request.get("/api/conditions")).json();
    return r.items.some((c: { key: string }) => c.key === "XCET 40");
  }).toBe(true);
  // ...and the confirm-setup digest shows it before anything records.
  await page.locator(".view-tabs button", { hasText: "Live" }).click();
  await page.locator(".rec-group button.record").click();
  await expect(page.locator(".cond-pill", { hasText: "XCET 40" })).toBeVisible();
  await page.locator(".rec-modal button", { hasText: "Cancel" }).click();
});

test("lock everything, then unlock a single setting", async ({ page }) => {
  await page.locator(".lock-all").click();
  await expect(page.locator(".lock-all")).toContainText("LOCKED");
  // Every settings row is locked and wears its own chip...
  const row = page.locator(".settings-grid .setting-row",
    { hasText: "Trigger edge" }).first();
  await expect(row.locator(".lock-chip")).toBeVisible();
  await expect(row.locator("select")).toBeDisabled();
  // ...and clicking the chip unlocks JUST that row.
  await row.locator(".lock-chip").click();
  await expect(row.locator(".lock-chip")).toHaveCount(0);
  await expect(row.locator("select")).toBeEnabled();
  // Unlock everything again so later tests are unaffected.
  page.on("dialog", (d) => d.accept());
  await page.locator(".lock-all").click();
  await expect(page.locator(".lock-all")).not.toContainText("LOCKED");
});

test("a legacy Configuration B file loads through the Load button", async ({ page }) => {
  const legacy = [
    "Module 125", "DRS4FREQ 0",
    "CHNOFFSE 47000 0 0", "CHNOFFSE 18536 4 1",
    "TR0OFFSE 32768", "TRG__TR0 20934",
    "TRGPOLAR 1", "POSTTRIG 0", "LEMO_LEV 0", "GPO_BUSY 1",
  ].join("\n");
  // The Load button lives on the Experiment view now.
  await page.locator(".view-tabs button", { hasText: "Experiment" }).click();
  // Straight onto the hidden input - clicking Load would open the native
  // chooser, which is the browser's UI, not ours to test.
  await page.locator('input[type="file"]').setInputFiles({
    name: "configB.txt", mimeType: "text/plain",
    buffer: Buffer.from(legacy),
  });
  await expect(page.getByText(/Config loaded and read back/)).toBeVisible();
  const c = await cfg(page);
  expect(c.gpo_output).toBe("busy");
  expect(c.trigger_edge).toBe("falling");
  expect(c.channels[0].dc_offset).toBe(47000);
  expect(c.channels[12].dc_offset).toBe(18536);
});

test("0 V calibration: help, calibrate, applied, settings restored", async ({ page }) => {
  // LAST in the file on purpose: once stored, the calibration applies to
  // every later page load of this fake board.
  const state = page.locator(".zc-state");
  await expect(state).toContainText("nominal");
  await expect(state).toHaveAttribute("title", /nominal/);

  // The help icon explains what to do.
  await page.locator(".zc-help").click();
  const dlg = page.getByRole("dialog", { name: "Zero-Volt Calibration" });
  await expect(dlg).toContainText("Disconnect all inputs");
  await dlg.getByRole("button", { name: "OK" }).click();
  await expect(dlg).toHaveCount(0);

  const before = await cfg(page);
  const btn = page.locator(".zc-row button", { hasText: "Calibrate 0 V" });
  await expect(btn).toHaveAttribute("title", /ADC code a 0 V input reads/);
  await btn.click();
  // The fake is a dark bench with hardware triggers off, so it saves.
  await expect(state).toContainText("board-calibrated", { timeout: 60_000 });
  await expect(state).toHaveAttribute("title", /plots only, not to recorded data/);
  await expect(page.locator(".zc-row button", { hasText: "Re-calibrate 0 V" })).toBeVisible();
  const zc = await (await page.request.get("/api/zerocal")).json();
  expect(zc.applied).toBe(true);
  expect(Object.keys(zc.channels)).toEqual(expect.arrayContaining(["0", "15", "16"]));
  // One point per input at its 0 V of offset: the fake reads 2048 on a
  // channel at 0x8F00 and 2200 on TR0 at 0x8000.
  expect(zc.channels["0"].ref_dac).toBe(0x8F00);
  expect(Math.abs(zc.channels["0"].zero_code - 2048)).toBeLessThan(5);
  expect(zc.channels["16"].ref_dac).toBe(0x8000);
  expect(Math.abs(zc.channels["16"].zero_code - 2200)).toBeLessThan(5);
  // The operator's settings come back exactly.
  const after = await cfg(page);
  expect(after.channels.map((c: { dc_offset: number }) => c.dc_offset))
    .toEqual(before.channels.map((c: { dc_offset: number }) => c.dc_offset));
  expect(after.groups).toEqual(before.groups);
  expect(after.external_trigger).toBe(before.external_trigger);
  expect(after.fast_trigger).toBe(before.fast_trigger);
});
