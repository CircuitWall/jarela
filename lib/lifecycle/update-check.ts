// Update check: compares the running version against the latest published
// to npm and caches the result to disk so we don't hit the registry on every
// request.
//
// Disable with JARELA_DISABLE_UPDATE_CHECK=1.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";

const PACKAGE_NAME = "@circuitwall/jarela";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 3000;

export type UpdateInfo = {
  /** Version currently running. */
  current: string;
  /** Latest version on npm, or null if the check failed/was skipped. */
  latest: string | null;
  /** True iff latest > current per semver. */
  behind: boolean;
  /** True iff the last check came from cache rather than a fresh fetch. */
  cached: boolean;
  /** Epoch ms of the latest successful registry fetch, or null. */
  checkedAt: number | null;
  /** If something went wrong: why. */
  error?: string;
};

type CacheFile = { latest: string; checkedAt: number };

let memo: { value: UpdateInfo; expiresAt: number } | null = null;

function cachePath(): string {
  return join(getDataDir(), "update-check.json");
}

/** Read current version from the shipped package.json. Sync because it's
 *  called once at module load on the CLI path. */
export function readCurrentVersion(packageRoot: string): string {
  try {
    const raw = readFileSync(join(packageRoot, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (typeof parsed?.latest !== "string" || typeof parsed?.checkedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(entry: CacheFile): Promise<void> {
  const path = cachePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(entry), "utf8");
  } catch {
    // Cache is a nice-to-have; failing to persist shouldn't break the call.
  }
}

async function fetchLatest(): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`registry returned ${res.status}`);
    const body = (await res.json()) as { version?: string };
    if (!body?.version) throw new Error("registry response missing version");
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

/** Check for an update. Honours JARELA_DISABLE_UPDATE_CHECK and uses a 24h
 *  on-disk cache plus an in-memory memo. */
export async function checkForUpdate(current: string, opts?: { force?: boolean }): Promise<UpdateInfo> {
  if (process.env.JARELA_DISABLE_UPDATE_CHECK === "1") {
    return { current, latest: null, behind: false, cached: false, checkedAt: null, error: "disabled" };
  }

  const force = opts?.force === true;
  const now = Date.now();

  if (!force && memo && memo.expiresAt > now) return memo.value;

  if (!force) {
    const cached = await readCache();
    if (cached && now - cached.checkedAt < CACHE_TTL_MS) {
      const info: UpdateInfo = {
        current,
        latest: cached.latest,
        behind: compareSemver(cached.latest, current) > 0,
        cached: true,
        checkedAt: cached.checkedAt,
      };
      memo = { value: info, expiresAt: now + 60_000 };
      return info;
    }
  }

  try {
    const latest = await fetchLatest();
    await writeCache({ latest, checkedAt: now });
    const info: UpdateInfo = {
      current,
      latest,
      behind: compareSemver(latest, current) > 0,
      cached: false,
      checkedAt: now,
    };
    memo = { value: info, expiresAt: now + 60_000 };
    return info;
  } catch (err) {
    return {
      current,
      latest: null,
      behind: false,
      cached: false,
      checkedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
