# DT5742B DAQ installer - Windows.
#
#   irm https://raw.githubusercontent.com/jneuhaus-coe/caen-daq-sw/main/install.ps1 | iex
#
# Re-run it any time to update to the newest release.
#
# Environment:
#   $env:DAQ_VERSION = 'v0.2.0'   install that tagged release instead of the newest
#   $env:DAQ_VERSION = 'source'   build from the tip of main instead of a release (needs git)

#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo    = 'jneuhaus-coe/caen-daq-sw'
$Pkg     = 'dt5742b-daq'
$PyVer   = '3.11'
$Version = if ($env:DAQ_VERSION) { $env:DAQ_VERSION } else { 'latest' }

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host " !  $m" -ForegroundColor Yellow }
# throw, not exit: this script is normally run as `irm ... | iex`, and `exit`
# inside Invoke-Expression terminates the caller's PowerShell session - closing
# the window on the very message the user needs to read.
function Die  ($m) { Write-Host " xx $m" -ForegroundColor Red; throw $m }

# --- 1. uv, which also supplies a known-good 64-bit Python -------------------
# Letting uv provide the interpreter removes the 32/64-bit mismatch against the
# CAEN DLLs, which is the most common way this install goes wrong on Windows.
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Say 'Installing uv (package manager + managed Python)'
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Die 'uv installed but is not on PATH. Open a new terminal and re-run.'
}
Say "uv $((uv --version) -split ' ' | Select-Object -Index 1)"

# Ask uv where the executable goes rather than trusting PATH: a leftover `daq`
# from an older pip install shadows the new one and makes an update look like a
# no-op, which is a miserable thing to debug over the phone.
# Anything uv prints that is not a usable path - a warning, an error, a future
# change of format - would otherwise reach Join-Path and fail with "Cannot find
# drive", which says nothing about what actually went wrong.
function Get-UvPath {
    param([string[]]$UvArgs, [string]$Fallback)
    $value = $null
    try { $value = (& uv @UvArgs | Select-Object -First 1) } catch { $value = $null }
    if ($value) { $value = $value.Trim() }
    if ($value -and (Test-Path -IsValid -Path $value)) { return $value }
    if ($value) { Warn "uv $UvArgs returned something unusable ('$value'); using $Fallback" }
    return $Fallback
}

$toolBin  = Get-UvPath -UvArgs @('tool', 'dir', '--bin') -Fallback "$env:USERPROFILE\.local\bin"
$daqBin   = Join-Path $toolBin 'daq.exe'
$toolRoot = Get-UvPath -UvArgs @('tool', 'dir') -Fallback "$env:USERPROFILE\AppData\Roaming\uv\tools"

# Find the server by where its executable lives, not by process name. The
# detached server runs as pythonw.exe from inside the uv tool environment, so
# `Get-Process -Name daq` never sees it - and uv then fails to replace that
# environment with "Access is denied", because a file in it is still open.
function Get-DaqProcesses {
    param([string]$Root)
    $found = @()
    # An empty root would match every process on the machine via StartsWith.
    if ([string]::IsNullOrWhiteSpace($Root)) { return , $found }
    foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $proc.Path } catch { $path = $null }   # protected processes throw
        if (-not $path) { continue }
        if ($path.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
            $found += $proc
        }
    }
    # daq.exe lives in the bin directory rather than the tool environment.
    $found += @(Get-Process -Name daq -ErrorAction SilentlyContinue)
    , ($found | Sort-Object -Property Id -Unique)
}

# --- 2. Stop a server that is already running --------------------------------
# Windows will not let a running executable be replaced, so an update simply
# fails if the server is still up. Refuse rather than kill blind when a run is
# recording, or when the server is somewhere we cannot ask.
$restartHint = $false

# Where the running server records its pid and port. Reading it beats guessing:
# the server may be on any port, and on a host with a port-forward a probe of the
# default port can reach an entirely different machine's server.
$stateBase = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
$runtimeFile = Join-Path $stateBase 'dt5742b-daq\runtime.json'
$rt = $null
if (Test-Path $runtimeFile) {
    try { $rt = Get-Content -Raw $runtimeFile | ConvertFrom-Json } catch { $rt = $null }
}

# The runtime file is a hint: it outlives crashes. Confirm by asking the port.
$status = $null
if ($rt -and $rt.port) {
    try {
        $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$($rt.port)/api/status" -TimeoutSec 3
        if ($answer.app -eq 'dt5742b-daq') { $status = $answer }
    } catch { }
}

