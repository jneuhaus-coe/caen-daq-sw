"""Runtime checks that need no test dependencies, so they can run inside the
installed tool environment on Windows as well as in CI on Linux.

These exist because the Windows paths here are the ones that have actually
broken: `process_alive` was answering "still running" for every pid, because
ctypes truncated the 64-bit HANDLE from OpenProcess to 32 bits.

Run: `python tests/test_runtime.py` from the server/ dir.
"""
import os
import subprocess
import sys

from daq import runtime


def test_process_alive_for_self():
    assert runtime.process_alive(os.getpid()) is True


def test_process_alive_for_a_pid_that_cannot_exist():
    assert runtime.process_alive(0x7FFFFFFE) is False


def test_process_alive_follows_a_child_from_running_to_gone():
    """The one that matters: a truncated handle made this always True, so
    `daq stop` reported "still running" about a process it had just killed."""
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        assert runtime.process_alive(child.pid) is True, "a live child read as dead"
    finally:
        child.kill()
        child.wait()
    assert runtime.process_alive(child.pid) is False, "a dead child read as alive"


def test_url_and_state_paths_are_absolute():
    assert runtime.url_for("0.0.0.0", 8800) == "http://127.0.0.1:8800/"
    assert os.path.isabs(runtime.state_dir())
    assert os.path.isabs(runtime.runtime_path())


if __name__ == "__main__":
    for fn in [test_process_alive_for_self,
               test_process_alive_for_a_pid_that_cannot_exist,
               test_process_alive_follows_a_child_from_running_to_gone,
               test_url_and_state_paths_are_absolute]:
        fn()
        print("ok:", fn.__name__)
    print("ALL RUNTIME TESTS PASSED")
