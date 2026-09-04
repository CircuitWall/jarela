// Local file store for binary artifacts produced by tools (generated images,
// downloads, etc.). Files live under ~/.jarela/files/ and are served by
// GET /api/v1/files/[name]. The tool returns a relative URL the chat
// renderer can embed as <img src="/api/v1/files/...">.

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";

export const FILES_DIR = join(getDataDir(), "files");

mkdirSync(FILES_DIR, { recursive: true });

// Name must be a single path segment with no separators or "..". Callers
// generate names from randomUUID() so this is mostly defense-in-depth.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function isSafeFileName(name: string): boolean {
  return SAFE_NAME.test(name) && !name.includes("..");
}

export function fileAbsPath(name: string): string | null {
  if (!isSafeFileName(name)) return null;
  return join(FILES_DIR, name);
}

export function writeBinaryFile(name: string, data: Buffer): string {
  if (!isSafeFileName(name)) throw new Error(`unsafe file name: ${name}`);
  const p = join(FILES_DIR, name);
  writeFileSync(p, data);
  return p;
}

export function writeTextFile(name: string, data: string): string {
  if (!isSafeFileName(name)) throw new Error(`unsafe file name: ${name}`);
  const p = join(FILES_DIR, name);
  writeFileSync(p, data, "utf8");
  return p;
}

export type ArtifactKind = "browser" | "generated" | "attachment" | "other";

export interface ArtifactFileInfo {
  name: string;
  kind: ArtifactKind;
  media_type: string;
  size: number;
  created_at: string;
  updated_at: string;
  age_days: number;
}

export interface ArtifactInventory {
  files: ArtifactFileInfo[];
  total_files: number;
  total_bytes: number;
  browser_bytes: number;
  generated_bytes: number;
}

export interface ArtifactCleanupPolicy {
  retention_days: number;
  max_total_mb: number;
  include_browser_artifacts: boolean;
  include_generated_media: boolean;
}

export interface ArtifactCleanupResult {
  deleted: ArtifactFileInfo[];
  deleted_count: number;
  deleted_bytes: number;
  dry_run: boolean;
  before: ArtifactInventory;
  after: ArtifactInventory;
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
};

export function listArtifactFiles(nowMs = Date.now()): ArtifactInventory {
  mkdirSync(FILES_DIR, { recursive: true });
  const files: ArtifactFileInfo[] = [];
  for (const name of readdirSync(FILES_DIR)) {
    if (!isSafeFileName(name)) continue;
    const abs = join(FILES_DIR, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({
      name,
      kind: classifyArtifactName(name),
      media_type: MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream",
      size: stat.size,
      created_at: new Date(stat.birthtimeMs).toISOString(),
      updated_at: new Date(stat.mtimeMs).toISOString(),
      age_days: Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 86_400_000)),
    });
  }
  files.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return summarizeArtifacts(files);
}

export function cleanupArtifactFiles(policy: ArtifactCleanupPolicy, dryRun = false, nowMs = Date.now()): ArtifactCleanupResult {
  const before = listArtifactFiles(nowMs);
  const cutoffMs = nowMs - Math.max(1, policy.retention_days) * 86_400_000;
  const maxBytes = Math.max(1, policy.max_total_mb) * 1024 * 1024;
  const eligible = before.files.filter((file) => isLifecycleManaged(file, policy));
  const toDelete = new Map<string, ArtifactFileInfo>();

  for (const file of eligible) {
    const updated = Date.parse(file.updated_at);
    if (Number.isFinite(updated) && updated < cutoffMs) toDelete.set(file.name, file);
  }

  let retainedBytes = before.total_bytes - Array.from(toDelete.values()).reduce((sum, file) => sum + file.size, 0);
  if (retainedBytes > maxBytes) {
    const oldestFirst = eligible
      .filter((file) => !toDelete.has(file.name))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    for (const file of oldestFirst) {
      if (retainedBytes <= maxBytes) break;
      toDelete.set(file.name, file);
      retainedBytes -= file.size;
    }
  }

  const deleted = Array.from(toDelete.values()).sort((a, b) => a.updated_at.localeCompare(b.updated_at));
  if (!dryRun) {
    for (const file of deleted) {
      const abs = fileAbsPath(file.name);
      if (!abs) continue;
      try { unlinkSync(abs); } catch { /* ignore races */ }
    }
  }
  const after = dryRun ? before : listArtifactFiles(nowMs);
  return {
    deleted,
    deleted_count: deleted.length,
    deleted_bytes: deleted.reduce((sum, file) => sum + file.size, 0),
    dry_run: dryRun,
    before,
    after,
  };
}

function summarizeArtifacts(files: ArtifactFileInfo[]): ArtifactInventory {
  return {
    files,
    total_files: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.size, 0),
    browser_bytes: files.filter((file) => file.kind === "browser").reduce((sum, file) => sum + file.size, 0),
    generated_bytes: files.filter((file) => file.kind === "generated").reduce((sum, file) => sum + file.size, 0),
  };
}

function classifyArtifactName(name: string): ArtifactKind {
  if (name.startsWith("browser-") || name.startsWith("browser-extract-")) return "browser";
  if (name.startsWith("generated-") || name.startsWith("voice-") || name.startsWith("image-") || name.startsWith("img-")) return "generated";
  if (name.startsWith("attachment-")) return "attachment";
  return "other";
}

function isLifecycleManaged(file: ArtifactFileInfo, policy: ArtifactCleanupPolicy): boolean {
  if (file.kind === "browser") return policy.include_browser_artifacts;
  if (file.kind === "generated") return policy.include_generated_media;
  return false;
}
