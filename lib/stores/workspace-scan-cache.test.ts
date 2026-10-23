import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-workspace-scan-cache-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { closeDb, getDb } = await import("@/lib/db");
const { getWorkspaceTreeScan, setWorkspaceTreeScan, WORKSPACE_SCAN_CACHE_TTL_MS } = await import("./workspace-scan-cache");

afterAll(() => {
  closeDb();
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("workspace scan cache", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM workspace_scan_cache").run();
  });

  it("creates the cache table idempotently through database migrations", () => {
    const columns = getDb().prepare("PRAGMA table_info(workspace_scan_cache)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["cache_key", "payload", "scanned_at"]);
  });

  it("persists the bounded tree and scan timestamp", () => {
    const scannedAt = "2026-10-11T08:00:00.000Z";
    const scan = { entries: [{ path: "src/", kind: "dir" as const }, { path: "src/app.ts", kind: "file" as const, size: 12 }], truncated: false };
    setWorkspaceTreeScan("hash", scan, scannedAt);

    expect(getWorkspaceTreeScan("hash", Date.parse(scannedAt) + 1)).toEqual({ ...scan, scanned_at: scannedAt });
  });

  it("expires entries after the cache TTL", () => {
    const scannedAt = "2026-10-11T08:00:00.000Z";
    setWorkspaceTreeScan("expired", { entries: [], truncated: false }, scannedAt);

    expect(getWorkspaceTreeScan("expired", Date.parse(scannedAt) + WORKSPACE_SCAN_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("removes expired entries for other workspaces when a new scan is written", () => {
    const old = "2026-10-11T08:00:00.000Z";
    setWorkspaceTreeScan("stale-root", { entries: [{ path: "secret-plan.md", kind: "file" }], truncated: false }, old);
    setWorkspaceTreeScan("fresh-root", { entries: [], truncated: false }, new Date(Date.parse(old) + WORKSPACE_SCAN_CACHE_TTL_MS + 1).toISOString());

    const keys = getDb().prepare("SELECT cache_key FROM workspace_scan_cache").all() as Array<{ cache_key: string }>;
    expect(keys.map((row) => row.cache_key)).toEqual(["fresh-root"]);
  });

  it("rejects malformed persisted payloads", () => {
    getDb().prepare("INSERT INTO workspace_scan_cache (cache_key,payload,scanned_at) VALUES (?,?,?)")
      .run("bad", "not-json", new Date().toISOString());

    expect(getWorkspaceTreeScan("bad")).toBeNull();
  });
});
