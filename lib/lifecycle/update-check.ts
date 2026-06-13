// Update check: compares the running version against the latest published
// to npm (channel "stable") or the tip of the GitHub `main` branch
// (channel "main", experimental). Result is cached on disk so we don't
// hammer the registry / GitHub on every request.
//
// Tune with:
//   JARELA_DISABLE_UPDATE_CHECK=1   skip entirely
//   JARELA_UPDATE_CHANNEL=main      track the GitHub main branch instead

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";
import { getConfig } from "@/lib/env/config";

const PACKAGE_NAME = "@circuitwall/jarela";
const REPO = "CircuitWall/jarela";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const GH_COMMIT_URL = `https://api.github.com/repos/${REPO}/commits/main`;
const GH_RAW_PKG_URL = `https://raw.githubusercontent.com/${REPO}/main/package.json`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// JARELA_UPDATE_CHECK_TIMEOUT_MS overrides this.
function fetchTimeoutMs(): number { return getConfig().updateCheckTimeoutMs; }

export type UpdateChannel = "stable" | "main";

export type UpdateInfo = {
  /** Which release track we're checking against. */
  channel: UpdateChannel;
  /** Version currently running. */
  current: string;
  /** Latest version on the selected channel, or null if the check failed. */
  latest: string | null;
  /** True iff the channel reports newer code than what's running. */
  behind: boolean;
  /** True iff the result came from cache rather than a fresh fetch. */
  cached: boolean;
  /** Epoch ms of the latest successful fetch, or null. */
  checkedAt: number | null;
  /** Tip commit on `main` (only populated for channel "main"). */
  latestCommit?: { sha: string; date: string | null };
  /** Local HEAD sha (only populated for channel "main" + source checkout). */
  currentCommit?: string;
  /** If something went wrong: why. */
  error?: string;
};

type CacheFile = {
  channel: UpdateChannel;
  latest: string;
  checkedAt: number;
  commit?: { sha: string; date: string | null };
};

let memo: { key: string; value: UpdateInfo; expiresAt: number } | null = null;

function cachePath(channel: UpdateChannel): string {
  const suffix = channel === "stable" ? "" : `.${channel}`;
  return join(getDataDir(), `update-check${suffix}.json`);
}

export function resolveChannel(env: NodeJS.ProcessEnv = process.env): UpdateChannel {
  const raw = (env.JARELA_UPDATE_CHANNEL ?? "").trim().toLowerCase();
  return raw === "main" ? "main" : "stable";
}

/** Strict-ish semver compare. Returns negative if a < b, 0 if equal, positive
 *  if a > b. Ignores pre-release tags beyond plain equality. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map((n) => Number(n) || 0);
  const pb = b.split("-")[0].split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Best-effort: read the local git HEAD sha for a source checkout. Returns
 *  null if the path isn't a checkout, git isn't installed, or it fails. */
export function readLocalCommit(packageRoot: string): string | null {
  if (!existsSync(join(packageRoot, ".git"))) return null;
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) return null;
  const sha = (r.stdout || "").trim();
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
}

async function readCache(channel: UpdateChannel): Promise<CacheFile | null> {
  try {
    const raw = await readFile(cachePath(channel), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (typeof parsed?.latest !== "string" || typeof parsed?.checkedAt !== "number") return null;
    if (parsed.channel && parsed.channel !== channel) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(entry: CacheFile): Promise<void> {
  const path = cachePath(entry.channel);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry), "utf8");
  } catch {
    // Cache is a nice-to-have; failing to persist shouldn't break the call.
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs());
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "jarela-update-check" },
    });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestStable(): Promise<{ version: string }> {
  const body = await fetchJson<{ version?: string }>(REGISTRY_URL);
  if (!body?.version) throw new Error("registry response missing version");
  return { version: body.version };
}

