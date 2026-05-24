// CLI-side update helpers.
//
// - notifyIfBehind(): prints a banner to stderr if the running version is
//   behind the latest on the configured channel. Best-effort, non-blocking-ish.
// - runUpdate(): re-invokes `npm i -g <pkg>@latest` (stable channel) or pulls
//   from `main` (experimental channel). Detects "running from a cloned source
//   tree" and either does a `git pull`+rebuild or bails with instructions.
//
// Channels:
//   JARELA_UPDATE_CHANNEL=stable  (default) tracks the npm "latest" tag
//   JARELA_UPDATE_CHANNEL=main             tracks GitHub `main` (experimental)

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const PACKAGE_NAME = "@circuitwall/jarela";
const REPO = "CircuitWall/jarela";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const GH_COMMIT_URL = `https://api.github.com/repos/${REPO}/commits/main`;
const GH_RAW_PKG_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const FETCH_TIMEOUT_MS = 2000;

function resolveChannel() {
  return (process.env.JARELA_UPDATE_CHANNEL ?? "").trim().toLowerCase() === "main" ? "main" : "stable";
}

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

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "jarela-update-check" },
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestStable() {
  const body = await fetchJson(REGISTRY_URL);
  if (!body?.version) throw new Error("missing version");
  return { version: body.version };
}

async function fetchLatestMain() {
  const [pkg, commit] = await Promise.all([
    fetchJson(GH_RAW_PKG_URL),
    fetchJson(GH_COMMIT_URL),
  ]);
  if (!pkg?.version) throw new Error("missing version");
  if (!commit?.sha) throw new Error("missing commit sha");
  return { version: pkg.version, sha: commit.sha };
}

/** True iff the package root looks like a developer's source checkout
 *  (presence of .git) rather than an installed copy. */
function isFromSource(root) {
  return existsSync(join(root, ".git"));
}

function readLocalCommit(root) {
  if (!isFromSource(root)) return null;
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) return null;
  const sha = (r.stdout || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

export async function notifyIfBehind({ root }) {
  const channel = resolveChannel();
  const current = readCurrentVersion(root);

  if (channel === "main") {
    let latest;
    try { latest = await fetchLatestMain(); } catch { return; }
    const localSha = readLocalCommit(root);
    let behind;
    if (localSha) {
      const a = localSha.toLowerCase();
      const b = latest.sha.toLowerCase();
      behind = !(a.startsWith(b) || b.startsWith(a));
    } else {
      behind = compareSemver(latest.version, current) > 0;
    }
    if (!behind) return;
    const shortRemote = latest.sha.slice(0, 7);
    const shortLocal = localSha ? localSha.slice(0, 7) : null;
    const hint = isFromSource(root)
      ? "git pull --ff-only && npm i && npm run build"
      : `jarela update   (or: npm i -g github:${REPO}#main)`;
    console.error("");
    console.error(`[jarela] update available on \`main\` (experimental): ` +
      (shortLocal ? `${shortLocal} -> ${shortRemote}` : `${current} -> ${latest.version} @ ${shortRemote}`));
    console.error(`[jarela] upgrade: ${hint}`);
    console.error(`[jarela] switch back to stable: unset JARELA_UPDATE_CHANNEL`);
    console.error("");
    return;
  }

  let latest;
  try { latest = (await fetchLatestStable()).version; } catch { return; }
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

function spawnInherit(cmd, args) {
  return spawnSync(cmd, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

async function runUpdateMain({ root, current }) {
  if (isFromSource(root)) {
    console.log(`[jarela] channel=main (experimental); pulling latest from origin/main`);
    let r = spawnInherit("git", ["pull", "--ff-only", "origin", "main"]);
    if (r.status !== 0) {
      console.error(`[jarela] git pull failed (status ${r.status}). Resolve manually then re-run.`);
      return r.status ?? 1;
    }
    r = spawnInherit("npm", ["install"]);
    if (r.status !== 0) return r.status ?? 1;
    r = spawnInherit("npm", ["run", "build"]);
    if (r.status !== 0) return r.status ?? 1;
    console.log(`[jarela] update complete. Restart the server to pick up the new build.`);
    return 0;
  }

  console.log(`[jarela] channel=main (experimental); installing from github:${REPO}#main`);
  console.log(`[jarela] current=${current}`);
  const r = spawnInherit("npm", ["i", "-g", `github:${REPO}#main`]);
  if (r.status !== 0) {
    console.error(`[jarela] npm exited ${r.status}. If you see EACCES, retry elevated:`);
    if (process.platform === "win32") {
      console.error(`[jarela]   (admin PowerShell)  npm i -g github:${REPO}#main`);
    } else {
      console.error(`[jarela]   sudo npm i -g github:${REPO}#main`);
    }
    return r.status ?? 1;
  }
  console.log(`[jarela] update complete. Restart the server to pick up the new version.`);
  return 0;
}

export async function runUpdate({ root }) {
  const channel = resolveChannel();
  const current = readCurrentVersion(root);

  if (channel === "main") return runUpdateMain({ root, current });

  if (isFromSource(root)) {
    console.error(`[jarela] this looks like a source checkout (current ${current}).`);
    console.error(`[jarela] update manually:`);
    console.error(`[jarela]   git pull && npm i && npm run build`);
    return 1;
  }

  let latest = null;
  try { latest = (await fetchLatestStable()).version; } catch { /* fall through */ }
  if (latest && compareSemver(latest, current) <= 0) {
    console.log(`[jarela] already up to date (${current}).`);
    return 0;
  }
  if (latest) {
    console.log(`[jarela] upgrading ${current} -> ${latest}`);
  } else {
    console.log(`[jarela] could not reach the registry; running install anyway`);
  }

  const r = spawnInherit("npm", ["i", "-g", `${PACKAGE_NAME}@latest`]);
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
