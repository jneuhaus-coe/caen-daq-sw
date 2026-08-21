#!/usr/bin/env bash
# DT5742B DAQ installer — Linux (and macOS, for development only).
#
#   curl -fsSL https://raw.githubusercontent.com/jneuhaus-coe/caen-daq-sw/main/install.sh | bash
#
# Re-run it any time to update to the newest release.
#
# Environment:
#   DAQ_VERSION=v0.2.0   install that tagged release instead of the newest
#   DAQ_VERSION=source   build from the tip of main instead of a release (needs git)

set -euo pipefail

REPO="jneuhaus-coe/caen-daq-sw"
PKG="dt5742b-daq"
PYTHON_VERSION="3.11"
VERSION="${DAQ_VERSION:-latest}"

if [ -t 1 ]; then B=$'\033[1m'; Y=$'\033[33m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
else B=""; Y=""; R=""; G=""; N=""; fi
say()  { printf '%s==>%s %s\n' "$B" "$N" "$*"; }
warn() { printf '%s !%s  %s\n'  "$Y" "$N" "$*" >&2; }
die()  { printf '%s xx%s %s\n'  "$R" "$N" "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required."

# --- 1. uv, which also supplies a known-good 64-bit Python -------------------
# Installing Python this way is deliberate: it removes the interpreter-bitness
# mismatch that is otherwise the most common way this install goes wrong.
if ! command -v uv >/dev/null 2>&1; then
    say "Installing uv (package manager + managed Python)"
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
    # shellcheck disable=SC1091
    [ -f "$HOME/.local/bin/env" ] && . "$HOME/.local/bin/env"
    export PATH="$HOME/.local/bin:$PATH"
fi
command -v uv >/dev/null 2>&1 || die "uv installed but is not on PATH; open a new shell and re-run."
say "uv $(uv --version | awk '{print $2}')"

# --- 2. Work out what to install --------------------------------------------
GIT_SPEC="$PKG @ git+https://github.com/$REPO#subdirectory=server"

resolve_wheel() {
    local api
    if [ "$VERSION" = "latest" ]; then
        api="https://api.github.com/repos/$REPO/releases/latest"
    else
        api="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
    fi
    curl -fsSL "$api" 2>/dev/null \
        | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.whl"' \
        | head -1 | sed 's/.*"\(https[^"]*\)"/\1/'
}

if [ "$VERSION" = "source" ]; then
    command -v git >/dev/null 2>&1 || die "DAQ_VERSION=source needs git installed."
    say "Building from the tip of main"
    SPEC="$GIT_SPEC"
else
    WHEEL="$(resolve_wheel || true)"
    if [ -n "$WHEEL" ]; then
        say "Release: $(basename "$WHEEL")"
        SPEC="$PKG @ $WHEEL"
    elif command -v git >/dev/null 2>&1; then
        warn "No published release found for '$VERSION' — building from main instead."
        SPEC="$GIT_SPEC"
    else
        die "No release found for '$VERSION' and git is not installed to build from source."
    fi
fi

# --- 3. Install --------------------------------------------------------------
say "Installing $PKG on Python $PYTHON_VERSION"
uv tool install --python "$PYTHON_VERSION" --force "$SPEC"
uv tool update-shell >/dev/null 2>&1 || true

# Ask uv where it put the executable rather than trusting PATH: a leftover `daq`
# from an older pip install shadows the new one and makes an update look like a
# no-op, which is a miserable thing to debug over the phone.
TOOL_BIN="$(uv tool dir --bin 2>/dev/null || echo "$HOME/.local/bin")"
DAQ_BIN="$TOOL_BIN/daq"
[ -x "$DAQ_BIN" ] || die "install finished but no 'daq' executable was produced in $TOOL_BIN."

ON_PATH="$(command -v daq 2>/dev/null || true)"
if [ -n "$ON_PATH" ] && [ "$ON_PATH" != "$DAQ_BIN" ]; then
    warn "A different 'daq' comes first on your PATH: $ON_PATH"
    warn "That one will run instead of the version just installed ($DAQ_BIN)."
    warn "Remove it (e.g. pip uninstall dt5742b-daq) or put $TOOL_BIN earlier on PATH."
fi

# --- 4. Preflight: the CAEN stack, which we cannot install for you ------------
say "Checking CAEN prerequisites"
missing=0
if ldconfig -p 2>/dev/null | grep -q "libCAENDigitizer" \
   || ls /usr/lib/libCAENDigitizer.so* /usr/local/lib/libCAENDigitizer.so* >/dev/null 2>&1; then
    printf '   %sok%s  libCAENDigitizer found\n' "$G" "$N"
else
    warn "libCAENDigitizer NOT found. Install CAENDigitizer, CAENComm and CAENVMELib from CAEN."
    missing=1
fi
if lsmod 2>/dev/null | grep -q "CAENUSBdrvB"; then
    printf '   %sok%s  CAENUSBdrvB kernel module loaded\n' "$G" "$N"
elif [ "$(uname -s)" = "Linux" ]; then
    warn "CAENUSBdrvB is not loaded. Without it the unit will not open (OpenDigitizer returns -1)."
    warn "Install it with dkms so a kernel upgrade does not silently break it."
    missing=1
fi

# --- 5. What to do next ------------------------------------------------------
echo
printf '%sInstalled:%s %s\n' "$B" "$N" "$($DAQ_BIN --version 2>/dev/null || echo "$PKG")"
echo
echo "  daq                    serve on 127.0.0.1:8000 (this machine only)"
echo "  daq --host 0.0.0.0     serve to the network"
echo "  daq --help             all options"
echo
echo "Then open http://127.0.0.1:8000/ — runs are written to ~/daq-runs."
if [ "$missing" -eq 1 ]; then
    echo
    warn "Install the CAEN items above before the unit will open."
fi
if [ -z "$ON_PATH" ]; then
    echo
    warn "Open a new shell (or: export PATH=\"$TOOL_BIN:\$PATH\") to get 'daq' on PATH."
fi
exit 0
