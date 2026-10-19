import type { Page, Locator } from "@playwright/test";
import { test, expect } from "./fixtures";

/** The UI against the fake board: what a person does with a mouse, verified
 * against what the server then holds. Every hardware-facing assertion checks
 * /api/config - the board (here, the fake) is the source of truth, and a test
 * that only reads the DOM would pass while the write silently failed. */

const get = async (page: Page, path: string) => (await page.request.get(path)).json();
const cfg = (page: Page) => get(page, "/api/config");
const status = (page: Page) => get(page, "/api/status");
const ranges = async (page: Page) => (await get(page, "/api/display"))?.y_ranges ?? {};
const tab = (page: Page, name: string) => page.locator(".view-tabs button", { hasText: name }).click();
const enter = async (field: Locator, value: string) => { await field.fill(value); await field.press("Enter"); };
const stopAcq = (page: Page) => page.getByRole("button", { name: /Disable Acquisition/ }).click();
/** Calibrations leave acquisition in whatever state they chose: settle it. */
const ensureStopped = async (page: Page) => {
  const b = page.getByRole("button", { name: /Disable Acquisition/ });
  if (await b.count()) await b.click();
  await expect(page.getByRole("button", { name: /Enable Acquisition/ })).toBeVisible();
};
const fire = async (page: Page, n: number) => {
  await page.locator(".test-trigger input").fill(String(n));
  await page.locator(".test-trigger button", { hasText: "Fire" }).click();
};
const ch0Offset = (page: Page) => page.locator(".tile-dc input[type=number]").first();
const tileMax = (page: Page) => page.locator(".tile").first().locator("button.ax.y.max");

/** Pixels painted on a canvas: any alpha, alpha > 40, or red (the TR0 line). */
const painted = (scope: Locator, kind: "any" | "solid" | "red") =>
  scope.evaluate((root: Element, k: string) => {
    const cv = (root as ParentNode).querySelector("canvas") as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (k === "red" ? d[i + 3] > 100 && d[i] > 180 && d[i + 1] < 130 : d[i + 3] > (k === "solid" ? 40 : 0)) n++;
    }
    return n;
  }, kind);
const tileCanvas = (page: Page) => painted(page.locator(".tile").first(), "any");

const record = async (page: Page) => {
  await page.locator(".rec-group button.record").click();
  await page.locator(".rec-modal button.record").click();
};
const stopRecording = async (page: Page) => {
  await page.locator("button.danger", { hasText: "Stop recording" }).click();
  // The click resolves before the server has closed the writer.
  await expect.poll(async () => (await status(page)).recording).toBe(false);
};
const deleteSession = async (page: Page, row: Locator) => {
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: /More/ }).click();
  await row.getByRole("menuitem", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The board opens on a background thread; controls unlock when it is up.
  await expect(page.locator(".hw-lock")).toBeEnabled({ timeout: 15_000 });
});

test("loads with the fake unit; bank 1 starts collapsed", async ({ page }) => {
  await expect(page.getByText("DT5742B-SIM")).toBeVisible();
  await expect(page.locator(".pill.state")).toHaveText("idle");
  await expect(page.locator(".tile")).toHaveCount(8);
  await page.locator(".bank-head", { hasText: "Bank 1" }).click();
  await expect(page.locator(".tile")).toHaveCount(16);
});

test("unit settings split: campaign on Experiment, trigger tuning on Live", async ({ page }) => {
  // Live: timing first, then the sources in order; no Sampling frequency.
  const trig = page.locator(".card", { has: page.locator("h2", { hasText: "Trigger Settings" }) });
  const labels = await trig.locator(".setting-row > label").allTextContents();
  expect(labels.slice(0, 2)).toEqual(["Post-trigger duration", "Trigger edge"]);
  const order = ["TRG-IN", "TR0", "Software trigger"].map((l) => labels.indexOf(l));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order[0]).toBeGreaterThan(1);
  await trig.getByRole("button", { name: "How triggers work" }).click();
  await page.getByRole("dialog", { name: "How triggers work" }).getByRole("button", { name: "OK" }).click();
  await expect(page.locator("main + aside .setting-row", { hasText: "Sampling frequency" })).toHaveCount(0);
  // Experiment: required first, then the lockable optionals.
  await tab(page, "Experiment");
  const grid = page.locator(".exp-grid .settings-grid").first();
  await expect(grid.locator("> *").nth(0)).toContainText("Sampling frequency");
  await expect(grid.getByRole("button", { name: "Lock Events per readout" })).toBeVisible();
});

