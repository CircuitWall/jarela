# install-tailscale-serve.ps1 — expose the installed Jarela on the tailnet.
#
# Sets up `tailscale serve` to terminate HTTPS at the node's tailnet name and
# forward to http://localhost:<port> (default 4312). This is the recommended
# remote-access path documented in ADR-0008: one port, plain HTTP behind the
# proxy, EventSource-based streaming that works on iOS Safari.
#
# Usage (no admin required, but tailscale itself must be installed and
# `tailscale up` already run at least once):
#   powershell -ExecutionPolicy Bypass -File scripts\install-tailscale-serve.ps1
#
# Custom port:
#   powershell -ExecutionPolicy Bypass -File scripts\install-tailscale-serve.ps1 -Port 4312
#
# Verify with:
#   tailscale serve status

[CmdletBinding()]
param(
  [int]$Port = 4312
)

$ErrorActionPreference = 'Stop'

function Step([string]$msg) { Write-Host ("==> " + $msg) -ForegroundColor Cyan }
function Info([string]$msg) { Write-Host ("    " + $msg) -ForegroundColor DarkGray }
function Warn([string]$msg) { Write-Host ("    " + $msg) -ForegroundColor Yellow }

# ── 1. Locate tailscale.exe ────────────────────────────────────────────────
function Find-Tailscale {
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tailscale\tailscale.exe')
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}
$tailscale = Find-Tailscale
if (-not $tailscale) {
  Write-Host "tailscale.exe not found on PATH or under Program Files." -ForegroundColor Red
  Write-Host "Install Tailscale from https://tailscale.com/download/windows and run" -ForegroundColor Red
  Write-Host "  tailscale up" -ForegroundColor Red
  Write-Host "before retrying." -ForegroundColor Red
  exit 1
}
Info ("tailscale: " + $tailscale)

# ── 2. Sanity-check the daemon is logged in ────────────────────────────────
Step "Checking tailscale status"
$statusJson = & $tailscale status --json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $statusJson) {
  Write-Host "tailscale daemon is not reachable. Start the Tailscale service and run 'tailscale up'." -ForegroundColor Red
  exit 1
}
try {
  $status = $statusJson | ConvertFrom-Json
} catch {
  Write-Host "Could not parse tailscale status output." -ForegroundColor Red
  exit 1
}
if (-not $status.Self -or -not $status.Self.DNSName) {
  Write-Host "tailscale node has no DNS name yet. Run 'tailscale up' to log in." -ForegroundColor Red
  exit 1
}
$fqdn = $status.Self.DNSName.TrimEnd('.')
Info ("host:  " + $fqdn)
Info ("port:  " + $Port)

# ── 3. Apply the serve config ──────────────────────────────────────────────
# `tailscale serve --bg http://localhost:<port>` terminates HTTPS at the
# tailnet edge (using the magic cert tailscaled provisions for $fqdn) and
# forwards to plain HTTP on loopback. Jarela's Next.js server speaks plain
# HTTP on $Port, so the backend scheme is `http://`, not `https+insecure://`
# (the latter is for self-signed HTTPS backends and yields 502 against an
# HTTP server). This is the shape ADR-0008 standardises: single port, no
# separate WS path, no cert warnings on iOS.
#
# Reset first so we leave a clean single-mapping config — earlier LangGUI /
# Jarela versions registered an extra `/__langgui_ws__` (and later
# `/__jarela_ws__`) entry for a WebSocket sidecar that no longer exists.
Step "Clearing any previous tailscale serve config"
& $tailscale serve reset 2>&1 | ForEach-Object { Info $_ }

Step "Applying tailscale serve config"
& $tailscale serve --bg ("http://localhost:" + $Port) 2>&1 | ForEach-Object { Info $_ }
if ($LASTEXITCODE -ne 0) {
  Write-Host "tailscale serve failed (exit $LASTEXITCODE)." -ForegroundColor Red
  exit $LASTEXITCODE
}

# ── 4. Confirm ─────────────────────────────────────────────────────────────
Step "Current serve config"
& $tailscale serve status 2>&1 | ForEach-Object { Info $_ }

Write-Host ""
Write-Host "Jarela is now reachable on the tailnet at:" -ForegroundColor Green
Write-Host ("  https://" + $fqdn + "/")
Write-Host ""
Write-Host "Open that URL on any device logged into your tailnet to install the PWA." -ForegroundColor DarkGray
Write-Host "Remote users must be added to the access whitelist in Settings → You." -ForegroundColor DarkGray
Write-Host "To remove: scripts\uninstall-tailscale-serve.ps1" -ForegroundColor DarkGray
