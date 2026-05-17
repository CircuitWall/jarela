// Local file store for binary artifacts produced by tools (generated images,
// downloads, etc.). Files live under ~/.jarela/files/ and are served by
// GET /api/v1/files/[name]. The tool returns a relative URL the chat
// renderer can embed as <img src="/api/v1/files/...">.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
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