test("TR threshold is shown in TR-calibrated volts, and the toast agrees", async ({ page }) => {
  // Fake default 20000 through UM4270 9.8.3: (20000 - 26214) / 13.2 mV.
  // Shown to as many digits as name the exact word ("-0.471" reads back 19997).
  const input = page.locator(".setting-row", { hasText: "TR threshold" }).first().locator('input[type="number"]');
  await expect(input).toHaveValue("-0.47076");
  // The toast once quoted the channel model: a positive volt for a negative threshold.
  await enter(input, "-0.049");
  await expect(page.getByText(/tr threshold: -0\.049 V/).first()).toBeVisible();
});

test("TR offset: locked by default, never moves the threshold, trigger line only at midscale", async ({ page }) => {
  const threshold = (await cfg(page)).groups[0].fast_trigger_threshold;
  const row = page.locator(".setting-row", { hasText: "TR DC offset" }).first();
  const off = row.locator('input[type="number"]');
  await expect(off).toBeDisabled();
  await row.getByRole("button", { name: "Unlock TR DC offset" }).click();

  await page.getByRole("button", { name: /Enable Acquisition/ }).click();
  const trCard = page.locator(".card", { has: page.locator("h2", { hasText: "fast trigger" }) });
  await expect(trCard).toBeVisible({ timeout: 10_000 });
  // The trigger line exists ONLY at TR offset 0x8000 (UM4270 sec 9.8.3).
  await enter(off, "0");
  await expect.poll(async () => (await cfg(page)).groups[0].fast_trigger_dc_offset).toBe(32768);
  await expect.poll(() => painted(trCard, "red"), { timeout: 10_000 }).toBeGreaterThan(50);
  await enter(off, "0.1");
  await expect.poll(async () => (await cfg(page)).groups[0].fast_trigger_dc_offset).not.toBe(32768);
  await expect.poll(() => painted(trCard, "red"), { timeout: 10_000 }).toBeLessThan(5);
  // RAW semantics: the threshold DAC is never rewritten behind the operator.
  expect((await cfg(page)).groups[0].fast_trigger_threshold).toBe(threshold);

  await enter(off, "0");
  await stopAcq(page);
  await row.getByRole("button", { name: "Lock TR DC offset" }).click();   // locks persist
});

test("the baseline guide is drawn when idle and follows the offset", async ({ page }) => {
  // The row with the most green pixels is the 0 V guide on the full-scale axis.
  const guideRow = () => page.evaluate(() => {
    const cv = document.querySelector(".tile canvas") as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let best = -1, bestN = 0;
    for (let y = 0; y < cv.height; y++) {
      let n = 0;
      for (let x = 0; x < cv.width; x++) {
        const p = (y * cv.width + x) * 4;
        if (d[p + 3] > 60 && d[p + 1] > 140 && d[p] < 130) n++;
      }
      if (n > bestN) { bestN = n; best = y; }
    }
    return { row: best, lit: bestN, height: cv.height };
  });
  // Power-on 0x8F00 is 0 V of offset (V1742 manual sec 5.7): guide centred.
  expect((await cfg(page)).channels[0].dc_offset).toBe(0x8F00);
  await expect(ch0Offset(page)).toHaveValue("0.000");
  const centred = await guideRow();
  expect(centred.lit).toBeGreaterThan(50);
  expect(Math.abs(centred.row - centred.height / 2)).toBeLessThan(centred.height * 0.1);
  // +0.2 V raises the window centre (UM4270 sec 9.1): 0 V sits LOWER.
  await enter(ch0Offset(page), "0.2");
  await expect.poll(async () => (await guideRow()).row).toBeGreaterThan(centred.row + 10);
  await enter(ch0Offset(page), "0");
});

