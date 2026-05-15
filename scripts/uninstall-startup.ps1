# uninstall-startup.ps1 — remove the LangGUI scheduled task and stop the running
# instance. Does NOT touch the SQLite database under %USERPROFILE%\.langgui or
# the Tailscale serve config.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\uninstall-startup.ps1

$ErrorActionPreference = 'Stop'
$TaskName = 'LangGUI'
$Port     = 4312

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
} else {
  Write-Host "No scheduled task named '$TaskName' was registered."
}

# Kill anything still listening on the LangGUI port.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $busy) {
  try {
    Write-Host "Stopping PID $($c.OwningProcess) holding port $Port"
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  } catch {}
}

Write-Host "Done. Your data under $env:USERPROFILE\.langgui was left untouched."
