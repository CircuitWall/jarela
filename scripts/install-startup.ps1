# install-startup.ps1 — register LangGUI as a per-user scheduled task that runs
# at logon, hidden, with automatic restart on failure.
#
# Usage (no admin required):
#   powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
#
# To remove: scripts\uninstall-startup.ps1
# To inspect: Get-ScheduledTask -TaskName LangGUI | Format-List *

$ErrorActionPreference = 'Stop'

$TaskName  = 'LangGUI'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Launcher  = Join-Path $RepoRoot 'scripts\start-langgui.ps1'

if (-not (Test-Path $Launcher)) {
  throw "Launcher not found at $Launcher"
}

# The action: run powershell.exe hidden, executing our launcher script.
# -WindowStyle Hidden so no console window flashes at logon.
$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`"" `
  -WorkingDirectory $RepoRoot

# Trigger: at user logon.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Principal: run as the current user, no elevation. Critical so the SQLite DB
# under %USERPROFILE%\.langgui stays owned by the right user.
$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

# Settings: hidden, restart on failure, no idle/battery constraints, allow start
# even when on battery (laptops), no time limit.
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
  -Description 'LangGUI — local LangGraph chat UI. Auto-starts at logon on http://localhost:4312'

# Replace any existing registration with the same name.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing '$TaskName' task..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -InputObject $task | Out-Null
Write-Host "Registered scheduled task '$TaskName'."

Write-Host ""
Write-Host "Starting LangGUI now (first run will install deps + build, give it a minute)..."
Start-ScheduledTask -TaskName $TaskName

Write-Host ""
Write-Host "Done. LangGUI will start automatically every time you log on."
Write-Host "  URL:   http://localhost:4312"
Write-Host "  Logs:  $env:LOCALAPPDATA\LangGUI\logs\app.log"
Write-Host "  Stop:  Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  Off:   scripts\uninstall-startup.ps1"
