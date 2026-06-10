# install-startup.ps1 — register Jarela as a scheduled task that runs hidden
# with automatic restart on failure.
#
# Default (no admin required): starts at the current user's logon.
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#
# -Boot (requires admin): starts at machine boot, before anyone logs in.
# Uses S4U so no password is stored, and still runs as the current user so
# the SQLite DB under %USERPROFILE%\.jarela stays owned by the right account.
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1 -Boot
#
# Note on -Boot: if you've set an encryption PIN (lib/crypto/pin-wrap.ts) the
# server will boot but stay locked until you visit the UI and enter it. With
# no PIN, the master key is protected only by NTFS ACLs on ~/.jarela.
#
# To remove: scripts\uninstall-startup.ps1
# To inspect: Get-ScheduledTask -TaskName Jarela | Format-List *

[CmdletBinding()]
param(
  [switch]$Boot
)

$ErrorActionPreference = 'Stop'

$TaskName  = 'Jarela'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Launcher  = Join-Path $RepoRoot 'scripts\start-jarela.ps1'

if (-not (Test-Path $Launcher)) {
  throw "Launcher not found at $Launcher"
}

if ($Boot) {
  $isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) {
    throw "-Boot requires an elevated PowerShell. Right-click PowerShell -> Run as administrator and re-run."
  }
}

# The action: run powershell.exe hidden, executing our launcher script.
# -WindowStyle Hidden so no console window flashes at logon.
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`"" `
  -WorkingDirectory $RepoRoot

if ($Boot) {
  # Trigger: at machine boot. No interactive session needed.
  $trigger = New-ScheduledTaskTrigger -AtStartup
  # S4U: run as the current user without storing a password. No network drives,
  # no desktop — fine for a localhost HTTP server. RunLevel stays Limited so
  # the SQLite DB at %USERPROFILE%\.jarela keeps the right ownership.
  $principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U `
    -RunLevel Limited
} else {
  # Trigger: at user logon.
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  # Principal: run as the current user, no elevation. Critical so the SQLite DB
  # under %USERPROFILE%\.jarela stays owned by the right user.
  $principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited
}

# Settings: hidden, restart on failure, no idle/battery constraints, allow start
# even when on battery (laptops), no time limit. Retries are intentionally
# bounded (3 attempts @ 5min) because with an encrypted master key each
# restart requires a manual PIN re-entry, so silent churn is undesirable.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -Hidden `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -RestartCount 3 `
  -MultipleInstances IgnoreNew

$desc = if ($Boot) {
  'Jarela — local LangGraph chat UI. Auto-starts at boot on http://localhost:4312'
} else {
  'Jarela — local LangGraph chat UI. Auto-starts at logon on http://localhost:4312'
}

$task = New-ScheduledTask `
  -Action $action `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Description $desc

# Replace any existing registration with the same name.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing '$TaskName' task..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
Write-Host "Registered scheduled task '$TaskName'."

Write-Host ""
Write-Host "Starting Jarela now (first run will install deps + build, give it a minute)..."
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
$when = if ($Boot) { 'every time this machine boots (no logon required)' } else { 'every time you log on' }
Write-Host "Done. Jarela will start automatically $when."
Write-Host "  URL:   http://localhost:4312"
Write-Host "  Logs:  $env:LOCALAPPDATA\Jarela\logs\app.log"
Write-Host "  Stop:  Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  Off:   scripts\uninstall-startup.ps1"
