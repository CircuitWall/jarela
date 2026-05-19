# uninstall-tailscale-serve.ps1 — clear any `tailscale serve` config that
# was set up for Jarela. Equivalent to `tailscale serve reset`.
#
# Does NOT touch:
#   - the tailscale daemon itself (`tailscale up` state stays as-is)
#   - the Jarela installation or scheduled task (use uninstall-from-system.ps1)
#   - the access whitelist in ~/.jarela
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-tailscale-serve.ps1

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

$tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue)?.Source
if (-not $tailscale) {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe')
  ) | Where-Object { $_ -and (Test-Path $_) }
  if ($candidates.Count -gt 0) { $tailscale = $candidates[0] }
}
if (-not $tailscale) {
  Write-Host "tailscale.exe not found — nothing to do."
  exit 0
}

Write-Host "==> Resetting tailscale serve config" -ForegroundColor Cyan
& $tailscale serve reset 2>&1 | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
if ($LASTEXITCODE -eq 0) {
  Write-Host "tailscale serve config cleared." -ForegroundColor Green
} else {
  Write-Host "tailscale serve reset returned exit code $LASTEXITCODE — config may have already been empty." -ForegroundColor Yellow
}
