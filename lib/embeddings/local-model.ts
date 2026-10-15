import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";
import { errorMessage } from "@/lib/utils/error";
import {
  LOCAL_MODEL_FILES,
  LOCAL_MODEL_TOTAL_BYTES,
  ensureLocalModelAssets,
  localModelDir,
} from "./local-model-assets.mjs";

// The model is bundled only into offline builds; otherwise it is fetched
// once into the data directory when Jarela Local is first used (ADR-0101).
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const FAILED_RETRY_COOLDOWN_MS = 5 * 60_000;
export const LOCAL_MODEL_DOWNLOAD_ENV = "JARELA_LOCAL_EMBEDDING_DOWNLOAD";

export type LocalModelState = "ready" | "downloading" | "failed" | "missing";

export interface LocalModelStatus {
  state: LocalModelState;
  source?: "bundled" | "downloaded";
  totalBytes: number;
  error?: string;
}

/** Thrown while the model is not available yet; embedding callers retry later. */
export class LocalModelNotReadyError extends Error {
  readonly transient = true;
}

interface DownloadState {
  promise?: Promise<string>;
  error?: string;
  failedAt?: number;
}

const globals = globalThis as typeof globalThis & { __jarelaLocalModelDownload?: DownloadState };

function downloadState(): DownloadState {
  globals.__jarelaLocalModelDownload ??= {};
  return globals.__jarelaLocalModelDownload;
}

export function downloadedModelRoot(): string {
  return join(getDataDir(), "models", "local-embedding");
}

function bundledModelRoots(): string[] {
  return [
    resolve(process.cwd(), ".jarela-assets", "local-embedding"),
    resolve(process.cwd(), ".next", "standalone", ".jarela-assets", "local-embedding"),
  ];
}

// Size-only check: cheap enough for every call. Downloads are hash-verified
// before they are swapped into place, so a complete set of correctly sized
// files is the verified model.
function hasCompleteModel(root: string): boolean {
  return LOCAL_MODEL_FILES.every((file) => {
    const path = join(localModelDir(root), file.path);
    return existsSync(path) && statSync(path).size === file.size;
  });
}

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

function findModelRoot(): { root: string; source: "bundled" | "downloaded" } | null {
  for (const root of bundledModelRoots()) {
    if (hasCompleteModel(root)) return { root, source: "bundled" };
  }
  const downloaded = downloadedModelRoot();
  return hasCompleteModel(downloaded) ? { root: downloaded, source: "downloaded" } : null;
}

export function isLocalModelDownloadDisabled(): boolean {
  return process.env[LOCAL_MODEL_DOWNLOAD_ENV] === "0";
}

export function getLocalModelStatus(): LocalModelStatus {
  const found = findModelRoot();
  if (found) return { state: "ready", source: found.source, totalBytes: LOCAL_MODEL_TOTAL_BYTES };
  const state = downloadState();
  if (state.promise) return { state: "downloading", totalBytes: LOCAL_MODEL_TOTAL_BYTES };
  if (isLocalModelDownloadDisabled()) {
    return {
      state: "missing",
      totalBytes: LOCAL_MODEL_TOTAL_BYTES,
      error: `the Jarela Local model is not installed and ${LOCAL_MODEL_DOWNLOAD_ENV}=0 disables downloading it; run \`npm run model:prepare\` or use an offline bundle`,
    };
  }
  if (state.error) return { state: "failed", totalBytes: LOCAL_MODEL_TOTAL_BYTES, error: state.error };
  return { state: "missing", totalBytes: LOCAL_MODEL_TOTAL_BYTES };
}

/**
 * Start (or join) the one-time model download. `force` skips the cooldown
 * after a failure, for explicit user actions such as selecting Jarela Local.
 * Resolves to the model root with a trailing separator.
 */
export function startLocalModelDownload({ force = false } = {}): Promise<string> {
  const found = findModelRoot();
  if (found) return Promise.resolve(withTrailingSep(found.root));
  const state = downloadState();
  if (state.promise) return state.promise;
  if (isLocalModelDownloadDisabled()) {
    return Promise.reject(new Error(getLocalModelStatus().error));
  }
  if (!force && state.failedAt && Date.now() - state.failedAt < FAILED_RETRY_COOLDOWN_MS) {
    return Promise.reject(new LocalModelNotReadyError(`Jarela Local model download failed: ${state.error}`));
  }
  const root = downloadedModelRoot();
  state.error = undefined;
  state.failedAt = undefined;
  state.promise = ensureLocalModelAssets(root, { timeoutMs: DOWNLOAD_TIMEOUT_MS })
    .then(() => {
      console.info(`[embeddings] downloaded the Jarela Local model into ${root}`);
      return withTrailingSep(root);
    })
    .catch((err: unknown) => {
      state.error = errorMessage(err);
      state.failedAt = Date.now();
      console.warn("[embeddings] Jarela Local model download failed:", state.error);
      throw err;
    })
    .finally(() => {
      state.promise = undefined;
    });
  return state.promise;
}

/**
 * Return the model root when installed. Otherwise kick off the download in
 * the background and throw a transient error so chat turns and indexing are
 * not blocked for the length of a ~130 MB download.
 */
export function requireLocalModelRoot(): string {
  const found = findModelRoot();
  if (found) return withTrailingSep(found.root);
  if (isLocalModelDownloadDisabled()) throw new Error(getLocalModelStatus().error);
  startLocalModelDownload().catch(() => {});
  const status = getLocalModelStatus();
  throw new LocalModelNotReadyError(status.state === "failed"
    ? `Jarela Local model download failed: ${status.error}`
    : "the Jarela Local model is downloading; embeddings resume when it finishes");
}
