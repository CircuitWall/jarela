#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Rotate the Gmail OAuth client_secret in Secret Manager and roll the proxy.

.DESCRIPTION
  Adds a new version of the client_secret to Secret Manager, forces the Cloud
  Run function to pick up `:latest`, then smoke-tests. On success, offers to
  disable the previous version.

  Source modes (mutually exclusive):
    -JsonFile <path>  Reads the client_secret value from a downloaded Google
                      OAuth client JSON file. Auto-detects `.installed` (Desktop)
                      and `.web` (Web app) keys.
    -RawFile <path>   Reads a file whose entire content is the GOCSPX-... value.

  Either way the value is written to a temp file with EXACT bytes (no BOM, no
  trailing newline) before upload, avoiding the trailing-\n bug that makes
  Google reject the credentials with `invalid_client`.

.PARAMETER JsonFile
  Path to the downloaded `client_secret_*.json` from Google Cloud Console.
  Default: searches $env:USERPROFILE\Downloads\client_secret_*.json

.PARAMETER RawFile
  Path to a plain text file containing only the GOCSPX-... value.

.PARAMETER SkipSmokeTest
  Skip the post-rotation smoke test. Useful in non-interactive contexts.

.EXAMPLE
  # Auto-detect downloaded JSON
  .\rotate-secret.ps1

.EXAMPLE
  # Explicit JSON path
  .\rotate-secret.ps1 -JsonFile "C:\Users\me\Downloads\client_secret_134669812881-xxxx.json"

.EXAMPLE
  # Raw secret file
  "GOCSPX-abc..." | Out-File secret.txt -NoNewline -Encoding ascii
  .\rotate-secret.ps1 -RawFile .\secret.txt
#>

[CmdletBinding(DefaultParameterSetName = "Json")]
param(
    [Parameter(ParameterSetName = "Json")]
    [string]$JsonFile,

    [Parameter(ParameterSetName = "Raw", Mandatory)]
    [string]$RawFile,

    [switch]$SkipSmokeTest
)

. "$PSScriptRoot\_config.ps1"

# --- 1. Extract secret value ------------------------------------------------

$secret = $null
if ($PSCmdlet.ParameterSetName -eq "Raw") {
    if (-not (Test-Path $RawFile)) { throw "RawFile not found: $RawFile" }
    $secret = [System.IO.File]::ReadAllText($RawFile).Trim()
} else {
    if (-not $JsonFile) {
        $candidate = Get-ChildItem "$env:USERPROFILE\Downloads\client_secret_*.json" -ErrorAction SilentlyContinue |
                     Sort-Object LastWriteTime -Descending |
                     Select-Object -First 1
        if (-not $candidate) {
            throw "No -JsonFile passed and no client_secret_*.json found in Downloads.`nDownload one from https://console.cloud.google.com/apis/credentials and re-run."
        }
        $JsonFile = $candidate.FullName
    }
    if (-not (Test-Path $JsonFile)) { throw "JsonFile not found: $JsonFile" }
    Write-Host "Reading client_secret from: $JsonFile" -ForegroundColor Gray
    $json = Get-Content $JsonFile -Raw | ConvertFrom-Json
    $secret = if ($json.installed) { $json.installed.client_secret }
              elseif ($json.web)   { $json.web.client_secret }
              else { $null }
    if (-not $secret) { throw "Could not find .installed.client_secret or .web.client_secret in JSON" }
}

# --- 2. Validate ------------------------------------------------------------

if (-not $secret.StartsWith("GOCSPX-")) {
    throw "Extracted value does not start with 'GOCSPX-'. Got '$($secret.Substring(0, [Math]::Min(8, $secret.Length)))...'. Refusing to upload."
}
if ($secret.Length -ne 35) {
    throw "Extracted value is $($secret.Length) chars; expected 35. Refusing to upload."
}
Write-Host "Validated client_secret: 35 chars, GOCSPX- prefix" -ForegroundColor Green

# --- 3. Capture previous version (for rollback hint) ------------------------

$prevVersion = gcloud secrets versions list $SECRET_NAME `
    --filter="state=ENABLED" `
    --format="value(name)" `
    --sort-by=~name `
    --limit=1
Assert-LastExitCode "list current secret versions"
Write-Host "Current latest enabled version: $prevVersion" -ForegroundColor Gray

# --- 4. Upload as new version via temp file with exact bytes ----------------

$tmp = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllBytes($tmp, [System.Text.Encoding]::ASCII.GetBytes($secret))
    Write-Host "Adding new Secret Manager version..." -ForegroundColor Cyan
    $newVersionLine = gcloud secrets versions add $SECRET_NAME --data-file=$tmp 2>&1
    Assert-LastExitCode "add secret version"
    Write-Host "  $newVersionLine" -ForegroundColor Gray
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
}

$newVersion = gcloud secrets versions list $SECRET_NAME `
    --filter="state=ENABLED" `
    --format="value(name)" `
    --sort-by=~name `
    --limit=1
Assert-LastExitCode "list new secret versions"
Write-Host "New latest version: $newVersion" -ForegroundColor Green

# --- 5. Force Cloud Run revision restart so :latest is picked up ------------

Write-Host "Rolling Cloud Run service to pick up :latest..." -ForegroundColor Cyan
$stamp = (Get-Date -Format yyyyMMddHHmmss)
gcloud run services update $FN_NAME `
    --region=$REGION `
    --update-env-vars="FORCE_REDEPLOY=$stamp" `
    --quiet | Out-Null
Assert-LastExitCode "force new revision"
Write-Host "  New revision deployed" -ForegroundColor Green

# --- 6. Smoke test ----------------------------------------------------------

if ($SkipSmokeTest) {
    Write-Host "Skipping smoke test (-SkipSmokeTest)." -ForegroundColor DarkGray
} else {
    Write-Host ""
    & "$PSScriptRoot\smoke-test.ps1"
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ROLLBACK: pin the function to the previous secret version:" -ForegroundColor Red
        Write-Host "  gcloud run services update $FN_NAME --region=$REGION --update-secrets=JARELA_GMAIL_CLIENT_SECRET=${SECRET_NAME}:$prevVersion" -ForegroundColor Yellow
        throw "Smoke test FAILED after rotation. NEW version is :$newVersion (still active). Rollback above."
    }
}

# --- 7. Offer to disable previous version -----------------------------------

if ($prevVersion -and $prevVersion -ne $newVersion) {
    Write-Host ""
    $ans = Read-Host "Disable previous version (v$prevVersion)? It will become inaccessible (but not destroyed) [y/N]"
    if ($ans -match '^[Yy]') {
        gcloud secrets versions disable $prevVersion --secret=$SECRET_NAME --quiet
        Assert-LastExitCode "disable previous version"
        Write-Host "Disabled v$prevVersion. To re-enable: gcloud secrets versions enable $prevVersion --secret=$SECRET_NAME" -ForegroundColor Gray
    } else {
        Write-Host "Kept v$prevVersion enabled. You can disable later via:" -ForegroundColor Gray
        Write-Host "  gcloud secrets versions disable $prevVersion --secret=$SECRET_NAME" -ForegroundColor Gray
    }
}

Write-Host ""
Write-Host "Rotation complete. New version: $newVersion" -ForegroundColor Green
