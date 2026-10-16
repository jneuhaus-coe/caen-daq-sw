"""The stage-1 worker processes.

Separate processes, not threads: the passes are numpy-heavy, and threads in
the server's interpreter would compete with the readout for the GIL - the
one thing the live view was built never to do. Each worker lowers its own
priority on start, so on a busy beamline PC the DAQ always wins the CPU.

Daemon processes, so a server shutdown never waits on a pass in progress.
They loop over two queues, previews first, so a new selection shows
something within seconds even while full passes are still queued.
"""
from __future__ import annotations

import os
import queue
import sys
import traceback

from . import cache
from . import features


def lower_priority() -> None:
    try:
        if os.name == "nt":
            import ctypes
            k = ctypes.WinDLL("kernel32")
            # Declared explicitly: ctypes' default int return would truncate
            # the HANDLE (see runtime._win_kernel32 for the bug that taught us).
            k.GetCurrentProcess.restype = ctypes.c_void_p
            k.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            k.SetPriorityClass.restype = ctypes.c_int
            BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
            k.SetPriorityClass(k.GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS)
        else:
            os.nice(10)
    except Exception:
        pass                    # best effort: a normal-priority pass still works


def cancel_flag(job_id: str) -> str:
    return os.path.join(cache.cache_dir(), f"cancel_{job_id}")


def _run(task, results) -> None:
    job_id, kind, path, proc, fsig, psig, stop = task
    flag = cancel_flag(job_id)
    if os.path.exists(flag):
        results.put(("cancelled", job_id, None))
        return
    results.put(("progress", job_id, 0.0))
    last = [0.0]

    def progress(frac):
        if frac - last[0] >= 0.02 or frac >= 1.0:
            last[0] = frac
            results.put(("progress", job_id, frac))

    out = features.run_pass(path, proc, stop=stop, progress=progress,
                            cancelled=lambda: os.path.exists(flag))
    if out is None:
        results.put(("cancelled", job_id, None))
        return
    table, avg_x, avg_t = out
    n = table.shape[1]
    if kind == "full":
        cache.save_features(fsig, psig, table)
        if avg_x is not None:
            cache.save_avg(fsig, avg_x, avg_t, n)
        results.put(("done", job_id, {"events": n}))
    else:
        results.put(("done", job_id, {"events": n, "table": table,
                                      "avg": (avg_x, avg_t, n)}))


def loop(preview_q, full_q, results, cache_dir: str) -> None:
    cache.set_dir(cache_dir)
    lower_priority()
    while True:
        try:
            task = preview_q.get_nowait()
        except queue.Empty:
            try:
                task = full_q.get(timeout=0.5)
            except queue.Empty:
                continue
        if task is None:
            return
        try:
            _run(task, results)
        except Exception as e:
            detail = "".join(traceback.format_exception_only(type(e), e)).strip()
            results.put(("error", task[0], detail))
            print(traceback.format_exc(), file=sys.stderr) if sys.stderr else None