test("DC offset: the slider commits one write on release; typing lands exactly", async ({ page }) => {
  const slider = page.locator(".dc-slider").first();
  await slider.focus();
  await slider.press("ArrowLeft");                  // one 0.01 V step; keyup commits
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset)
    .toBe(Math.round(0x8F00 + 32768 * -0.01));
  await expect(ch0Offset(page)).toHaveValue("-0.010");

  const want = Math.round(0x8F00 + 32768 * 0.1);
  await enter(ch0Offset(page), "0.1");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).toBe(want);
  // Enter keeps focus, so the next tweak needs no click.
  await expect(ch0Offset(page)).toBeFocused();
  await ch0Offset(page).press("ArrowUp");
  await ch0Offset(page).press("Enter");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).not.toBe(want);
});

test("global channel controls: window, reset, and fit window to pulses", async ({ page }) => {
  const bar = page.locator(".chan-global");
  const win = bar.locator(".cg-group").first();
  await win.locator(".cg-num").nth(0).fill("-0.2");
  await win.locator(".cg-num").nth(1).fill("0.2");
  await win.getByRole("button", { name: "set", exact: true }).click();
  await expect.poll(async () => {
    const y = await ranges(page);
    return [0, 7, 15].every((c) => JSON.stringify(y[String(c)]) === "[-0.2,0.2]");
  }).toBe(true);
  const reset = bar.getByRole("button", { name: "reset", exact: true });
  await reset.click();
  await expect.poll(async () => Object.keys(await ranges(page)).length).toBe(0);

  // Fit: display only, one height for all, the fake's ~-195 mV pulse inside.
  const before = await cfg(page);
  const seen = (await status(page)).events_seen;
  await fire(page, 20);
  await expect.poll(async () => (await status(page)).events_seen).toBeGreaterThan(seen + 20);
  await bar.getByRole("button", { name: "Fit window to pulses" }).click();
  await expect.poll(async () => Object.keys(await ranges(page)).length).toBeGreaterThan(0);
  const y = await ranges(page);
  expect(new Set(Object.values(y).map((r: any) => +(r[1] - r[0]).toFixed(4))).size).toBe(1);
  expect(y["0"][0]).toBeLessThan(-0.15);
  expect(y["0"][1]).toBeGreaterThan(0);
  expect((await cfg(page)).channels).toEqual(before.channels);
  await reset.click();
  await expect.poll(async () => Object.keys(await ranges(page)).length).toBe(0);
  await stopAcq(page);
});

test("a Y range typed on the axis is stored, sticks past +/-0.5 V, and survives a reload", async ({ page }) => {
  // A stale +/-0.5 V filter on the re-read path once threw such ranges away
  // ~1 s after saving - TR0's whole scale lives out there.
  await tileMax(page).click();
  await enter(page.locator(".tile").first().locator(".yedit input[type=number]"), "0.8");
  await expect(tileMax(page)).toHaveText("+0.800 V");
  // The min stays where full scale had it: code 0 = window centre - 0.5 V.
  const centre = ((await cfg(page)).channels[0].dc_offset - 0x8F00) / 32768;
  await expect.poll(async () => (await ranges(page))["0"]?.[1]).toBe(0.8);
  expect((await ranges(page))["0"][0]).toBeCloseTo(centre - 0.5, 6);
  await page.waitForTimeout(1600);                  // one status poll re-reads the prefs
  await expect(tileMax(page)).toHaveText("+0.800 V");
  await page.reload();
  await expect(tileMax(page)).toHaveText("+0.800 V");
});

