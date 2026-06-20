#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Redeploy the Jarela OAuth proxy function from ./proxy source.

.DESCRIPTION
  Use this after editing proxy/index.js or proxy/package.json. Re-zips source,
  uploads, buildpack builds a new container, and shifts traffic to the new
  revision. Idempotent.

  Secret + IAM bindings + runtime SA are preserved across deploys (they are
  provisioned once by setup-time gcloud commands, not by deploy).

.PARAMETER SkipSmokeTest
  Skip the post-deploy smoke test. Useful in CI where smoke test runs
  separately.

.EXAMPLE
  .\deploy.ps1

.EXAMPLE
  # CI / non-interactive
  .\deploy.ps1 -SkipSmokeTest
#>

[CmdletBinding()]
param(
    [switch]$SkipSmokeTest
)

. "$PSScriptRoot\_config.ps1"

# Resolve source dir relative to script (works regardless of cwd).
$sourceDir = Resolve-Path "$PSScriptRoot\.." | Select-Object -ExpandProperty Path

Write-Host "==> Deploying $FN_NAME from $sourceDir to $REGION..." -ForegroundColor Cyan

gcloud functions deploy $FN_NAME `
    --gen2 `
    --region=$REGION `
    --runtime=nodejs22 `
    --source=$sourceDir `
    --entry-point=tokenProxy `
    --trigger-http `
    --allow-unauthenticated `
    --service-account=$SA_EMAIL `
    --set-env-vars="JARELA_GMAIL_CLIENT_ID=$CLIENT_ID" `
    --set-secrets="JARELA_GMAIL_CLIENT_SECRET=${SECRET_NAME}:latest" `
    --memory=256Mi `
    --timeout=30s `
    --max-instances=10 `
    --min-instances=0 `
    --quiet
Assert-LastExitCode "deploy function"

# `--allow-unauthenticated` does not always propagate to the underlying Cloud
# Run service's IAM policy on Gen 2. Re-assert it explicitly (idempotent).
Write-Host "==> Ensuring public invoker binding..." -ForegroundColor Cyan
gcloud run services add-iam-policy-binding $FN_NAME `
    --region=$REGION `
    --member="allUsers" `
    --role="roles/run.invoker" `
    --quiet | Out-Null
Assert-LastExitCode "grant public invoker"

$url = Get-ProxyUrl
Assert-LastExitCode "describe deployed function"
Write-Host "Deployed: $url" -ForegroundColor Green

if (-not $SkipSmokeTest) {
    Write-Host ""
    & "$PSScriptRoot\smoke-test.ps1"
    if ($LASTEXITCODE -ne 0) {
        throw "Smoke test FAILED after deploy."
    }
}
