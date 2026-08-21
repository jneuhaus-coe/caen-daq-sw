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
function Die  ($m) { Write-Host " xx $m" -ForegroundColor Red; exit 1 }

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
$toolBin = (uv tool dir --bin 2>$null)
if (-not $toolBin) { $toolBin = "$env:USERPROFILE\.local\bin" }
$daqBin = Join-Path $toolBin 'daq.exe'

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
    if ($rt.pid) { Stop-Process -Id $rt.pid -Force -ErrorAction SilentlyContinue }
    $restartHint = $true
} else {
    # No usable record — fall back to finding the process by name.
    $running = @(Get-Process -Name daq -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        $pids = ($running | ForEach-Object { $_.Id }) -join ', '
        Warn "A daq server is running (pid $pids) but did not record a port we can"
        Warn 'reach, so this installer cannot check whether it is recording.'
        Die  'Stop it yourself (daq stop), then re-run this installer.'
    }
}

if ($restartHint) {
    foreach ($i in 1..10) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Name daq -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-Process -Name daq -ErrorAction SilentlyContinue) {
        Die 'The running daq did not exit. Stop it yourself, then re-run this installer.'
    }

    # A service manager set to restart unconditionally brings it straight back,
    # and the install then fails against a locked daq.exe. Say what is actually
    # happening instead of leaving a file-in-use error to be deciphered.
    Start-Sleep -Seconds 4
    if (Get-Process -Name daq -ErrorAction SilentlyContinue) {
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
Say "Installing $Pkg on Python $PyVer"
uv tool install --python $PyVer --force $Spec
if ($LASTEXITCODE -ne 0) { Die 'uv tool install failed.' }
# Only when it is needed, and never fatally: uv errors out if the directory is
# already on PATH, and with ErrorActionPreference=Stop a native command's stderr
# becomes a terminating error — which would kill the script after a good install.
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