test("'full' resets a channel to the full window, which follows the offset", async ({ page }) => {
  const tile = page.locator(".tile").first();
  await enter(ch0Offset(page), "0");
  await tileMax(page).click();
  await tile.locator(".yedit button", { hasText: "full" }).click();
  await expect(tileMax(page)).toHaveText("+0.500 V");
  await expect(tile.locator("button.ax.y.min")).toHaveText("-0.500 V");
  await enter(ch0Offset(page), "0.2");
  await expect(tileMax(page)).toHaveText("+0.700 V");
  await expect(tile.locator("button.ax.y.min")).toHaveText("-0.300 V");
  await enter(ch0Offset(page), "0");
});

test("sessions: save and apply restore the unit; a legacy file imports and applies", async ({ page }) => {
  const mark = (await cfg(page)).channels[0].dc_offset;
  await tab(page, "Experiment");
  await page.locator(".session-save input").fill("pw-test");
  await page.locator(".session-save button").click();
  const row = page.locator(".session-row", { hasText: "pw-test" });
  await expect(row).toBeVisible();

  await tab(page, "Live");
  await enter(ch0Offset(page), "-0.3");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).not.toBe(mark);
  await tab(page, "Experiment");
  await row.locator("button", { hasText: "Apply" }).click();
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).toBe(mark);
  await expect(page.getByText(/applied and read back/).first()).toBeVisible();
  await deleteSession(page, row);

  // Configuration B: onto the hidden input (the native chooser is not ours).
  const legacy = ["Module 125", "DRS4FREQ 0", "CHNOFFSE 47000 0 0", "CHNOFFSE 18536 4 1",
    "TR0OFFSE 32768", "TRG__TR0 20934", "TRGPOLAR 1", "POSTTRIG 0", "LEMO_LEV 0", "GPO_BUSY 1"].join("\n");
  const sessions = page.locator(".card", { has: page.locator("h2", { hasText: "Sessions" }) });
  await sessions.locator('input[type="file"]').setInputFiles(
    { name: "configB.txt", mimeType: "text/plain", buffer: Buffer.from(legacy) });
  await expect(page.getByText(/Imported as session "configB"/)).toBeVisible();
  const imported = page.locator(".session-row", { hasText: "configB" });
  await imported.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await cfg(page)).channels[12].dc_offset).toBe(18536);
  const c = await cfg(page);
  expect([c.gpo_output, c.trigger_edge, c.channels[0].dc_offset]).toEqual(["busy", "falling", 47000]);
  await deleteSession(page, imported);
});

test("Pulse Shift returns fitting channels to 0 V of offset; its pile shows in Overlay", async ({ page }) => {
  await enter(ch0Offset(page), "-0.3");
  await expect.poll(async () => (await cfg(page)).channels[0].dc_offset).toBeLessThan(28000);
  const btn = page.locator(".calib-btns button", { hasText: "Pulse Shift" });
  await expect(btn).toHaveAttribute("title", /slide a clipped pulse/);
  await btn.click();
  await expect(page.getByText(/Calibration done/)).toBeVisible({ timeout: 60_000 });
  // The fake's pulse fits at 0x8F00: back there, and never "centred".
  expect((await cfg(page)).channels.every((ch: { dc_offset: number }) => ch.dc_offset === 0x8F00)).toBe(true);
  await expect(ch0Offset(page)).toHaveValue("0.000");
  // The pile accumulates in every mode, so the calibration's events are there.
  await page.locator(".wave-mode button", { hasText: "Overlay" }).click();
  expect(await painted(page.locator(".tile").first(), "solid")).toBeGreaterThan(150);
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
  await ensureStopped(page);
});

