"""Quick Look's side of the server: hands stage-1 passes to the worker
processes and answers "what do we have for this run right now?".

`table_for` never blocks: it returns the full table if cached, else the
preview if one has landed, else nothing yet - and makes sure the missing
work is queued. A change of processing settings cancels the now-pointless
passes for the old settings, queued or running.
"""
from __future__ import annotations

import multiprocessing as mp
import os
import threading
from collections import OrderedDict

from .. import logsetup
from . import cache
from . import features
from . import worker

log = logsetup.get("daq.quicklook")

PREVIEW_KEEP = 64


def _n_workers() -> int:
    return max(1, min(2, (os.cpu_count() or 2) - 2))


class QuickLook:
    def __init__(self):
        self._lock = threading.Lock()
        self._started = False
        self._jobs: dict[str, dict] = {}            # job id -> state
        self._preview: OrderedDict = OrderedDict()  # (fsig, psig) -> table
        self._avg: OrderedDict = OrderedDict()      # fsig -> (x, t, n) preview avg
        self._latest_psig: dict[str, str] = {}      # fsig -> psig last asked for

    # ---- workers ----
    def _start(self) -> None:
        if self._started:
            return
        ctx = mp.get_context("spawn")
        self._preview_q = ctx.Queue()
        self._full_q = ctx.Queue()
        self._results = ctx.Queue()
        self._procs = []
        for i in range(_n_workers()):
            p = ctx.Process(target=worker.loop, name=f"quicklook-{i}",
                            args=(self._preview_q, self._full_q, self._results,
                                  cache.cache_dir()),
                            daemon=True)
            p.start()
            self._procs.append(p)
        threading.Thread(target=self._collect, name="quicklook-results",
                         daemon=True).start()
        self._started = True
        logsetup.did(log, f"Starting {len(self._procs)} Quick Look worker(s) "
                          "at low priority", "Ok")

    def _collect(self) -> None:
        while True:
            try:
                kind, job_id, payload = self._results.get()
            except (EOFError, OSError):
                return
            with self._lock:
                job = self._jobs.get(job_id)
                if job is None:
                    continue
                if kind == "progress":
                    job["state"], job["frac"] = "running", payload
                elif kind == "done":
                    job["state"], job["frac"] = "done", 1.0
                    job["events"] = payload.get("events")
                    if "table" in payload:
                        key = (job["fsig"], job["psig"])
                        self._preview[key] = payload["table"]
                        self._preview.move_to_end(key)
                        while len(self._preview) > PREVIEW_KEEP:
                            self._preview.popitem(last=False)
                        self._avg[job["fsig"]] = payload["avg"]
                        while len(self._avg) > PREVIEW_KEEP:
                            self._avg.popitem(last=False)
                    self._clear_flag(job_id)
                elif kind == "error":
                    job["state"], job["error"] = "error", payload
                    log.warning("Quick Look could not read %s: %s",
                                job["path"], payload)
                elif kind == "cancelled":
                    job["state"] = "cancelled"
                    self._clear_flag(job_id)

    @staticmethod
    def _clear_flag(job_id: str) -> None:
        try:
            os.unlink(worker.cancel_flag(job_id))
        except OSError:
            pass

    def _submit(self, kind, path, proc, fsig, psig) -> None:
        job_id = f"{kind}-{fsig}-{psig}"
        job = self._jobs.get(job_id)
        if job and job["state"] in ("queued", "running", "done"):
            return
        self._clear_flag(job_id)
        self._jobs[job_id] = {"state": "queued", "frac": 0.0, "path": path,
                              "fsig": fsig, "psig": psig, "kind": kind}
        stop = features.PREVIEW_EVENTS if kind == "preview" else None
        (self._preview_q if kind == "preview" else self._full_q).put(
            (job_id, kind, path, proc, fsig, psig, stop))

    def _cancel_other(self, fsig: str, psig: str) -> None:
        for job_id, job in self._jobs.items():
            if job["fsig"] == fsig and job["psig"] != psig \
                    and job["state"] in ("queued", "running"):
                try:
                    open(worker.cancel_flag(job_id), "w").close()
                except OSError:
                    pass
                job["state"] = "cancelling"

    # ---- the one question stage 2 asks ----
    def table_for(self, path: str, proc: dict) -> dict:
        """{"state": full|preview|pending|error, "table", "frac", "error",
        "events"} for one run file under the given (normalized) settings."""
        fsig = cache.file_sig(path)
        psig = cache.proc_sig(proc)
        full = cache.load_features(fsig, psig)
        if full is not None:
            return {"state": "full", "table": full, "frac": 1.0,
                    "events": full.shape[1]}
        with self._lock:
            self._start()
            if self._latest_psig.get(fsig) != psig:
                self._cancel_other(fsig, psig)
                self._latest_psig[fsig] = psig
            fjob = self._jobs.get(f"full-{fsig}-{psig}")
            if fjob and fjob["state"] == "error":
                return {"state": "error", "table": None, "frac": 0.0,
                        "error": fjob.get("error")}
            if fjob and fjob["state"] == "done":
                # Landed between our cache check and now.
                full = cache.load_features(fsig, psig)
                if full is not None:
                    return {"state": "full", "table": full, "frac": 1.0,
                            "events": full.shape[1]}
            preview = self._preview.get((fsig, psig))
            if preview is None:
                self._submit("preview", path, proc, fsig, psig)
            self._submit("full", path, proc, fsig, psig)
            fjob = self._jobs[f"full-{fsig}-{psig}"]
            pjob = self._jobs.get(f"preview-{fsig}-{psig}")
            if preview is None and pjob and pjob["state"] == "error":
                return {"state": "error", "table": None, "frac": 0.0,
                        "error": pjob.get("error")}
            return {"state": "preview" if preview is not None else "pending",
                    "table": preview, "frac": fjob.get("frac", 0.0),
                    "events": None if preview is None else preview.shape[1]}

    def avg_for(self, path: str):
        """(avg x (18,L), avg t (2,L), events) - the full run's if a full
        pass finished, else the preview's, else None."""
        fsig = cache.file_sig(path)
        a = cache.load_avg(fsig)
        if a is not None:
            return a
        with self._lock:
            return self._avg.get(fsig)
