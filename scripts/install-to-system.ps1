# install-to-system.ps1 - installs LangGUI as a standalone app into
# %LOCALAPPDATA%\Programs\LangGUI so it can run without this dev repo.
# Re-registers the per-user "LangGUI" scheduled task to point at the install dir.
#
# Data (SQLite, vector DB, OAuth tokens, memory, agents, models, MCP config,
# whitelist) lives at %USERPROFILE%\.langgui and is shared between the dev
# repo and the installed copy - so "migration" is automatic: the same user
# reads the same database.
#
# Usage (no admin required):
#   powershell -ExecutionPolicy Bypass -File scripts\install-to-system.ps1
#
# To run with a custom install location:
#   powershell -ExecutionPolicy Bypass -File scripts\install-to-system.ps1 -InstallDir 'D:\Apps\LangGUI'

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\LangGUI'),
  [switch]$SkipBuild,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskName = 'LangGUI'

function Step([string]$msg) { Write-Host ("==> " + $msg) -ForegroundColor Cyan }
function Info([string]$msg) { Write-Host ("    " + $msg) -ForegroundColor DarkGray }

# â”€â”€ Sanity checks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
  throw "package.json not found at $RepoRoot - run this from the langGUI repo."
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

# â”€â”€ 1. Stop existing instance so we can overwrite files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Step "Stopping any existing LangGUI instance"
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

# â”€â”€ 2. Build (standalone) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (-not $SkipBuild) {
  Push-Location $RepoRoot
  try {
    if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
      Step "Installing build dependencies (npm ci)"
      & $npm ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    }
    Step "Building production bundle (next build, output=standalone)"
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
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

# â”€â”€ 3. Wipe & recreate install dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Step "Replacing install dir at $InstallDir"
if (Test-Path $InstallDir) {
  Remove-Item -Path $InstallDir -Recurse -Force
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

# â”€â”€ 4. Copy standalone bundle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

# Stamp a version marker so we know which commit produced this install.
$commit = try { (& git -C $RepoRoot rev-parse --short HEAD).Trim() } catch { 'unknown' }
@{
  installedAt   = (Get-Date).ToString('o')
  commit        = $commit
  sourceRepo    = $RepoRoot
  node          = $nodeCmd.Source
  port          = 4312
  dbDir         = (Join-Path $env:USERPROFILE '.langgui')
} | ConvertTo-Json | Set-Content -Path (Join-Path $InstallDir 'install.json') -Encoding UTF8

Info "files copied:"
Get-ChildItem $InstallDir | ForEach-Object { Info ("  " + $_.Name) }

# â”€â”€ 5. Re-register scheduled task pointing at the install dir â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
Step "Registering scheduled task '$TaskName' -> $InstallDir\launcher.ps1"
$launcher = Join-Path $InstallDir 'launcher.ps1'

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument ("-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $launcher + "`"") `
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
  -Description ("LangGUI standalone install at " + $InstallDir + " - auto-start at logon on http://localhost:4312")

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null

# â”€â”€ 6. Quick verification: data dir + run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
$dbDir  = Join-Path $env:USERPROFILE '.langgui'
$dbFile = Join-Path $dbDir 'langgui.db'
Step "Verifying data dir"
if (Test-Path $dbFile) {
  $sz = [math]::Round(((Get-Item $dbFile).Length / 1KB), 1)
  Info ("OK - " + $dbFile + " (" + $sz + " KB)")
  Info "Your existing config + memory + agents + models will load automatically."
} else {
  Info "No existing $dbFile - a fresh DB will be created on first run."
}

if (-not $NoStart) {
  Step "Starting LangGUI now"
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  Info "Tail the log to watch boot:"
  Info ("  Get-Content `"" + (Join-Path $env:LOCALAPPDATA 'LangGUI\logs\app.log') + "`" -Tail 30 -Wait")
}

Write-Host ""
Write-Host "Installed LangGUI commit $commit at $InstallDir" -ForegroundColor Green
Write-Host "  URL:    http://localhost:4312"
Write-Host "  Data:   $env:USERPROFILE\.langgui  (shared with this repo)"
Write-Host "  Logs:   $env:LOCALAPPDATA\LangGUI\logs\app.log"
Write-Host "  Stop:   Stop-ScheduledTask  -TaskName LangGUI"
Write-Host "  Start:  Start-ScheduledTask -TaskName LangGUI"
Write-Host "  Off:    scripts\uninstall-from-system.ps1"
Write-Host ""
Write-Host "The repo at $RepoRoot is now only needed for development / rebuilding." -ForegroundColor DarkGray