test("overlay mode paints a density pile and the choice persists", async ({ page }) => {
  await page.getByRole("button", { name: /Enable Acquisition/ }).click();
  await page.locator(".wave-mode button", { hasText: "Overlay" }).click();
  await expect.poll(() => tileCanvas(page), { timeout: 10_000 }).toBeGreaterThan(500);
  await expect.poll(async () => (await get(page, "/api/display")).wave_mode).toBe("overlay");
  await page.reload();
  await expect(page.locator(".wave-mode button.on")).toHaveText("Overlay");
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
  await stopAcq(page);
});

test("scope mode free-runs triggers, takes a channel trigger, and stops when left", async ({ page }) => {
  await page.locator(".wave-mode button", { hasText: "Scope" }).click();
  await expect.poll(async () => (await status(page)).scope_hz).toBe(2);
  await expect(page.locator(".scope-rate input")).toHaveValue("2");
  const seen = (await status(page)).events_seen;
  await expect.poll(async () => (await status(page)).events_seen, { timeout: 10_000 }).toBeGreaterThan(seen);
  await expect.poll(() => tileCanvas(page), { timeout: 10_000 }).toBeGreaterThan(200);

  await enter(page.locator(".scope-rate input"), "5");
  await expect.poll(async () => (await status(page)).scope_hz).toBe(5);
  await page.locator(".scope-trig select").selectOption("0");
  await expect.poll(async () => (await status(page)).scope_trigger?.channel).toBe(0);
  await enter(page.locator(".scope-trig input"), "35");
  await expect.poll(async () => (await status(page)).scope_trigger?.level_mv).toBe(35);
  await page.locator(".scope-trig select").selectOption("");
  await expect.poll(async () => (await status(page)).scope_trigger ?? null).toBe(null);

  // Leaving scope stops the firing - no orphaned trigger source.
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
  await expect.poll(async () => (await status(page)).scope_hz).toBe(null);
  await stopAcq(page);
});

test("runs count per experiment, and the bar names the run", async ({ page }) => {
  // A new experiment starts at run 1 - a real value in the field, not a hint.
  await page.locator("#runname").fill("ui-suite");
  await expect(page.locator("#runno")).toHaveValue("1");
  await page.locator(".rec-group button.record").click();
  await expect(page.locator(".rec-modal h3")).toContainText("Run 1 · ui-suite");
  await expect(page.locator(".rec-dest")).toContainText("ui-suite/run_001/");
  await page.locator(".rec-modal textarea").fill("LuAG crystal, 3 GeV electrons");
  await page.locator(".rec-modal button.record").click();
  await expect(page.locator(".rec-group.on .rec-name")).toContainText("ui-suite · Run 1");
  await expect.poll(async () => (await status(page)).recorded).toBeGreaterThan(0);
  await stopRecording(page);

  const [run] = (await get(page, "/api/runs")).runs;
  expect(run).toEqual(expect.objectContaining({ id: "ui-suite/run_001", note: "LuAG crystal, 3 GeV electrons" }));
  expect(run.events).toBeGreaterThan(0);
  await expect(page.locator(".run-group-name").first()).toHaveText("ui-suite");

  // The number moves on by itself; an override and a label are respected,
  // and an empty note never blocks a shift in a hurry.
  await expect(page.locator("#runno")).toHaveValue("2");
  await page.locator("#runno").fill("42");
  await page.locator("#runlabel").fill("10GeV electrons");
  await record(page);
  await expect(page.locator(".rec-group.on .rec-name")).toContainText("ui-suite · Run 42 · 10GeV-electrons");
  await stopRecording(page);
  await expect.poll(async () => (await status(page)).experiments["ui-suite"]).toEqual([1, 42]);
  await expect(page.locator("#runno")).toHaveValue("43");
  await expect(page.locator("#runlabel")).toHaveValue("10GeV electrons");   // same conditions, usually
  await page.locator(".rec-clear").click();
  await page.locator("#runname").fill("ui-suite-2");
  await expect(page.locator("#runno")).toHaveValue("1");
});