async function fetchLatestMain(): Promise<{ version: string; commit: { sha: string; date: string | null } }> {
  const [pkg, commit] = await Promise.all([
    fetchJson<{ version?: string }>(GH_RAW_PKG_URL),
    fetchJson<{ sha?: string; commit?: { author?: { date?: string } } }>(GH_COMMIT_URL),
  ]);
  if (!pkg?.version) throw new Error("github package.json missing version");
  if (!commit?.sha) throw new Error("github commit response missing sha");
  return {
    version: pkg.version,
    commit: { sha: commit.sha, date: commit.commit?.author?.date ?? null },
  };
}

type CheckOptions = {
  current: string;
  packageRoot?: string;
  channel?: UpdateChannel;
  force?: boolean;
};

/** Check for an update. Honours JARELA_DISABLE_UPDATE_CHECK and uses a 24h
 *  on-disk cache plus an in-memory memo. Accepts either a bare current
 *  version string (legacy) or an options object. */
export async function checkForUpdate(
  currentOrOpts: string | CheckOptions,
  legacyOpts?: { force?: boolean },
): Promise<UpdateInfo> {
  const opts: CheckOptions =
    typeof currentOrOpts === "string"
      ? { current: currentOrOpts, force: legacyOpts?.force }
      : currentOrOpts;
  const current = opts.current;
  const channel = opts.channel ?? resolveChannel();
  const force = opts.force === true;

  if (process.env.JARELA_DISABLE_UPDATE_CHECK === "1") {
    return { channel, current, latest: null, behind: false, cached: false, checkedAt: null, error: "disabled" };
  }

  const now = Date.now();
  const memoKey = `${channel}:${current}`;
  if (!force && memo && memo.key === memoKey && memo.expiresAt > now) return memo.value;

  const currentCommit = channel === "main" && opts.packageRoot ? readLocalCommit(opts.packageRoot) : null;

  if (!force) {
    const cached = await readCache(channel);
    if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
      const info = buildInfo({ channel, current, currentCommit, cached: true, fromCache: cached, checkedAt: cached.checkedAt });
      memo = { key: memoKey, value: info, expiresAt: now + 60_000 };
      return info;
    }
  }

  try {
    let cacheEntry: CacheFile;
    if (channel === "main") {
      const { version, commit } = await fetchLatestMain();
      cacheEntry = { channel, latest: version, checkedAt: now, commit };
    } else {
      const { version } = await fetchLatestStable();
      cacheEntry = { channel, latest: version, checkedAt: now };
    }
    await writeCache(cacheEntry);
    const info = buildInfo({
      channel,
      current,
      currentCommit,
      cached: false,
      fromCache: cacheEntry,
      checkedAt: now,
    });
    memo = { key: memoKey, value: info, expiresAt: now + 60_000 };
    return info;
  } catch (err) {
    return {
      channel,
      current,
      latest: null,
      behind: false,
      cached: false,
      checkedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildInfo(args: {
  channel: UpdateChannel;
  current: string;
  currentCommit: string | null;
  cached: boolean;
  fromCache: CacheFile;
  checkedAt: number;
}): UpdateInfo {
  const { channel, current, currentCommit, cached, fromCache, checkedAt } = args;
  const latest = fromCache.latest;
  let behind = false;
  if (channel === "main") {
    // Prefer sha comparison when we have a local checkout; otherwise fall
    // back to comparing the published-to-main package.json version.
    if (currentCommit && fromCache.commit?.sha) {
      const a = currentCommit.toLowerCase();
      const b = fromCache.commit.sha.toLowerCase();
      behind = !(a.startsWith(b) || b.startsWith(a));
    } else {
      behind = compareSemver(latest, current) > 0;
    }
  } else {
    behind = compareSemver(latest, current) > 0;
  }
  return {
    channel,
    current,
    latest,
    behind,
    cached,
    checkedAt,
    ...(fromCache.commit ? { latestCommit: fromCache.commit } : {}),
    ...(currentCommit ? { currentCommit } : {}),
  };
}
