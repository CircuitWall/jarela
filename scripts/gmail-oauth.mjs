#!/usr/bin/env node
// scripts/gmail-oauth.mjs
//
// One-shot helper to obtain a Gmail OAuth refresh token using a Google
// Cloud "Desktop app" OAuth client.
//
// Why this exists: Google deprecated the copy-paste auth-code (`oob`) flow
// for Desktop apps. The supported path is a loopback redirect to
// `http://127.0.0.1:<port>`. This script:
//   1. Starts an ephemeral HTTP listener on a free localhost port.
//   2. Opens the Google authorize URL in your default browser.
//   3. Catches the redirect, exchanges the code for tokens.
//   4. Prints the refresh_token to stdout. Paste it into
//      LangGUI → Integrations → Gmail.
//
// Usage:
//   node scripts/gmail-oauth.mjs --client-id <ID> --client-secret <SECRET>
//   node scripts/gmail-oauth.mjs --json path/to/client_secret.json
//
// No deps. Pure Node built-ins.
//
// IMPORTANT: in the Google Cloud console, the OAuth client must be type
// "Desktop app". The Desktop-app type auto-allows `http://localhost`
// redirects on any port. You do NOT need to add a redirect URI manually.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client-id") out.clientId = argv[++i];
    else if (a === "--client-secret") out.clientSecret = argv[++i];
    else if (a === "--json") out.jsonPath = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage:
  node scripts/gmail-oauth.mjs --client-id <ID> --client-secret <SECRET>
  node scripts/gmail-oauth.mjs --json path/to/client_secret.json

The JSON form reads the file Google Cloud Console gives you when you
download credentials for a Desktop OAuth client (expects keys
"installed.client_id" and "installed.client_secret").
`);
}

function readJsonCreds(p) {
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const block = raw.installed ?? raw.web ?? raw;
  if (!block.client_id || !block.client_secret) {
    throw new Error(`No client_id/client_secret in ${p}`);
  }
  return { clientId: block.client_id, clientSecret: block.client_secret };
}

function openBrowser(url) {
  // Windows uses `start`; macOS uses `open`; Linux uses `xdg-open`.
  const cmd = process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) console.error("Failed to launch browser:", err.message); });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }

  let clientId, clientSecret;
  if (args.jsonPath) {
    ({ clientId, clientSecret } = readJsonCreds(args.jsonPath));
  } else {
    clientId = args.clientId;
    clientSecret = args.clientSecret;
  }
  if (!clientId || !clientSecret) {
    usage();
    process.exit(2);
  }

  const state = crypto.randomBytes(16).toString("hex");

  // Bind to port 0 → OS assigns a free port. Use 127.0.0.1 so the URL is
  // explicit; Google accepts `http://127.0.0.1:<port>` and `http://localhost:<port>`
  // for Desktop clients without prior URI registration.
  const server = http.createServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");     // forces a refresh_token even on re-auth
  authUrl.searchParams.set("state", state);

  console.log("\nOpening browser for Google consent…");
  console.log("If it doesn't open, paste this URL manually:\n");
  console.log(authUrl.toString());
  console.log();
  openBrowser(authUrl.toString());

  const code = await new Promise((resolve, reject) => {
    server.on("request", (req, res) => {
      const u = new URL(req.url, redirectUri);
      const gotState = u.searchParams.get("state");
      const gotCode = u.searchParams.get("code");
      const gotErr = u.searchParams.get("error");

      const respond = (status, html) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      };

      if (gotErr) {
        respond(400, `<h1>OAuth error</h1><pre>${gotErr}</pre>You can close this tab.`);
        reject(new Error(`OAuth returned error: ${gotErr}`));
        return;
      }
      if (!gotCode) {
        respond(400, "Missing ?code. You can close this tab.");
        return; // probably a favicon fetch — keep waiting
      }
      if (gotState !== state) {
        respond(400, "State mismatch — refusing. Close this tab and retry.");
        reject(new Error("State mismatch on OAuth callback"));
        return;
      }
      respond(200,
        "<h1>Got it.</h1><p>You can close this tab and return to the terminal.</p>");
      resolve(gotCode);
    });
    // 5 min total budget for the whole consent flow.
    setTimeout(() => reject(new Error("Timed out waiting for OAuth callback")), 5 * 60_000).unref();
  });

  server.close();

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const text = await tokenRes.text();
  if (!tokenRes.ok) {
    console.error(`Token exchange failed (${tokenRes.status}):`);
    console.error(text);
    process.exit(1);
  }
  const tok = JSON.parse(text);
  if (!tok.refresh_token) {
    console.error("Token exchange succeeded but no refresh_token returned.");
    console.error("This usually means you previously authorized this client and Google");
    console.error("returned only an access_token. Revoke at");
    console.error("  https://myaccount.google.com/permissions");
    console.error("and rerun this script.");
    process.exit(1);
  }

  console.log("\n=== Refresh token (paste into LangGUI → Integrations → Gmail) ===\n");
  console.log(tok.refresh_token);
  console.log("\nAccess token (short-lived, for sanity check only):");
  console.log("  expires_in:", tok.expires_in, "seconds");
  console.log("  scope:     ", tok.scope);
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