test("a bounded recording closes itself at N events, acquisition keeps going", async ({ page }) => {
  await page.locator("#runname").fill("bounded");
  await page.locator("#recmax").fill("50");
  await record(page);
  await expect(page.locator(".rec-group.on")).toBeVisible();
  await expect(page.locator(".rec-group.on")).toHaveCount(0, { timeout: 15_000 });
  expect((await status(page)).running).toBe(true);
  await stopAcq(page);
  expect((await get(page, "/api/runs")).runs.find((r: any) => r.id === "bounded/run_001").events).toBe(50);
  await page.locator("#recmax").fill("");
});

test("a taken run number is refused until its folder is gone", async ({ page }) => {
  await page.locator("#runname").fill("redo");
  await record(page);
  await stopRecording(page);
  await page.locator("#runno").fill("1");
  await expect(page.locator("#runno.clash")).toBeVisible();
  await page.locator(".rec-group button.record").click();
  await expect(page.locator(".rec-dest")).toContainText("already exists");
  await expect(page.locator(".rec-modal button.record")).toBeDisabled();
  await page.locator(".rec-modal button", { hasText: "Cancel" }).click();
  // Deleted on disk (Explorer, or here): the same number records, no reload.
  expect((await page.request.delete("/api/runs/redo/run_001")).ok()).toBe(true);
  await expect(page.locator("#runno.clash")).toHaveCount(0);
  await record(page);
  await expect(page.locator(".rec-group.on .rec-name")).toContainText("redo · Run 1");
  await stopRecording(page);
  await stopAcq(page);
});

test("experiment conditions reach the server and the record dialog", async ({ page }) => {
  await tab(page, "Experiment");
  await page.locator(".cond-add").click();
  await page.locator(".cond-key").last().fill("XCET 40");
  await page.locator(".cond-val").last().fill("40 bar");
  await expect.poll(async () => (await get(page, "/api/conditions")).items
    .some((c: { key: string }) => c.key === "XCET 40")).toBe(true);
  await tab(page, "Live");
  await page.locator("#runname").fill("ui-suite");
  await page.locator(".rec-group button.record").click();
  await expect(page.locator(".cond-pill", { hasText: "XCET 40" })).toBeVisible();
  await page.locator(".rec-modal button", { hasText: "Cancel" }).click();
});

test("Experiment settings: out-of-range values clamp; locks grey out, write nothing, persist", async ({ page }) => {
  await tab(page, "Experiment");
  const events = page.locator(".setting-row", { hasText: "Events per readout" }).locator('input[type="number"]');
  await enter(events, "5000");
  await expect.poll(async () => (await cfg(page)).max_events_blt).toBe(1023);
  await expect(events).toHaveValue("1023");

  const row = page.locator(".settings-grid .setting-row", { hasText: "Dump format" }).first();
  const select = row.locator("select");
  const before = (await cfg(page)).output_format;
  await row.getByRole("button", { name: "Lock Dump format" }).click();
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue(before);         // protection, not concealment
  expect((await cfg(page)).output_format).toBe(before);
  // Only the optional settings (and TR DC offset) are lockable.
  await expect(page.locator(".settings-grid .setting-row", { hasText: "Sampling frequency" })
    .getByRole("button", { name: /Lock/ })).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".hw-lock")).toBeEnabled({ timeout: 15_000 });
  await expect(select).toBeDisabled();
  await row.getByRole("button", { name: "Unlock Dump format" }).click();
  await expect(select).toBeEnabled();
  await tab(page, "Live");
});

