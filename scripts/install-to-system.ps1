# install-to-system.ps1 - installs Jarela as a standalone app into
# %LOCALAPPDATA%\Programs\Jarela so it can run without this dev repo.
# Re-registers the per-user "Jarela" scheduled task to point at the install dir.
#
# Data (SQLite, vector DB, OAuth tokens, memory, agents, models, MCP config,
# whitelist) lives at %USERPROFILE%\.jarela and is shared between the dev
# repo and the installed copy - so "migration" is automatic: the same user
# reads the same database.
#
# Usage (no admin required):
#   powershell -ExecutionPolicy Bypass -File scripts\install-to-system.ps1
#
# To run with a custom install location:
#   powershell -ExecutionPolicy Bypass -File scripts\install-to-system.ps1 -InstallDir 'D:\Apps\Jarela'

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Jarela'),
  [switch]$SkipBuild,
  [switch]$NoStart,
  [switch]$SkipTailscale
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskName = 'Jarela'

function Step([string]$msg) { Write-Host ("==> " + $msg) -ForegroundColor Cyan }
function Info([string]$msg) { Write-Host ("    " + $msg) -ForegroundColor DarkGray }

# ── Sanity checks ──────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
  throw "package.json not found at $RepoRoot - run this from the jarela repo."
}

$npmCmd  = Get-Command npm.cmd  -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) { throw "npm not found on PATH. Install Node.js first." }
$npm = $npmCmd.Source

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { $nodeCmd = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCmd) { throw "node not found on PATH. Install Node.js first." }
Info ("node: " + $nodeCmd.Source)
Info ("npm:  " + $npm)
Info ("repo: " + $RepoRoot)
Info ("dest: " + $InstallDir)

# ── 1. Stop existing instance so we can overwrite files ────────────────────
Step "Stopping any existing Jarela instance"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
}
$busy = Get-NetTCPConnection -LocalPort 4312 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $busy) {
  try {
    Info ("killing PID " + $c.OwningProcess + " on :4312")
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  } catch {}
}
Start-Sleep -Milliseconds 500

# ── 2. Build (standalone) ──────────────────────────────────────────────────
if (-not $SkipBuild) {
  Push-Location $RepoRoot
  try {
    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
      Step "Installing build dependencies (npm ci)"
      & $npm ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }
    Step "Building production bundle (next build, output=standalone)"
    # PowerShell 7's $PSNativeCommandUseErrorActionPreference treats any
    # stderr line from a native command as a terminating error when
    # $ErrorActionPreference = 'Stop'. Next writes "Compiled with warnings"
    # to stderr even on a successful build, which would falsely abort us.
    # Scope a local override around the build invocation.
    $prevNative = $PSNativeCommandUseErrorActionPreference
    try {
      $PSNativeCommandUseErrorActionPreference = $false
      & $npm run build
      if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
      $PSNativeCommandUseErrorActionPreference = $prevNative
    }
  } finally {
    Pop-Location
  }
}

$standalone = Join-Path $RepoRoot '.next\standalone'
$staticSrc  = Join-Path $RepoRoot '.next\static'
$publicSrc  = Join-Path $RepoRoot 'public'
$serverJs   = Join-Path $standalone 'server.js'

if (-not (Test-Path $serverJs)) {
  throw "Standalone build missing at $serverJs. Re-run without -SkipBuild."
}

# -- 2.5. Stop any existing supervisor + server cleanly ---------------------
# Stop-ScheduledTask only stops *new* triggers; it does not kill the
# powershell/wscript/node processes the running task already spawned. Without
# this step a reinstall would race against the still-running supervisor: the
# new launcher and the old one each spawn a node, one collides on port 4312,
# rapid-respawns 5x, and the rate limiter trips. The dir wipe below also
# fails partially because node has handles open in the install tree.
Step "Stopping existing supervisor + server (if any)"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$installDirEsc = [Regex]::Escape($InstallDir)
$victims = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and (
      # Our VBS shim + the PowerShell launcher it spawns.
      ($_.CommandLine -match "$installDirEsc.*launcher\.(vbs|ps1)") -or
      # The node server running out of the install dir.
      ($_.Name -eq 'node.exe' -and $_.CommandLine -match "$installDirEsc.*server\.js")
    )
  }
