// CLI-side update helpers.
//
// - notifyIfBehind(): prints a banner to stderr if the running version is
//   behind the latest published. Best-effort, non-blocking-ish (2s timeout).
// - runUpdate(): re-invokes `npm i -g <pkg>@latest`. Detects "running from a
//   cloned source tree" and bails with instructions instead of nuking the
//   user's git working copy.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PACKAGE_NAME = "@circuitwall/jarela";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const FETCH_TIMEOUT_MS = 2000;

function readCurrentVersion(root) {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf8");
    return JSON.parse(raw).version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

function compareSemver(a, b) {
  const pa = String(a).split("-")[0].split(".").map((n) => Number(n) || 0);
  const pb = String(b).split("-")[0].split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchLatest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const body = await res.json();
    if (!body?.version) throw new Error("missing version");
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

/** True iff the package root looks like a developer's source checkout
 *  (presence of .git or an src-ish layout) rather than an installed copy. */
function isFromSource(root) {
  return existsSync(join(root, ".git"));
}

export async function notifyIfBehind({ root }) {
  const current = readCurrentVersion(root);
  let latest;
  try { latest = await fetchLatest(); } catch { return; }
  if (compareSemver(latest, current) <= 0) return;
  const hint = isFromSource(root)
    ? "git pull && npm i && npm run build"
    : `jarela update   (or: npm i -g ${PACKAGE_NAME}@latest)`;
  console.error("");
  console.error(`[jarela] update available: ${current} -> ${latest}`);
  console.error(`[jarela] upgrade: ${hint}`);
  console.error(`[jarela] silence: set JARELA_DISABLE_UPDATE_CHECK=1`);
  console.error("");
}

export async function runUpdate({ root }) {
  const current = readCurrentVersion(root);

  if (isFromSource(root)) {
    console.error(`[jarela] this looks like a source checkout (current ${current}).`);
    console.error(`[jarela] update manually:`);
    console.error(`[jarela]   git pull && npm i && npm run build`);
    return 1;
  }

  let latest = null;
  try { latest = await fetchLatest(); } catch { /* fall through */ }
  if (latest && compareSemver(latest, current) <= 0) {
    console.log(`[jarela] already up to date (${current}).`);
    return 0;
  }
  if (latest) {
    console.log(`[jarela] upgrading ${current} -> ${latest}`);
  } else {
    console.log(`[jarela] could not reach the registry; running install anyway`);
  }

  const args = ["i", "-g", `${PACKAGE_NAME}@latest`];
  const r = spawnSync("npm", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`[jarela] npm exited ${r.status}. If you see EACCES, retry with elevated permissions:`);
    if (process.platform === "win32") {
      console.error(`[jarela]   (run an admin PowerShell)  npm i -g ${PACKAGE_NAME}@latest`);
    } else {
      console.error(`[jarela]   sudo npm i -g ${PACKAGE_NAME}@latest`);
    }
    return r.status ?? 1;
  }
  console.log(`[jarela] update complete. Restart the server to pick up the new version.`);
  return 0;
}
