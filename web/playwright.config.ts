import { defineConfig } from "@playwright/test";
import * as path from "path";

/** UI tests against a real server running the FAKE backend (DAQ_BACKEND=fake):
 * settings stick, events are synthetic, no hardware anywhere. The server gets
 * its own state dir and data dir under test-results/, so a run can never
 * touch the real runtime record, sessions, display prefs, or recorded runs -
 * and never collides with a live daq on 8800.
 *
 * The tests mutate one shared server's state, so they run in ONE worker, in
 * file order. Keep them independent of each other where possible and mindful
 * of order where not.
 */
// ESM package ("type": "module"), so no __dirname; Node 20.11+ provides this.
const here = import.meta.dirname;
const stateDir = path.resolve(here, "test-results", "daq-state");
const dataDir = path.resolve(here, "test-results", "daq-runs");

export default defineConfig({
  testDir: "tests/ui",
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:8801",
    trace: "retain-on-failure",
  },
  webServer: {
    // Local dev runs through uv; CI installs the package with pip and
    // overrides this with a plain `python -m daq ...`.
    command:
      process.env.DAQ_TEST_SERVER_CMD ??
      "uv run --managed-python --python 3.11 python -m daq --serve --host 127.0.0.1 --port 8801",
    cwd: path.resolve(here, "..", "server"),
    url: "http://127.0.0.1:8801/api/status",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DAQ_BACKEND: "fake",
      DAQ_DATA_DIR: dataDir,
      // Both platforms' state roots, so the test server is isolated wherever
      // it runs (LOCALAPPDATA on Windows, XDG_STATE_HOME elsewhere).
      LOCALAPPDATA: stateDir,
      XDG_STATE_HOME: stateDir,
    },
  },
});
