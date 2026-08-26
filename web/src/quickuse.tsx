import type { TourStep } from "./components/Tour";

/** The same instructions as the README's "Taking a shift", as a guided tour.
 *  It opens on a plain centred card so you know what you are about to be shown
 *  before anything starts pointing at parts of the screen. */
export const QUICK_USE: TourStep[] = [
  {
    title: "Quick use",
    body: (
      <>
        <p>A short walk through taking a run on this digitizer, in four steps:</p>
        <ol className="tour-steps">
          <li>Check the unit is connected</li>
          <li>Check your settings</li>
          <li>Watch, then record</li>
          <li>Collect the data</li>
        </ol>
        <p className="muted">Arrow keys move between steps. Escape closes.</p>
      </>
    ),
  },
  {
    target: ".conn",
    title: "1. Is the unit connected?",
    body: (
      <>
        <p>
          Green shows the model and serial of the digitizer this app is talking
          to. Red means no unit — press <b>Reconnect</b>, and check the box is
          powered and its USB cable is seated.
        </p>
        <p className="muted">
          While it is red every setting is disabled, because nothing can be sent.
        </p>
      </>
    ),
  },
  {
    target: "aside",
    placement: "left",
    title: "2. Check your settings",
    body: (
      <>
        <p>
          Banks, trigger source and post-trigger live here; each channel's DC
          offset is on its own chart. <b>Hover any row for an explanation.</b>
        </p>
        <p>
          Settings are written to the unit and read back, so what you see is what
          the hardware confirmed — not necessarily what was asked for.
        </p>
      </>
    ),
  },
  {
    target: ".run-controls",
    placement: "below-left",
    title: "3. Watch, then record",
    body: (
      <>
        <ol className="tour-steps">
          <li><b>Enable Acquisition</b> — live view, nothing written to disk.</li>
          <li>Check the traces and the trigger rate look right.</li>
          <li>Type a <b>Run name</b> and press <b>Record</b>.</li>
          <li><b>Stop recording</b> when done — the live view keeps running.</li>
        </ol>
        <p className="muted">
          Start only watches. Nothing is saved until you press Record.
        </p>
      </>
    ),
  },
  {
    target: ".runs-card",
    placement: "left",
    title: "4. Collect the data",
    body: (
      <>
        <p>
          Every run you have recorded, newest first, with its time, channel
          count, event count and size.
        </p>
        <p>
          <b>Download</b> gives you a zip of the whole run — one file per channel
          plus the settings it was taken with. The folder shown at the top is
          where they live on the DAQ machine.
        </p>
        <p className="muted">
          Delete asks you to type DELETE, and the run being recorded cannot be
          downloaded or deleted.
        </p>
      </>
    ),
  },
];