foreach ($v in $victims) {
  Info ("  killing PID " + $v.ProcessId + " (" + $v.Name + ")")
  try { Stop-Process -Id $v.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
# Belt-and-suspenders: kill any process still running from the install dir,
# excluding this installer process itself.
$selfPid = $PID
$extraVictims = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ProcessId -ne $selfPid -and
    $_.CommandLine -and
    $_.CommandLine -match $installDirEsc
  }
foreach ($v in $extraVictims) {
  Info ("  killing stray PID " + $v.ProcessId + " (" + $v.Name + ")")
  try { Stop-Process -Id $v.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
# Also free the port in case some unrelated squatter is on it. Skip our own
# node � that was just killed above.
$busy = Get-NetTCPConnection -LocalPort 4312 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $busy) {
  try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 1

# -- 3. Clear contents of install dir (in place � never delete the dir) -----
# We used to `Remove-Item $InstallDir -Recurse` + `New-Item`, but that breaks
# whenever Windows Search Indexer / Defender / Explorer holds a transient
# handle on the directory itself (the directory contents delete fine, but the
# empty directory then refuses to be removed). Clearing contents in place is
# tolerant of that � the dir handle stays valid; we only touch files inside.
Step "Clearing install dir contents at $InstallDir"
if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# First pass: mirror an empty directory into the install dir. This deletes
# stale files that are no longer part of the current standalone bundle.
$emptyMirror = Join-Path $env:TEMP ("jarela-empty-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $emptyMirror -Force | Out-Null
try {
  & robocopy $emptyMirror $InstallDir /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $rc = $LASTEXITCODE
  if ($rc -ge 8) {
    throw "robocopy mirror clear failed (exit $rc)"
  }
} finally {
  try { Remove-Item -LiteralPath $emptyMirror -Recurse -Force -ErrorAction SilentlyContinue } catch {}
}

# Second pass: explicit remove for anything still left.
Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
  try { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop }
  catch { Info ("  could not remove: " + $_.FullName + " - " + $_.Exception.Message) }
}

# Hard guarantee: never continue with a mixed tree. Abort install if cleanup
# leaves anything behind, so we do not copy a new build over stale code.
$leftovers = Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue
if ($leftovers.Count -gt 0) {
  $sample = ($leftovers | Select-Object -First 10 -ExpandProperty FullName) -join "`n"
  throw "Install dir is not empty after cleanup. Refusing to continue to avoid stale code.`n$sample"
}

# ── 4. Copy standalone bundle ──────────────────────────────────────────────
# The .next/standalone tree contains: server.js, the minimum node_modules,
# package.json, and a hollow .next/ directory we need to fill with /static.
Step "Copying standalone bundle"
Copy-Item -Path (Join-Path $standalone '*') -Destination $InstallDir -Recurse -Force

# server.js expects /static at .next/static and the PWA / icons at /public.
$nextDir = Join-Path $InstallDir '.next'
if (-not (Test-Path $nextDir)) { New-Item -ItemType Directory -Path $nextDir | Out-Null }
Copy-Item -Path $staticSrc -Destination (Join-Path $nextDir 'static') -Recurse -Force
Copy-Item -Path $publicSrc -Destination (Join-Path $InstallDir 'public') -Recurse -Force

# Drop the launcher next to server.js.
Copy-Item -Path (Join-Path $RepoRoot 'scripts\installed-launcher.ps1') `
          -Destination (Join-Path $InstallDir 'launcher.ps1') -Force
# Drop the VBS shim that launches the .ps1 fully hidden (no console at all).
# `powershell.exe -WindowStyle Hidden` is not reliable when the launcher
# spawns a child via `Start-Process -NoNewWindow` � the shared console can
# flash to the foreground. wscript.exe with intWindowStyle=0 avoids that.
Copy-Item -Path (Join-Path $RepoRoot 'scripts\installed-launcher.vbs') `
          -Destination (Join-Path $InstallDir 'launcher.vbs') -Force

# Stamp a version marker so we know which commit produced this install.
$commit = try { (& git -C $RepoRoot rev-parse --short HEAD).Trim() } catch { 'unknown' }
@{
  installedAt   = (Get-Date).ToString('o')
  commit        = $commit
  sourceRepo    = $RepoRoot
  node          = $nodeCmd.Source
  port          = 4312
  dbDir         = (Join-Path $env:LOCALAPPDATA 'Jarela')
} | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'install.json') -Encoding UTF8

Info "files copied:"
Get-ChildItem $InstallDir | ForEach-Object { Info ("  " + $_.Name) }

# ── 5. Re-register scheduled task pointing at the install dir ──────────────
$launcherPs1 = Join-Path $InstallDir 'launcher.ps1'
$launcherVbs = Join-Path $InstallDir 'launcher.vbs'
Step "Registering scheduled task '$TaskName' -> $launcherVbs"

# Invoke launcher.vbs via wscript.exe. wscript has no console at all, so
# no window flashes at logon — unlike `powershell.exe -WindowStyle Hidden`
# which can briefly flash on some Windows builds. The VBS shim immediately
# launches launcher.ps1 with intWindowStyle=0 and bWaitOnReturn=True so
# Task Scheduler's MultipleInstances=IgnoreNew bookkeeping works.
$action = New-ScheduledTaskAction `
  -Execute 'wscript.exe' `
  -Argument ('"' + $launcherVbs + '"') `
  -WorkingDirectory $InstallDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -RestartCount 999 `
  -MultipleInstances IgnoreNew

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description ("Jarela standalone install at " + $InstallDir + " - auto-start at logon on http://localhost:4312")

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null

# ── 6. Quick verification: data dir + run ──────────────────────────────────
$dbDir  = Join-Path $env:LOCALAPPDATA 'Jarela'
$dbFile = Join-Path $dbDir 'jarela.db'
Step "Verifying data dir"
if (Test-Path $dbFile) {
  $sz = [math]::Round(((Get-Item $dbFile).Length / 1KB), 1)
  Info ("OK - " + $dbFile + " (" + $sz + " KB)")
  Info "Your existing config + memory + agents + models will load automatically."
} else {
  Info "No existing $dbFile - a fresh DB will be created on first run."
}

if (-not $NoStart) {
  Step "Starting Jarela now"
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  Info "Tail the log to watch boot:"
  Info ("  Get-Content `"" + (Join-Path $env:LOCALAPPDATA 'Jarela\logs\app.log') + "`" -Tail 30 -Wait")
}

# ── 7. Optional: configure tailscale serve for remote access ─────────────────
if (-not $SkipTailscale) {
  $tsScript = Join-Path $RepoRoot 'scripts\install-tailscale-serve.ps1'
  if (Test-Path $tsScript) {
    Step "Configuring tailscale serve (skip with -SkipTailscale)"
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $tsScript -Port 4312
    } catch {
      Info ("  tailscale serve setup skipped: " + $_.Exception.Message)
    }
  }
}

Write-Host ""
Write-Host "Installed Jarela commit $commit at $InstallDir" -ForegroundColor Green
Write-Host "  URL:    http://localhost:4312"
Write-Host "  Data:   $env:LOCALAPPDATA\Jarela  (Windows default, see ADR-0006)"
Write-Host "  Logs:   $env:LOCALAPPDATA\Jarela\logs\app.log"
Write-Host "  Stop:   Stop-ScheduledTask  -TaskName Jarela"
Write-Host "  Start:  Start-ScheduledTask -TaskName Jarela"
Write-Host "  Off:    scripts\uninstall-from-system.ps1"
Write-Host ""
Write-Host "The repo at $RepoRoot is now only needed for development / rebuilding." -ForegroundColor DarkGray

