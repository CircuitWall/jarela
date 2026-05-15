# uninstall-from-system.ps1 — remove the installed LangGUI (default
# %LOCALAPPDATA%\Programs\LangGUI) and its scheduled task. Does NOT touch
# %USERPROFILE%\.langgui (the SQLite database, OAuth tokens, memory, etc.).

[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\LangGUI'),
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'
$TaskName = 'LangGUI'
$Port     = 4312

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "No scheduled task named '$TaskName'."
}

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $busy) {
  try {
    Write-Host ("Stopping PID " + $c.OwningProcess + " on port " + $Port)
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  } catch {}
}

if (Test-Path $InstallDir) {
  Remove-Item -Path $InstallDir -Recurse -Force
  Write-Host "Removed install dir $InstallDir."
} else {
  Write-Host "Install dir $InstallDir does not exist."
}

if ($PurgeData) {
  $dbDir = Join-Path $env:USERPROFILE '.langgui'
  if (Test-Path $dbDir) {
    Write-Host "Purging data directory $dbDir (because -PurgeData was passed)..."
    Remove-Item -Path $dbDir -Recurse -Force
  }
} else {
  Write-Host ("Your data at " + (Join-Path $env:USERPROFILE '.langgui') + " was left untouched.")
  Write-Host "Pass -PurgeData to also delete it."
}
