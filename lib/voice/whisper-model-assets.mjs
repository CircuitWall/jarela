// Pinned, verified assets for the Whisper input model (ADR-0123).
//
// Same pinning rules as the embedding model (ADR-0101): repository, revision,
// per-file size, and either a Git blob hash (small JSON/YAML files) or an
// LFS SHA-256 (ONNX weights). Downloads are staged and hash-verified before
// they replace anything on disk.
import { join } from "node:path";
import {
  checkAssetBytes,
  downloadAssets,
  ensureAssets,
  verifyAssets,
} from "../assets/verified-download.mjs";
import { fetchBytesWithRetry } from "../embeddings/fetch-with-retry.mjs";

export const WHISPER_MODEL_REPOSITORY = "Xenova/whisper-tiny";
export const WHISPER_MODEL_REVISION = "5332fcc35e32a33b86612b9a57a89be7906102b1";

/** @type {ReadonlyArray<{ path: string; size: number; sha256?: string; gitBlobOid?: string }>} */
export const WHISPER_MODEL_FILES = [
  { path: "added_tokens.json", size: 2_082, gitBlobOid: "a973b01f5b1e5755fb2fd8a89cbd0c0c0ccf1460" },
  { path: "config.json", size: 2_248, gitBlobOid: "dea913aa8ec7d53db029e97c97a766d534c8da04" },
  { path: "generation_config.json", size: 3_716, gitBlobOid: "72e54ad7340e05287aa731f9d8556b5368be3fe0" },
  { path: "merges.txt", size: 493_869, gitBlobOid: "6038932a2a1f09a66991b1c2adae0d14066fa29e" },
  { path: "normalizer.json", size: 52_666, gitBlobOid: "dd6ae819ad738ac1a546e9f9282ef325c33b9ea0" },
  { path: "preprocessor_config.json", size: 339, gitBlobOid: "91876762a536a746d268353c5cba57286e76b058" },
  { path: "quant_config.json", size: 2_840, gitBlobOid: "051bb64c9952787c51421f69ee74170d15240fec" },
  { path: "special_tokens_map.json", size: 2_194, gitBlobOid: "bf69932dca4b3719b59fdd8f6cc1978109509f6c" },
  { path: "tokenizer.json", size: 2_480_466, gitBlobOid: "1e95340ff836fad1b5932e800fb7b8c5e6d78a74" },
  { path: "tokenizer_config.json", size: 282_683, gitBlobOid: "d13b786c04765fb1a06492b53587752cd67665ea" },
  { path: "vocab.json", size: 1_036_584, gitBlobOid: "90e797dd4fd05d9dea443d702ca06be2463c5f2f" },
  {
    path: "onnx/encoder_model_quantized.onnx",
    size: 10_124_910,
    sha256: "fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e",
  },
  {
    path: "onnx/decoder_model_merged_quantized.onnx",
    size: 30_727_765,
    sha256: "6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0",
  },
];

export const WHISPER_MODEL_TOTAL_BYTES = WHISPER_MODEL_FILES.reduce((sum, file) => sum + file.size, 0);

const NOTICE = [
  `Whisper input model: ${WHISPER_MODEL_REPOSITORY}`,
  `Revision: ${WHISPER_MODEL_REVISION}`,
  "License: MIT (see the upstream model card).",
  "Multilingual speech recognition, quantized ONNX weights, ~45 MB.",
  `Source: https://huggingface.co/${WHISPER_MODEL_REPOSITORY}`,
  "",
].join("\n");

/** @param {string} assetsRoot */
export function whisperModelDir(assetsRoot) {
  return join(assetsRoot, WHISPER_MODEL_REPOSITORY);
}

/**
 * @param {Buffer} bytes
 * @param {{ path: string; size: number; sha256?: string; gitBlobOid?: string }} file
 * @returns {string | null} problem description, or null when the bytes match the pin
 */
export function checkWhisperModelBytes(bytes, file) {
  return checkAssetBytes(bytes, file);
}

/**
 * @param {string} assetsRoot
 * @returns {Promise<string[]>} problems; empty means the model is complete and intact
 */
export async function verifyWhisperModelAssets(assetsRoot, { files = WHISPER_MODEL_FILES } = {}) {
  return verifyAssets(assetsRoot, { files, dirName: WHISPER_MODEL_REPOSITORY });
}

/**
 * @param {string} assetsRoot
 * @param {{ files?: typeof WHISPER_MODEL_FILES; fetchBytes?: typeof fetchBytesWithRetry; timeoutMs?: number; log?: (message: string) => void }} [options]
 */
export async function downloadWhisperModelAssets(assetsRoot, {
  files = WHISPER_MODEL_FILES,
  fetchBytes = fetchBytesWithRetry,
  timeoutMs = 120_000,
  log = (message) => console.warn(message),
} = {}) {
  return downloadAssets(assetsRoot, {
    files,
    dirName: WHISPER_MODEL_REPOSITORY,
    repository: WHISPER_MODEL_REPOSITORY,
    revision: WHISPER_MODEL_REVISION,
    notice: NOTICE,
    fetchBytes,
    timeoutMs,
    log,
  });
}

/**
 * @param {string} assetsRoot
 * @param {Parameters<typeof downloadWhisperModelAssets>[1]} [options]
 * @returns {Promise<"verified" | "downloaded">}
 */
export async function ensureWhisperModelAssets(assetsRoot, options = {}) {
  const {
    files = WHISPER_MODEL_FILES,
    fetchBytes = fetchBytesWithRetry,
    timeoutMs = 120_000,
    log = (message) => console.warn(message),
  } = options;
  return ensureAssets(assetsRoot, {
    files,
    dirName: WHISPER_MODEL_REPOSITORY,
    repository: WHISPER_MODEL_REPOSITORY,
    revision: WHISPER_MODEL_REVISION,
    notice: NOTICE,
    fetchBytes,
    timeoutMs,
    log,
  });
}
