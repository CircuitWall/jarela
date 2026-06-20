# Shared config for proxy ops scripts. Dot-source from sibling scripts:
#   . "$PSScriptRoot\_config.ps1"

# Fail fast on any error and treat non-zero gcloud exits as errors.
$ErrorActionPreference = "Stop"

$PROJECT_ID  = "circuitwall"
$REGION      = "europe-west1"   # Cloud Functions Gen 2 supported (Stockholm europe-north2 not yet)
$FN_NAME     = "jarela-oauth-proxy"
$SECRET_NAME = "jarela-gmail-client-secret"
$SA_EMAIL    = "jarela-oauth-proxy-sa@$PROJECT_ID.iam.gserviceaccount.com"
$CLIENT_ID   = "134669812881-for5e5bjirjt9s2f53cvc3lcj5q257c7.apps.googleusercontent.com"

function Get-ProxyUrl {
    return (gcloud functions describe $FN_NAME --region=$REGION --format="value(serviceConfig.uri)")
}

function Assert-LastExitCode($context) {
    if ($LASTEXITCODE -ne 0) {
        throw "gcloud command failed during '$context' (exit code $LASTEXITCODE)"
    }
}
