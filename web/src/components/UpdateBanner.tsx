import { useState } from "react";
import { flushAll } from "../flush";
import type { Status } from "../types";

/** The bundle files this page was loaded from, as the server lists them in
 *  status.ui_assets. Empty under the Vite dev server, which serves sources
 *  rather than a bundle - and there is nothing to compare there. */
function loadedAssets(): string[] {
  const refs = Array.from(document.querySelectorAll("script[src], link[href]"))
    .map((el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "")
    .map((ref) => new URL(ref, window.location.href).pathname)
    .filter((path) => path.startsWith("/assets/"));
  return [...new Set(refs)].sort();
}

const LOADED = loadedAssets();
const SNOOZE_MS = 30 * 60 * 1000;

interface Props {
  status: Status | null;
  recording: boolean;
}

/** "Update ready - Reload": shown when the server is serving a different UI
 *  than this page was loaded from (after `daq update`, or a `git pull` under
 *  a running server). Held back while a run is recording - nobody should be
 *  invited to reload in the middle of one - and offered as soon as it ends. */
export function UpdateBanner({ status, recording }: Props) {
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [reloading, setReloading] = useState(false);

  const served = status?.ui_assets;
  const stale = LOADED.length > 0 && !!served?.length
    && served.join("\n") !== LOADED.join("\n");
  // The status poll re-renders every couple of seconds, which is what lets
  // a snooze run out without a timer of its own.
  if (!stale || recording || Date.now() < snoozedUntil) return null;

  const reload = async () => {
    setReloading(true);
    try {
      await flushAll();             // an edit still on its debounce goes first
    } finally {
      window.location.reload();
    }
  };

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="update-mark" aria-hidden="true">↻</span>
      <div className="update-text">
        <div className="update-title">
          Update ready{status?.version ? `: DAQ ${status.version}` : ""}
        </div>
        <div className="muted">
          Reload this window to use it. Run settings and drafts are kept.
        </div>
      </div>
      <button className="primary" onClick={reload} disabled={reloading}>
        {reloading ? "Reloading…" : "Reload"}
      </button>
      <button onClick={() => setSnoozedUntil(Date.now() + SNOOZE_MS)}
        title="Hide this for 30 minutes">
        Later
      </button>
    </div>
  );
}