test("the average runs over an event count, persists, and Clear empties it", async ({ page }) => {
  // The averaged picture's truth is the telemetry the server streams.
  const tele = () => page.evaluate(() => new Promise<any>((res) => {
    const ws = new WebSocket(`ws://${location.host}/ws/telemetry`);
    ws.onmessage = (e) => { ws.close(); res(JSON.parse(e.data)); };
  }));
  await page.locator(".wave-mode button", { hasText: "Avg" }).click();
  const ctl = page.locator(".avg-ctl");
  await ctl.locator("select").selectOption("events");
  await enter(ctl.locator("input"), "5");
  await expect.poll(async () => (await tele()).avg).toEqual({ mode: "events", seconds: 1, events: 5 });
  await expect(page.locator(".grid-head h2")).toContainText("last 5 events");
  expect((await get(page, "/api/display")).avg.events).toBe(5);
  // Firing auto-starts acquisition; an event window holds only its last N...
  await fire(page, 12);
  await expect.poll(async () => (await tele()).channels["0"]?.count, { timeout: 10_000 }).toBe(5);
  // ...until Clear empties it (stopped first, or the fake's stream refills it).
  await stopAcq(page);
  await page.locator(".wave-clear button").click();
  await expect.poll(async () => (await tele()).channels["0"]?.count ?? 0).toBe(0);
  await ctl.locator("select").selectOption("time");
  await expect.poll(async () => (await tele()).avg.mode).toBe("time");
});

test("an update is offered once no run is recording, and a reload keeps the forms", async ({ page }) => {
  // What `daq update` leaves behind: a different bundle than this page loaded.
  await page.route("**/api/status", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), version: "99.0.0",
                                            ui_assets: ["/assets/index-next.js"] } });
  });
  const banner = page.locator(".update-banner");
  await page.request.post("/api/rec/start", { data: { name: "update-suite" } });
  await expect(page.locator(".rec-group.on")).toBeVisible();
  await expect(banner).toBeHidden();                // never mid-run...
  await page.request.post("/api/rec/stop");
  await expect(banner).toContainText("Update ready: DAQ 99.0.0");   // ...offered once it ends

  const fields = { "#runname": "cosmics", "#runno": "7", "#recmax": "5000", "#runlabel": "10GeV-electrons" };
  for (const [sel, v] of Object.entries(fields)) await page.locator(sel).fill(v);
  await banner.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator(".hw-lock")).toBeEnabled({ timeout: 15_000 });
  for (const [sel, v] of Object.entries(fields)) await expect(page.locator(sel)).toHaveValue(v);
  await banner.getByRole("button", { name: "Later" }).click();
  await expect(banner).toBeHidden();
});

test("0 V calibration: help, calibrate, applied, settings restored", async ({ page }) => {
  // LAST in the file on purpose: once stored, the calibration applies to
  // every later page load of this fake board.
  const state = page.locator(".zc-state");
  await expect(state).toContainText("nominal");
  await page.locator(".zc-help").click();
  const dlg = page.getByRole("dialog", { name: "Zero-Volt Calibration" });
  await expect(dlg).toContainText("Disconnect all inputs");
  await dlg.getByRole("button", { name: "OK" }).click();

  const before = await cfg(page);
  await page.locator(".zc-row button", { hasText: "Calibrate 0 V" }).click();
  // The fake is a dark bench with hardware triggers off, so it saves.
  await expect(state).toContainText("board-calibrated", { timeout: 60_000 });
  await expect(state).toHaveAttribute("title", /plots only, not to recorded data/);
  const zc = await get(page, "/api/zerocal");
  expect(zc.applied).toBe(true);
  // One point per input at its 0 V of offset: 2048 on a channel at 0x8F00,
  // 2200 on TR0 at 0x8000.
  expect(zc.channels["0"].ref_dac).toBe(0x8F00);
  expect(Math.abs(zc.channels["0"].zero_code - 2048)).toBeLessThan(5);
  expect(zc.channels["16"].ref_dac).toBe(0x8000);
  expect(Math.abs(zc.channels["16"].zero_code - 2200)).toBeLessThan(5);
  // The operator's settings come back exactly.
  const after = await cfg(page);
  expect(after.channels.map((c: any) => c.dc_offset)).toEqual(before.channels.map((c: any) => c.dc_offset));
  expect([after.groups, after.external_trigger, after.fast_trigger])
    .toEqual([before.groups, before.external_trigger, before.fast_trigger]);
});
