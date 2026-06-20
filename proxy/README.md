# Jarela OAuth Proxy

A 50-LOC Cloud Run Function that injects the Gmail OAuth `client_secret` from
Secret Manager before forwarding token requests to Google. Lets the Jarela
client ship without the secret in its source tarball.

## Architecture

```
Jarela client ──POST /oauth2/token (no client_secret)──▶ This proxy ──POST /token (+ secret from Secret Manager)──▶ accounts.google.com
```

The browser consent step and authenticated Gmail API calls go direct to
Google. The proxy is only on the path for:

- `grant_type=authorization_code` exchange (initial OAuth code → tokens, once
  per account)
- `grant_type=refresh_token` (~hourly per active account)

## Deployed resources

| Resource | Name |
|---|---|
| GCP project | `circuitwall` |
| Region | `europe-west1` |
| Function | `jarela-oauth-proxy` (Cloud Functions Gen 2 = Cloud Run) |
| Runtime SA | `jarela-oauth-proxy-sa@circuitwall.iam.gserviceaccount.com` |
| Secret | `jarela-gmail-client-secret` |
| Endpoint | `https://jarela-oauth-proxy-134669812881.europe-west1.run.app` |

The Jarela app reads the endpoint from `JARELA_GOOGLE_TOKEN_PROXY` (with a
hard-coded fallback in `lib/integrations/gmail-oauth.ts`).

## Day-2 ops (Windows PowerShell)

All scripts live in [`scripts/`](./scripts/). Run them from any cwd; they
locate themselves via `$PSScriptRoot`.

### Rotate the client_secret

When you rotate the OAuth client secret in the GCP Console:

```powershell
# Auto-picks newest client_secret_*.json from Downloads
.\scripts\rotate-secret.ps1

# Or specify explicit path
.\scripts\rotate-secret.ps1 -JsonFile "C:\path\to\client_secret_xxx.json"
```

The script:

1. Validates the secret is `GOCSPX-` prefixed and 35 chars
2. Writes exact bytes to a temp file (avoids the trailing-newline trap)
3. Adds a new Secret Manager version
4. Forces a Cloud Run revision rollover so the new `:latest` is picked up
5. Smoke-tests the new revision against Google
6. Offers to disable the previous version (kept enabled by default for easy
   rollback)

If smoke test fails, the script prints the rollback command.

### Update the proxy code

After editing [`index.js`](./index.js) or [`package.json`](./package.json):

```powershell
.\scripts\deploy.ps1
```

The script:

1. Re-zips source from `./proxy`
2. Triggers buildpack rebuild
3. Re-asserts public-invoker IAM (Gen 2 quirk: `--allow-unauthenticated`
   doesn't always propagate to the underlying Cloud Run service)
4. Smoke-tests

### Smoke test only

```powershell
.\scripts\smoke-test.ps1
```

POSTs a bogus refresh_token and asserts Google responds with `invalid_grant`
(NOT `invalid_client`). Exits 0 on pass, 1 on fail. Safe to call from CI.

### View logs

```powershell
gcloud functions logs read jarela-oauth-proxy --region=europe-west1 --limit=50
```

### Tear down

```powershell
gcloud functions delete jarela-oauth-proxy --region=europe-west1 --quiet
gcloud secrets delete jarela-gmail-client-secret --quiet
gcloud iam service-accounts delete jarela-oauth-proxy-sa@circuitwall.iam.gserviceaccount.com --quiet
```

## Initial setup (one-time, already done)

For reference if you ever need to recreate the proxy from scratch:

```powershell
# 1. Auth + project
gcloud auth login
gcloud auth application-default login
gcloud config set project circuitwall

# 2. APIs
gcloud services enable `
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com `
  artifactregistry.googleapis.com secretmanager.googleapis.com iam.googleapis.com

# 3. Secret container
gcloud secrets create jarela-gmail-client-secret --replication-policy=automatic `
  --labels="app=jarela,purpose=oauth"

# 4. Runtime service account
gcloud iam service-accounts create jarela-oauth-proxy-sa `
  --display-name="Jarela OAuth proxy runtime"
gcloud secrets add-iam-policy-binding jarela-gmail-client-secret `
  --member="serviceAccount:jarela-oauth-proxy-sa@circuitwall.iam.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor"

# 5. Initial secret value
.\scripts\rotate-secret.ps1

# 6. First deploy
.\scripts\deploy.ps1
```
