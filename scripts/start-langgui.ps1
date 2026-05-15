# start-langgui.ps1 — production launcher for LangGUI on Windows.
# Invoked by the "LangGUI" scheduled task at user logon. Also safe to run manually:
#   powershell -ExecutionPolicy Bypass -File scripts\start-langgui.ps1
#
# Responsibilities:
#   1. Find the repo root (one level above this script).
#   2. Ensure node_modules + .next build artifacts exist (auto-install/build on first run
#      or after a fresh pull).
#   3. Run `npm run start` on port 4312, piping stdout/stderr to a rolling log.
#   4. If the server crashes, wait a short backoff and restart (Task Scheduler also
#      restarts the wrapper itself if this script exits abnormally).

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir   = Join-Path $env:LOCALAPPDATA 'LangGUI\logs'
$LogFile  = Join-Path $LogDir 'app.log'
$Port     = 4312

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line
}

# Roll the log if it grows past ~5 MB.
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
  $rotated = Join-Path $LogDir ("app-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item -Force $LogFile $rotated
  # Keep only the 5 most recent rotated files.
  Get-ChildItem $LogDir -Filter 'app-*.log' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 5 |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

Set-Location $RepoRoot
Write-Log "=== LangGUI launcher starting (cwd=$RepoRoot) ==="

# Locate npm — Task Scheduler may run with a sparse PATH.
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) {
  Write-Log "FATAL: npm not found on PATH. Install Node.js or add it to PATH."
  exit 1
}
$npm = $npmCmd.Source
Write-Log "npm: $npm"

# Install dependencies if missing.
if (-not (Test-Path (Join-Path $RepoRoot 'node_modules'))) {
  Write-Log "node_modules missing — running 'npm ci' (this may take a few minutes)..."
  & $npm ci 2>&1 | Tee-Object -FilePath $LogFile -Append | Out-Null
}

# Build if .next is missing.
if (-not (Test-Path (Join-Path $RepoRoot '.next'))) {
  Write-Log "No .next build found — running 'npm run build'..."
  & $npm run build 2>&1 | Tee-Object -FilePath $LogFile -Append | Out-Null
}

# Free the port if a stale process is squatting on it (rare, but happens after a crash).
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  foreach ($c in $busy) {
    try {
      Write-Log "Killing stale PID $($c.OwningProcess) holding port $Port"
      Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    } catch {}
  }
  Start-Sleep -Seconds 1
}

# Supervisor loop: respawn next start if it exits. Exit the wrapper after too many
# rapid restarts so Task Scheduler can take over (it will retry the whole task).
$restartCount = 0
$windowStart  = Get-Date

while ($true) {
  Write-Log "Starting 'npm run start' on port $Port"
  $proc = Start-Process -FilePath $npm -ArgumentList 'run','start' `
            -WorkingDirectory $RepoRoot `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $LogFile `
            -RedirectStandardError  $LogFile
  $proc.WaitForExit()
  Write-Log "next start exited with code $($proc.ExitCode)"

  # Five crashes within 60 s → give up and let Task Scheduler restart us.
  if (((Get-Date) - $windowStart).TotalSeconds -gt 60) {
    $restartCount = 0
    $windowStart  = Get-Date
  }
  $restartCount++
  if ($restartCount -ge 5) {
    Write-Log "Too many rapid restarts ($restartCount in <60s). Exiting; Task Scheduler will retry."
    exit 1
  }
  Start-Sleep -Seconds 2
}