if ($status) {
    if ($status.recording) {
        Warn "A run is recording: $($status.run_id)"
        Die  'Stop the recording, then re-run this installer.'
    }
    Say "Stopping the running server (pid $($rt.pid) on port $($rt.port))"
    if ($rt.pid) {
        # Confirm the pid is still one of ours before killing it: pids are
        # recycled, and the record may have outlived the process that wrote it.
        $target = @(Get-DaqProcesses -Root $toolRoot) | Where-Object { $_.Id -eq $rt.pid }
        if ($target) {
            Stop-Process -Id $rt.pid -Force -ErrorAction SilentlyContinue
        } else {
            Warn "pid $($rt.pid) is no longer a daq process; not killing it."
        }
    }
    $restartHint = $true
} else {
    # No usable record - fall back to finding it by where it runs from.
    $running = @(Get-DaqProcesses -Root $toolRoot)
    if ($running.Count -gt 0) {
        $pids = ($running | ForEach-Object { $_.Id }) -join ', '
        Warn "A daq server is running (pid $pids) but did not record a port we can"
        Warn 'reach, so this installer cannot check whether it is recording.'
        Die  'Stop it yourself (daq stop), then re-run this installer.'
    }
}

if ($restartHint) {
    # Wait generously: a slow graceful shutdown is not a reason to abort an
    # update, and a false "it did not exit" sends someone hunting a process that
    # is already on its way out.
    foreach ($i in 1..30) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-DaqProcesses -Root $toolRoot)) { break }
    }
    $left = @(Get-DaqProcesses -Root $toolRoot)
    if ($left) {
        foreach ($proc in $left) {
            Warn ("still running: {0} (pid {1})" -f $proc.ProcessName, $proc.Id)
        }
        Warn 'uv cannot replace files these are using.'
        Die  'Stop them (daq stop, or end them in Task Manager), then re-run this installer.'
    }

    # A service manager set to restart unconditionally brings it straight back,
    # and the install then fails against a locked daq.exe. Say what is actually
    # happening instead of leaving a file-in-use error to be deciphered.
    Start-Sleep -Seconds 4
    if (Get-DaqProcesses -Root $toolRoot) {
        Warn 'The server came back on its own - something is restarting it.'
        Warn 'Stop the service (Task Scheduler task, or NSSM/Windows service) for'
        Warn 'the update, then re-run this installer.'
        Die  'Refusing to update underneath a server that keeps restarting.'
    }
}

# --- 3. Work out what to install --------------------------------------------
$GitSpec = "$Pkg @ git+https://github.com/$Repo#subdirectory=server"

function Resolve-Wheel {
    $api = if ($Version -eq 'latest') {
        "https://api.github.com/repos/$Repo/releases/latest"
    } else {
        "https://api.github.com/repos/$Repo/releases/tags/$Version"
    }
    try {
        $rel = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'daq-installer' }
        ($rel.assets | Where-Object { $_.name -like '*.whl' } |
            Select-Object -First 1 -ExpandProperty browser_download_url)
    } catch { $null }
}

$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)

if ($Version -eq 'source') {
    if (-not $hasGit) { Die 'DAQ_VERSION=source needs git installed.' }
    Say 'Building from the tip of main'
    $Spec = $GitSpec
} else {
    $wheel = Resolve-Wheel
    if ($wheel) {
        Say "Release: $(Split-Path $wheel -Leaf)"
        $Spec = "$Pkg @ $wheel"
    } elseif ($hasGit) {
        Warn "No published release found for '$Version' - building from main instead."
        $Spec = $GitSpec
    } else {
        Die "No release found for '$Version' and git is not installed to build from source."
    }
}

# --- 4. Install --------------------------------------------------------------

# Call uv directly. An earlier version wrapped it in Start-Process to impose a
# timeout, which was a mistake twice over: the returned object's ExitCode is
# frequently $null, so a perfectly good install read as a failure and the retry
# then uninstalled it; and Start-Process does not quote its arguments, which
# would split the PEP 508 spec ("dt5742b-daq @ https://...") into three. Native
# invocation quotes properly and sets $LASTEXITCODE reliably.

$envDir = Join-Path $toolRoot $Pkg
$installed = $false

# uv takes an exclusive lock on its tools directory, so another uv - typically
# one orphaned by a Ctrl-C on an earlier run - makes this one wait in silence.
$otherUv = @(Get-Process -Name uv -ErrorAction SilentlyContinue)
if ($otherUv.Count -gt 0) {
    foreach ($proc in $otherUv) {
        $started = '?'
        try { $started = $proc.StartTime } catch { }   # throws if not queryable
        Warn ("another uv is already running: pid {0}, started {1}" -f $proc.Id, $started)
    }
    Warn 'It holds a lock on the uv tools directory, so this install will wait for it.'
    Warn 'If it is left over from an interrupted run, end it: Stop-Process -Name uv -Force'
}

