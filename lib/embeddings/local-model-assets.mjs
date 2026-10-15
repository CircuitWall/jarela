// Pinned, verified assets for the Jarela Local embedding model (ADR-0101).
// Plain ESM so the build scripts and the Next server share one manifest.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fetchBytesWithRetry } from "./fetch-with-retry.mjs";

export const LOCAL_MODEL_REPOSITORY = "Xenova/multilingual-e5-small";
export const LOCAL_MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";

/** @type {ReadonlyArray<{ path: string; size: number; sha256?: string; gitBlobOid?: string }>} */
export const LOCAL_MODEL_FILES = [
  { path: "README.md", size: 1_077, gitBlobOid: "53e76ac0e07cb45ebbf3870244998e0f08632d4f" },
  { path: "config.json", size: 658, gitBlobOid: "4104f38273cc595fd9500fd243124e9f6cf383dc" },
  { path: "special_tokens_map.json", size: 167, gitBlobOid: "e0b1d18ecd0ae4ff1d47bd297d910c0cf83e504b" },
  {
    path: "tokenizer.json",
    size: 17_082_730,
    sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  },
  { path: "tokenizer_config.json", size: 443, gitBlobOid: "059214673d9d6d2ee319411e2ffec8c024b816d5" },
  {
    path: "onnx/model_quantized.onnx",
    size: 118_308_185,
    sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
  },
];

export const LOCAL_MODEL_TOTAL_BYTES = LOCAL_MODEL_FILES.reduce((sum, file) => sum + file.size, 0);

const NOTICE = [
  `Jarela Local embedding model: ${LOCAL_MODEL_REPOSITORY}`,
  `Revision: ${LOCAL_MODEL_REVISION}`,
  "License: MIT (see the upstream model card).",
  "The model supports about 100 languages and produces 384-dimensional vectors.",
  "Queries use the `query: ` prefix; indexed passages use the `passage: ` prefix.",
  `Source: https://huggingface.co/${LOCAL_MODEL_REPOSITORY}`,
  "Base model: https://huggingface.co/intfloat/multilingual-e5-small",
  "",
].join("\n");

/** @param {string} assetsRoot */
export function localModelDir(assetsRoot) {
  return join(assetsRoot, LOCAL_MODEL_REPOSITORY);
}

/** @param {Buffer} bytes */
function gitBlobOid(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * @param {Buffer} bytes
 * @param {{ path: string; size: number; sha256?: string; gitBlobOid?: string }} file
 * @returns {string | null} problem description, or null when the bytes match the pin
 */
export function checkLocalModelBytes(bytes, file) {
  if (bytes.length !== file.size) return `size mismatch for ${file.path}: expected ${file.size}, got ${bytes.length}`;
  if (file.sha256 && createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    return `SHA-256 mismatch for ${file.path}`;
  }
  if (file.gitBlobOid && gitBlobOid(bytes) !== file.gitBlobOid) return `Git blob hash mismatch for ${file.path}`;
  return null;
}

/**
 * Hash-verify every pinned asset under `assetsRoot`.
 * @param {string} assetsRoot
 * @returns {Promise<string[]>} problems; empty means the model is complete and intact
 */
export async function verifyLocalModelAssets(assetsRoot, { files = LOCAL_MODEL_FILES } = {}) {
  const problems = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = await readFile(join(localModelDir(assetsRoot), file.path));
    } catch {
      problems.push(`missing ${file.path}`);
      continue;
    }
    const problem = checkLocalModelBytes(bytes, file);
    if (problem) problems.push(problem);
  }
  return problems;
}

/**
 * Download every pinned asset into a sibling staging directory, verify each
 * file before writing, then swap it into `assetsRoot` so a partial download
 * is never visible as a usable model.
 * @param {string} assetsRoot
 * @param {{ files?: typeof LOCAL_MODEL_FILES; fetchBytes?: typeof fetchBytesWithRetry; timeoutMs?: number; log?: (message: string) => void }} [options]
 */
export async function downloadLocalModelAssets(assetsRoot, {
  files = LOCAL_MODEL_FILES,
  fetchBytes = fetchBytesWithRetry,
  timeoutMs = 120_000,
  log = (message) => console.warn(message),
} = {}) {
  const stageRoot = join(dirname(assetsRoot), `.staging-${process.pid}-${Date.now()}`);
  const stageAssetsRoot = join(stageRoot, basename(assetsRoot));
  const stageModelDir = localModelDir(stageAssetsRoot);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageModelDir, { recursive: true });
  try {
    for (const file of files) {
      const url = `https://huggingface.co/${LOCAL_MODEL_REPOSITORY}/resolve/${LOCAL_MODEL_REVISION}/${file.path}?download=true`;
      const bytes = await fetchBytes(url, { label: file.path, timeoutMs, log });
      const problem = checkLocalModelBytes(bytes, file);
      if (problem) throw new Error(problem);
      const destination = join(stageModelDir, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    await writeFile(join(stageModelDir, "MODEL-NOTICE.txt"), NOTICE);
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
 * @param {Parameters<typeof downloadLocalModelAssets>[1]} [options]
 * @returns {Promise<"verified" | "downloaded">}
 */
export async function ensureLocalModelAssets(assetsRoot, options = {}) {
  if ((await verifyLocalModelAssets(assetsRoot, options)).length === 0) {
    await writeFile(join(localModelDir(assetsRoot), "MODEL-NOTICE.txt"), NOTICE);
    return "verified";
  }
  await mkdir(dirname(assetsRoot), { recursive: true });
  await downloadLocalModelAssets(assetsRoot, options);
  const problems = await verifyLocalModelAssets(assetsRoot, options);
  if (problems.length > 0) throw new Error(`downloaded model failed verification: ${problems.join("; ")}`);
  return "downloaded";
}
