import { getDataDir } from "@/lib/db/data-dir";
import { ModelNotReadyError, createModelInstaller, type ModelState, type ModelStatus } from "@/lib/assets/model-installer";
import {
  WHISPER_MODEL_FILES,
  WHISPER_MODEL_TOTAL_BYTES,
  ensureWhisperModelAssets,
  whisperModelDir,
} from "./whisper-model-assets.mjs";

// ADR-0123. The Whisper input model is fetched once into the data directory
// when the whisper STT engine is first used; it ships in offline bundles
// under `.jarela-assets/whisper`. The lifecycle itself lives in
// lib/assets/model-installer.ts, shared with the embedding model.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const WHISPER_DOWNLOAD_ENV = "JARELA_WHISPER_DOWNLOAD";

export type WhisperModelState = ModelState;
export type WhisperModelStatus = ModelStatus;
export { ModelNotReadyError as WhisperModelNotReadyError };

const installer = createModelInstaller({
  label: "Whisper model",
  resolveDataDir: getDataDir,
  dataSubdir: "models/whisper",
  bundledSubdir: ".jarela-assets/whisper",
  files: WHISPER_MODEL_FILES,
  totalBytes: WHISPER_MODEL_TOTAL_BYTES,
  modelDir: whisperModelDir,
  disabledEnv: WHISPER_DOWNLOAD_ENV,
  stateKey: "__jarelaWhisperModelDownload",
  ensure: ensureWhisperModelAssets,
  timeoutMs: DOWNLOAD_TIMEOUT_MS,
  logTag: "[voice]",
  downloadingMessage: "the Whisper model is downloading; voice input resumes when it finishes",
  failedMessage: (error) => `Whisper model download failed: ${error}`,
  disabledMessage: (env) =>
    `the Whisper model is not installed and ${env}=0 disables downloading it; use an offline bundle or the Gemini engine`,
});

export function downloadedWhisperRoot(): string {
  return installer.downloadedRoot();
}

export function isWhisperDownloadDisabled(): boolean {
  return installer.isDownloadDisabled();
}

export function getWhisperModelStatus(): WhisperModelStatus {
  return installer.getStatus();
}

/** Start (or join) the one-time model download. */
export function startWhisperModelDownload({ force = false } = {}): Promise<string> {
  return installer.startDownload({ force });
}

/**
 * Return the assets root (the directory that contains `Xenova/whisper-tiny`)
 * when installed. Otherwise start the download in the background and throw a
 * transient error so the request fails fast instead of holding a socket open
 * for the length of a ~45 MB download.
 */
export function requireWhisperModelRoot(): string {
  return installer.requireRoot();
}
