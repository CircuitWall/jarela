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

# Check whether something is already listening on $Port. Two cases:
#   (a) An older launcher's `node server.js` from THIS install dir is still
#       serving — adopt it (wait on its PID) instead of killing+respawning.
#       This is what kept tripping the 5-in-60s rate-limiter: a duplicate
#       launcher would kill the working node, the surviving launcher's
#       WaitForExit would return, and both would race to respawn.
#   (b) Anything else (different cwd, not node, etc.) — that's a true squatter;
#       kill it.
function Get-PortOwnerProcess([int]$port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-IsOurServer($p) {
  # Detect a node child spawned by a previous launcher.ps1 instance for THIS
  # install dir. We can't rely on the node CommandLine alone — PowerShell's
  # Start-Process invokes node as `"node.exe" server.js` with working dir set
  # separately, so the InstallDir is not part of the command line. Instead,
  # walk to the parent process and look for our launcher.ps1.
  if (-not $p) { return $false }
  if ($p.Name -ne 'node.exe') { return $false }
  if ("$($p.CommandLine)" -notmatch '\bserver\.js\b') { return $false }
  $ppid = $p.ParentProcessId
  if (-not $ppid) { return $false }
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $ppid" -ErrorAction SilentlyContinue
  if (-not $parent) { return $false }
  $parentCmd = "$($parent.CommandLine)"
  $escaped   = [Regex]::Escape($InstallDir)
  return ($parentCmd -match "$escaped.*launcher\.ps1")
}

# Poll-based wait on a child PID. The Process object returned by
# `Start-Process -NoNewWindow -PassThru -RedirectStandardOutput X
# -RedirectStandardError Y` has a long-standing bug on Windows where
# WaitForExit() can return *before* the child actually exits — the parent
# PowerShell disposes the handle eagerly because its stdio redirection is
# set up, but the child keeps running. Symptom: rapid duplicate node spawns
# colliding on port 4312, EADDRINUSE, rate-limit trip. Polling Get-Process
# by PID asks the OS directly and is immune to this quirk. ($pid is a
# reserved variable in PowerShell, so use $childPid.)
function Wait-ProcessExit([int]$childPid) {
  while ($true) {
    $live = Get-Process -Id $childPid -ErrorAction SilentlyContinue
    if (-not $live) { return }
    Start-Sleep -Seconds 3
  }
}

$owner = Get-PortOwnerProcess $Port
if ($owner) {
  if (Test-IsOurServer $owner) {
    Write-Log "Port $Port already served by our node PID $($owner.ProcessId); adopting (no respawn)."
    Wait-ProcessExit $owner.ProcessId
    Write-Log "Adopted node PID $($owner.ProcessId) exited; entering supervisor loop."
  } else {
    Write-Log "Killing stale PID $($owner.ProcessId) ($($owner.Name)) holding port $Port"
    try { Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 1
  }
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
  Wait-ProcessExit $proc.Id
  Write-Log "server.js exited (PID $($proc.Id))"

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
