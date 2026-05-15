# installed-launcher.ps1 — runtime launcher that ships alongside the standalone
# Next.js server.js in the installed app directory. Has no dependency on this
# repo, npm, or `npm run build`. The install script (install-to-system.ps1)
# copies this file into the install directory.
#
# Responsibilities:
#   - Start `node server.js` on port 4312 with HOSTNAME=127.0.0.1
#   - Pipe stdout/stderr to a rolling log
#   - Free port 4312 if a stale process is squatting on it
#   - Supervisor loop with rate-limited restart so Task Scheduler can take over
#     if we go into a crash loop

$ErrorActionPreference = 'Stop'

$InstallDir = $PSScriptRoot
$LogDir     = Join-Path $env:LOCALAPPDATA 'LangGUI\logs'
$LogFile    = Join-Path $LogDir 'app.log'
$Port       = 4312

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $LogFile -Value $line
}

# Roll the log if it grows past ~5 MB; keep the 5 most recent rotations.
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 5MB)) {
  $rotated = Join-Path $LogDir ("app-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item -Force $LogFile $rotated
  Get-ChildItem $LogDir -Filter 'app-*.log' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 5 |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

Set-Location $InstallDir
Write-Log "=== LangGUI launcher starting (install=$InstallDir) ==="

# Locate node.exe — Task Scheduler may run with a sparse PATH.
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCmd) { $nodeCmd = Get-Command node -ErrorAction SilentlyContinue }
if (-not $nodeCmd) {
  Write-Log "FATAL: node not found on PATH. Install Node.js or add it to PATH."
  exit 1
}
$node = $nodeCmd.Source
Write-Log "node: $node"

$serverJs = Join-Path $InstallDir 'server.js'
if (-not (Test-Path $serverJs)) {
  Write-Log "FATAL: server.js missing at $serverJs. Run install-to-system.ps1 again."
  exit 1
}

# Free the port if a stale process is squatting on it.
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

# Environment variables Next.js standalone respects.
$env:PORT     = "$Port"
$env:HOSTNAME = '127.0.0.1'
$env:NODE_ENV = 'production'

# Separate files for the node child's stdout/stderr. The launcher writes its
# own supervisor messages to $LogFile; Start-Process cannot share that handle
# with a child or it fails silently on Windows ("file is in use").
$ServerOut = Join-Path $LogDir 'server.out.log'
$ServerErr = Join-Path $LogDir 'server.err.log'

# Supervisor loop: respawn server.js if it exits. Bail after too many rapid
# restarts so Task Scheduler can retry the whole task.
$restartCount = 0
$windowStart  = Get-Date

while ($true) {
  Write-Log "Starting 'node server.js' on http://127.0.0.1:$Port (out=$ServerOut)"
  $proc = Start-Process -FilePath $node `
            -ArgumentList 'server.js' `
            -WorkingDirectory $InstallDir `
            -NoNewWindow `
            -PassThru `
            -RedirectStandardOutput $ServerOut `
            -RedirectStandardError  $ServerErr
  if (-not $proc) {
    Write-Log "FATAL: Start-Process returned null for node server.js"
    Start-Sleep -Seconds 5
    exit 1
  }
  Write-Log "spawned node PID $($proc.Id)"
  $proc.WaitForExit()
  Write-Log "server.js exited with code $($proc.ExitCode)"

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
