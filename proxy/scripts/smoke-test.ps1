#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Smoke-test the deployed Jarela OAuth proxy.

.DESCRIPTION
  POSTs a bogus refresh_token to the proxy and verifies Google responds with
  `invalid_grant` (not `invalid_client`). A pass means:
    - Function is reachable (no 401 from Cloud Run IAM)
    - client_id and client_secret env vars are correct
    - Body forwarding works

  Exits 0 on pass, 1 on fail. Safe to call from CI.

.EXAMPLE
  .\smoke-test.ps1
#>

[CmdletBinding()]
param()

. "$PSScriptRoot\_config.ps1"

$url = Get-ProxyUrl
Assert-LastExitCode "describe function"
Write-Host "Smoke-testing $url" -ForegroundColor Cyan

$tmpOut = [System.IO.Path]::GetTempFileName()
try {
    $status = (& curl.exe -s -o $tmpOut -w "%{http_code}" `
        -X POST `
        -H "Content-Type: application/x-www-form-urlencoded" `
        --data "grant_type=refresh_token&refresh_token=jarela-smoke-test-bogus" `
        $url)
    $body = Get-Content $tmpOut -Raw
} finally {
    Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
}

Write-Host "  HTTP $status"
Write-Host "  Body: $body"

if ($status -eq "400" -and $body -match '"invalid_grant"') {
    Write-Host "PASS: proxy is correctly forwarding to Google with valid credentials." -ForegroundColor Green
    exit 0
}
if ($body -match '"invalid_client"') {
    Write-Host "FAIL: Google rejected the client credentials. The stored client_secret is wrong." -ForegroundColor Red
    Write-Host "      Re-run rotate-secret.ps1 with the correct value." -ForegroundColor Red
    exit 1
}
if ($status -eq "401" -or $status -eq "403") {
    Write-Host "FAIL: Cloud Run IAM rejected the request. Re-grant public invoker:" -ForegroundColor Red
    Write-Host "      gcloud run services add-iam-policy-binding $FN_NAME --region=$REGION --member=allUsers --role=roles/run.invoker" -ForegroundColor Yellow
    exit 1
}

Write-Host "FAIL: unexpected response." -ForegroundColor Red
exit 1
