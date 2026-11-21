// Shared "pin, verify, stage, swap" installer for local model assets.
//
// The Jarela Local embedding model (ADR-0101) and the Whisper input model
// (ADR-0123) both install this way: every file is pinned by size plus a
// content hash, downloads land in a sibling staging directory, and the
// staging directory is renamed into place only after every byte verifies —
// so a partial or tampered download is never visible as a usable model.
//
// Plain ESM so the build scripts (`npm run model:prepare`) and the Next
// server share one implementation.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** @param {Buffer} bytes */
export function gitBlobOid(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * @param {Buffer} bytes
 * @param {{ path: string; size: number; sha256?: string; gitBlobOid?: string }} file
 * @returns {string | null} problem description, or null when the bytes match the pin
 */
export function checkAssetBytes(bytes, file) {
  if (bytes.length !== file.size) return `size mismatch for ${file.path}: expected ${file.size}, got ${bytes.length}`;
  if (file.sha256 && createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    return `SHA-256 mismatch for ${file.path}`;
  }
  if (file.gitBlobOid && gitBlobOid(bytes) !== file.gitBlobOid) return `Git blob hash mismatch for ${file.path}`;
  return null;
}

/**
 * Hash-verify every pinned asset under `<assetsRoot>/<dirName>`.
 * @param {string} assetsRoot
 * @param {{ files: ReadonlyArray<{ path: string; size: number; sha256?: string; gitBlobOid?: string }>; dirName: string }} spec
 * @returns {Promise<string[]>} problems; empty means the model is complete and intact
 */
export async function verifyAssets(assetsRoot, { files, dirName }) {
  const problems = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = await readFile(join(assetsRoot, dirName, file.path));
    } catch {
      problems.push(`missing ${file.path}`);
      continue;
    }
    const problem = checkAssetBytes(bytes, file);
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * Download every pinned asset into a sibling staging directory, verify each
 * file before writing, then swap it into `assetsRoot` so a partial download
 * is never visible as a usable model.
 *
 * @param {string} assetsRoot
 * @param {{
 *   files: ReadonlyArray<{ path: string; size: number; sha256?: string; gitBlobOid?: string }>;
 *   dirName: string;
 *   repository: string;
 *   revision: string;
 *   notice: string;
 *   fetchBytes: (url: string, options: { label: string; timeoutMs: number; log: (message: string) => void }) => Promise<Buffer>;
 *   timeoutMs?: number;
 *   log?: (message: string) => void;
 * }} options
 */
export async function downloadAssets(assetsRoot, {
  files,
  dirName,
  repository,
  revision,
  notice,
  fetchBytes,
  timeoutMs = 120_000,
  log = (message) => console.warn(message),
}) {
  const stageRoot = join(dirname(assetsRoot), `.staging-${process.pid}-${Date.now()}`);
  const stageAssetsRoot = join(stageRoot, basename(assetsRoot));
  const stageModelDir = join(stageAssetsRoot, dirName);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageModelDir, { recursive: true });
  try {
    for (const file of files) {
      const url = `https://huggingface.co/${repository}/resolve/${revision}/${file.path}?download=true`;
      const bytes = await fetchBytes(url, { label: file.path, timeoutMs, log });
      const problem = checkAssetBytes(bytes, file);
      if (problem) throw new Error(problem);
      const destination = join(stageModelDir, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(stageModelDir, "MODEL-NOTICE.txt"), notice);
    const backup = `${assetsRoot}.previous-${process.pid}`;
    await rm(backup, { recursive: true, force: true });
    try {
      await rename(assetsRoot, backup);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error)?.code !== "ENOENT") throw error;
    }
    await rename(stageAssetsRoot, assetsRoot);
    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

/**
 * Verify the model under `assetsRoot`, downloading it when absent or
 * corrupt, and re-verify the result.
 * @param {string} assetsRoot
 * @param {Parameters<typeof downloadAssets>[1]} options
 * @returns {Promise<"verified" | "downloaded">}
 */
export async function ensureAssets(assetsRoot, options) {
  if ((await verifyAssets(assetsRoot, options)).length === 0) {
    await writeFile(join(assetsRoot, options.dirName, "MODEL-NOTICE.txt"), options.notice);
    return "verified";
  }
  await mkdir(dirname(assetsRoot), { recursive: true });
  await downloadAssets(assetsRoot, options);
  const problems = await verifyAssets(assetsRoot, options);
  if (problems.length > 0) throw new Error(`downloaded model failed verification: ${problems.join("; ")}`);
  return "downloaded";
}
