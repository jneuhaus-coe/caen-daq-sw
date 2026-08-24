"""Logging for the DAQ.

Everything the server does goes through here, so that a problem reported from a
long way away can be answered from a file rather than from memory. Two sinks:

- the console, at the level you asked for, compact enough to watch during a run;
- a rotating file at DEBUG, always, so the detail exists even when nobody was
  watching the console at the time.

uvicorn's own loggers are folded into the same stream, so the HTTP layer and the
hardware layer appear in one chronological account instead of two.
"""
from __future__ import annotations

import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from typing import Optional

from . import runtime

LEVELS = ("debug", "info", "warning", "error")

_MAX_BYTES = 2_000_000
_KEEP = 5

_configured = False


def log_dir() -> str:
    return os.path.join(runtime.state_dir(), "logs")


def default_log_path() -> str:
    return os.path.join(log_dir(), "daq.log")


def configure(level: str = "info", log_file: Optional[str] = None,
              to_file: bool = True) -> Optional[str]:
    """Set up console and file logging. Returns the log file path, if any.

    Safe to call more than once; the second call replaces the first.
    """
    global _configured

    numeric = getattr(logging, level.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)          # handlers decide what actually shows
    for handler in list(root.handlers):
        root.removeHandler(handler)
        try:
            handler.close()
        except Exception:
            pass

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(numeric)
    console.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S"))
    root.addHandler(console)

    path = None
    if to_file:
        path = log_file or default_log_path()
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            file_handler = RotatingFileHandler(
                path, maxBytes=_MAX_BYTES, backupCount=_KEEP, encoding="utf-8")
            file_handler.setLevel(logging.DEBUG)
            file_handler.setFormatter(logging.Formatter(
                "%(asctime)s %(levelname)-7s [%(name)s] %(message)s"))
            root.addHandler(file_handler)
        except OSError as e:
            # A log we cannot write is not a reason to refuse to run.
            path = None
            logging.getLogger("daq").warning(
                "could not open log file %s: %s", log_file or default_log_path(), e)

    # uvicorn configures its own handlers by default, which would duplicate every
    # line and bypass the file. Hand its loggers to ours instead.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True

    _configured = True
    return path


def get(name: str = "daq") -> logging.Logger:
    return logging.getLogger(name)
