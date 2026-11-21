import { getDataDir } from "@/lib/db/data-dir";
import { ModelNotReadyError, createModelInstaller, type ModelState, type ModelStatus } from "@/lib/assets/model-installer";
import {
  LOCAL_MODEL_FILES,
  LOCAL_MODEL_TOTAL_BYTES,
  ensureLocalModelAssets,
  localModelDir,
} from "./local-model-assets.mjs";

// The model is bundled only into offline builds; otherwise it is fetched
// once into the data directory when Jarela Local is first used (ADR-0101).
// The lifecycle itself lives in lib/assets/model-installer.ts.
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
export const LOCAL_MODEL_DOWNLOAD_ENV = "JARELA_LOCAL_EMBEDDING_DOWNLOAD";

export type LocalModelState = ModelState;
export type LocalModelStatus = ModelStatus;
/** @deprecated Import `ModelNotReadyError` from `@/lib/assets/model-installer`. */
export { ModelNotReadyError as LocalModelNotReadyError };

const installer = createModelInstaller({
  label: "Jarela Local model",
  resolveDataDir: getDataDir,
  dataSubdir: "models/local-embedding",
  bundledSubdir: ".jarela-assets/local-embedding",
  files: LOCAL_MODEL_FILES,
  totalBytes: LOCAL_MODEL_TOTAL_BYTES,
  modelDir: localModelDir,
  disabledEnv: LOCAL_MODEL_DOWNLOAD_ENV,
  stateKey: "__jarelaLocalModelDownload",
  ensure: ensureLocalModelAssets,
  timeoutMs: DOWNLOAD_TIMEOUT_MS,
  logTag: "[embeddings]",
  downloadingMessage: "the Jarela Local model is downloading; embeddings resume when it finishes",
  failedMessage: (error) => `Jarela Local model download failed: ${error}`,
  disabledMessage: (env) =>
    `the Jarela Local model is not installed and ${env}=0 disables downloading it; run \`npm run model:prepare\` or use an offline bundle`,
});

export function downloadedModelRoot(): string {
  return installer.downloadedRoot();
}

export function isLocalModelDownloadDisabled(): boolean {
  return installer.isDownloadDisabled();
}

export function getLocalModelStatus(): LocalModelStatus {
  return installer.getStatus();
}

/**
 * Start (or join) the one-time model download. `force` skips the cooldown
 * after a failure, for explicit user actions such as selecting Jarela Local.
 * Resolves to the model root with a trailing separator.
 */
export function startLocalModelDownload({ force = false } = {}): Promise<string> {
  return installer.startDownload({ force });
}

/**
 * Return the model root when installed. Otherwise kick off the download in
 * the background and throw a transient error so chat turns and indexing are
 * not blocked for the length of a ~130 MB download.
 */
export function requireLocalModelRoot(): string {
  return installer.requireRoot();
}
