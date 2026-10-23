import { getDb } from "@/lib/db";

export const WORKSPACE_SCAN_CACHE_TTL_MS = 15 * 60 * 1000;
const RETAIN_FOR_MS = 30 * 24 * 60 * 60 * 1000;

export interface WorkspaceTreeScan {
  entries: Array<{ path: string; kind: "file" | "dir"; size?: number }>;
  truncated: boolean;
}

export interface CachedWorkspaceTreeScan extends WorkspaceTreeScan {
  scanned_at: string;
}

function parsePayload(raw: string): WorkspaceTreeScan | null {
  try {
    const parsed = JSON.parse(raw) as Partial<WorkspaceTreeScan>;
    if (!Array.isArray(parsed.entries) || typeof parsed.truncated !== "boolean") return null;
    if (!parsed.entries.every((entry) => entry && typeof entry.path === "string"
      && (entry.kind === "file" || entry.kind === "dir")
      && (entry.size === undefined || (typeof entry.size === "number" && Number.isFinite(entry.size))))) return null;
    return parsed as WorkspaceTreeScan;
  } catch {
    return null;
  }
}

export function getWorkspaceTreeScan(
  cacheKey: string,
  nowMs = Date.now(),
  ttlMs = WORKSPACE_SCAN_CACHE_TTL_MS,
): CachedWorkspaceTreeScan | null {
  const db = getDb();
  const row = db.prepare("SELECT payload, scanned_at FROM workspace_scan_cache WHERE cache_key=?")
    .get(cacheKey) as { payload: string; scanned_at: string } | undefined;
  if (!row) return null;
  const scannedAtMs = Date.parse(row.scanned_at);
  if (!Number.isFinite(scannedAtMs) || nowMs < scannedAtMs || nowMs - scannedAtMs > ttlMs) {
    db.prepare("DELETE FROM workspace_scan_cache WHERE cache_key=?").run(cacheKey);
    return null;
  }
  const payload = parsePayload(row.payload);
  if (!payload) {
    db.prepare("DELETE FROM workspace_scan_cache WHERE cache_key=?").run(cacheKey);
    return null;
  }
  return { ...payload, scanned_at: row.scanned_at };
}

export function setWorkspaceTreeScan(cacheKey: string, scan: WorkspaceTreeScan, scannedAt = new Date().toISOString()): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspace_scan_cache (cache_key, payload, scanned_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload, scanned_at=excluded.scanned_at`,
  ).run(cacheKey, JSON.stringify(scan), scannedAt);
  db.prepare("DELETE FROM workspace_scan_cache WHERE scanned_at < ?")
    .run(new Date(Date.parse(scannedAt) - WORKSPACE_SCAN_CACHE_TTL_MS).toISOString());
}