foreach ($attempt in 1..3) {
    Say "Installing $Pkg on Python $PyVer (attempt $attempt of 3)"
    if ($attempt -gt 1) {
        uv tool install --python $PyVer --force --verbose $Spec
    } else {
        uv tool install --python $PyVer --force $Spec
    }
    $code = $LASTEXITCODE

    # What is on disk decides, not the exit code. uv can report oddly while
    # having installed perfectly well, and the cost of believing it is that the
    # retry deletes a working install.
    $works = $false
    if (Test-Path $daqBin) {
        try {
            & $daqBin --version | Out-Null
            $works = ($LASTEXITCODE -eq 0)
        } catch { $works = $false }
    }

    if ($works) {
        if ($code -ne 0) {
            Warn "uv exited $code, but $daqBin is installed and runs - continuing."
        }
        $installed = $true
        break
    }

    if ($attempt -lt 3) {
        Warn "install attempt $attempt did not produce a working daq (uv exit $code)."
        Warn 'clearing the tool environment and trying again...'
        # try/catch, not a redirect: `2>&1` turns a native command's stderr into
        # error records, which terminate under ErrorActionPreference=Stop.
        try { uv tool uninstall $Pkg | Out-Null } catch { }
        if (Test-Path $envDir) {
            Remove-Item -Recurse -Force $envDir -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 3
    }
}

if (-not $installed) {
    Warn 'The install did not complete. The usual causes, in order:'
    Warn '  1. Something is still using the tool environment. Close any daq'
    Warn "     window, run 'daq stop', and look for pythonw.exe in Task Manager."
    Warn "  2. The console is in selection mode - click it and press Esc, since"
    Warn '     that pauses whatever is running.'
    Warn "  3. An orphaned uv holding the tools lock: Stop-Process -Name uv -Force"
    Warn "  4. A wedged download cache: uv cache clean"
    Warn "  5. Remove the environment by hand and re-run: $envDir"
    Die  'uv tool install failed.'
}

# Only when it is needed, and never fatally: uv errors out if the directory is
# already on PATH, and with ErrorActionPreference=Stop a native command's stderr
# becomes a terminating error - which would kill the script after a good install.
if (($env:Path -split ';') -notcontains $toolBin) {
    try { uv tool update-shell | Out-Null } catch { }
}

if (-not (Test-Path $daqBin)) { Die "install finished but no daq.exe was produced in $toolBin." }

$onPath = (Get-Command daq -ErrorAction SilentlyContinue).Source
if ($onPath -and $onPath -ne $daqBin) {
    Warn "A different 'daq' comes first on your PATH: $onPath"
    Warn "That one will run instead of the version just installed ($daqBin)."
    Warn "Remove it, or put $toolBin earlier on PATH."
}

# --- 5. Preflight: the CAEN stack, which we cannot install for you ------------
Say 'Checking CAEN prerequisites'
$missing = $false

function Find-CaenDll {
    $roots = @($env:Path -split ';') + @(
        "$env:ProgramFiles\CAEN\Digitizers\Library\bin",
        "${env:ProgramFiles(x86)}\CAEN\Digitizers\Library\bin",
        "$env:SystemRoot\System32"
    )
    foreach ($d in $roots) {
        if ([string]::IsNullOrWhiteSpace($d)) { continue }
        $p = Join-Path $d 'CAENDigitizer.dll'
        if (Test-Path -LiteralPath $p) { return $p }
    }
    $null
}

# Read the PE header's machine word. A 32-bit CAEN DLL cannot be loaded by the
# 64-bit Python uv just installed, and the error it produces is unhelpful, so
# catch it here where we can say what is actually wrong.
function Get-DllBitness ($path) {
    try {
        $fs = [IO.File]::OpenRead($path)
        $br = New-Object IO.BinaryReader($fs)
        $fs.Position = 0x3C
        $peOffset = $br.ReadInt32()
        $fs.Position = $peOffset + 4
        $machine = $br.ReadUInt16()
        $br.Close(); $fs.Close()
        switch ($machine) { 0x8664 { '64-bit' } 0x014c { '32-bit' } default { 'unknown' } }
    } catch { 'unknown' }
}

$dll = Find-CaenDll
if ($dll) {
    $bits = Get-DllBitness $dll
    Write-Host "    ok  CAENDigitizer.dll found ($bits): $dll" -ForegroundColor Green
    if ($bits -eq '32-bit') {
        Warn 'That DLL is 32-bit and cannot be loaded by 64-bit Python.'
        Warn 'Install the 64-bit CAEN libraries.'
        $missing = $true
    }
} else {
    Warn 'CAENDigitizer.dll NOT found on PATH or in the usual CAEN directories.'
    Warn 'Install CAEN''s Windows bundle (CAENDigitizer, CAENComm, CAENVMELib) and'
    Warn 'its USB driver, then make sure the CAEN library bin directory is on PATH.'
    $missing = $true
}

# --- 6. What to do next ------------------------------------------------------
$ver = try { & $daqBin --version 2>$null } catch { $Pkg }
if (-not $ver) { $ver = $Pkg }
Write-Host ''
Write-Host "Installed: $ver"
Write-Host ''
Write-Host '  daq                    open the DAQ (starts the server if needed)'
Write-Host '  daq --host 0.0.0.0     serve to the network'
Write-Host '  daq --help             all options'
Write-Host ''
Write-Host 'Runs are written to %USERPROFILE%\daq-runs.'
if ($restartHint) {
    Write-Host ''
    Say 'The server that was running has been stopped - start it again with the command above.'
}
if ($missing) {
    Write-Host ''
    Warn 'Install the CAEN items above before the unit will open.'
}
if (-not $onPath) {
    Write-Host ''
    Warn "Open a new terminal to get 'daq' on PATH."
}
