// Pinned, verified assets for the Jarela Local embedding model (ADR-0101).
// The staging/verification dance lives in lib/assets/verified-download.mjs so
// other local models (Whisper input, ADR-0123) install the same way.
import { join } from "node:path";
import {
  checkAssetBytes,
  downloadAssets,
  ensureAssets,
  verifyAssets,
} from "../assets/verified-download.mjs";
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

/**
 * @param {Buffer} bytes
 * @param {{ path: string; size: number; sha256?: string; gitBlobOid?: string }} file
 * @returns {string | null} problem description, or null when the bytes match the pin
 */
export function checkLocalModelBytes(bytes, file) {
  return checkAssetBytes(bytes, file);
}

/**
 * Hash-verify every pinned asset under `assetsRoot`.
 * @param {string} assetsRoot
 * @returns {Promise<string[]>} problems; empty means the model is complete and intact
 */
export async function verifyLocalModelAssets(assetsRoot, { files = LOCAL_MODEL_FILES } = {}) {
  return verifyAssets(assetsRoot, { files, dirName: LOCAL_MODEL_REPOSITORY });
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
  return downloadAssets(assetsRoot, {
    files,
    dirName: LOCAL_MODEL_REPOSITORY,
    repository: LOCAL_MODEL_REPOSITORY,
    revision: LOCAL_MODEL_REVISION,
    notice: NOTICE,
    fetchBytes,
    timeoutMs,
    log,
  });
}

/**
 * Verify the model under `assetsRoot`, downloading it when absent or
 * corrupt, and re-verify the result.
 * @param {string} assetsRoot
 * @param {Parameters<typeof downloadLocalModelAssets>[1]} [options]
 * @returns {Promise<"verified" | "downloaded">}
 */
export async function ensureLocalModelAssets(assetsRoot, options = {}) {
  const {
    files = LOCAL_MODEL_FILES,
    fetchBytes = fetchBytesWithRetry,
    timeoutMs = 120_000,
    log = (message) => console.warn(message),
  } = options;
  return ensureAssets(assetsRoot, {
    files,
    dirName: LOCAL_MODEL_REPOSITORY,
    repository: LOCAL_MODEL_REPOSITORY,
    revision: LOCAL_MODEL_REVISION,
    notice: NOTICE,
    fetchBytes,
    timeoutMs,
    log,
  });
}
