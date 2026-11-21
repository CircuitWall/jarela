// Shared "find, download, expose readiness" state machine for local models.
//
// The embedding model (ADR-0101) and the Whisper input model (ADR-0123) have
// identical lifecycle rules: prefer a bundled copy, otherwise download once
// into the data directory, fail fast with a transient error while the
// download is in flight, back off after a failure, and expose a status object
// the UI can poll. Only the paths, labels and pinned file list differ, so
// they share this installer instead of two copies of the same control flow.
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type ModelState = "ready" | "downloading" | "failed" | "missing";

export interface ModelStatus {
  state: ModelState;
  source?: "bundled" | "downloaded";
  totalBytes: number;
  error?: string;
}

/** Thrown while a model is not available yet; callers surface a retry. */
export class ModelNotReadyError extends Error {
  readonly transient = true;
}

interface DownloadState {
  promise?: Promise<string>;
  error?: string;
  failedAt?: number;
}

export interface ModelInstallerOptions {
  /** Human label used in log lines and error messages, e.g. "Whisper model". */
  label: string;
  /** Resolved lazily so tests can redirect the data directory. */
  resolveDataDir: () => string;
  /** Path under the data directory, e.g. `models/whisper`. */
  dataSubdir: string;
  /** Path under `process.cwd()` that holds an offline bundled copy. */
  bundledSubdir: string;
  /** Pinned files, used for the completeness check. */
  files: ReadonlyArray<{ path: string; size: number }>;
  totalBytes: number;
  /** Directory that actually contains the model files, inside an assets root. */
  modelDir: (assetsRoot: string) => string;
  /** Environment variable that disables downloading when set to "0". */
  disabledEnv: string;
  /** `globalThis` key holding the memoized download state. */
  stateKey: string;
  /** Verifies, then downloads (and re-verifies) the pinned assets. */
  ensure: (assetsRoot: string, options: { timeoutMs: number }) => Promise<unknown>;
  downloadingMessage: string;
  failedMessage: (error: string) => string;
  disabledMessage: (env: string) => string;
  logTag: string;
  timeoutMs?: number;
  retryCooldownMs?: number;
}

export interface ModelInstaller {
  /** `<data>/<dataSubdir>` — the assets root for this family. */
  downloadedRoot(): string;
  isDownloadDisabled(): boolean;
  getStatus(): ModelStatus;
  startDownload(options?: { force?: boolean }): Promise<string>;
  /** Installed root with a trailing separator, or a transient throw. */
  requireRoot(): string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETRY_COOLDOWN_MS = 5 * 60_000;

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : `${path}${sep}`;
}

export function createModelInstaller(options: ModelInstallerOptions): ModelInstaller {
  const {
    label,
    resolveDataDir,
    dataSubdir,
    bundledSubdir,
    files,
    totalBytes,
    modelDir,
    disabledEnv,
    stateKey,
    ensure,
    downloadingMessage,
    failedMessage,
    disabledMessage,
    logTag,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retryCooldownMs = DEFAULT_RETRY_COOLDOWN_MS,
  } = options;

  const globals = globalThis as typeof globalThis & { [key: string]: DownloadState | undefined };

  function state(): DownloadState {
    globals[stateKey] ??= {};
    return globals[stateKey] as DownloadState;
  }

  function downloadedRoot(): string {
    return join(resolveDataDir(), dataSubdir);
  }

  function bundledRoots(): string[] {
    return [
      resolve(process.cwd(), bundledSubdir),
      resolve(process.cwd(), ".next", "standalone", bundledSubdir),
    ];
  }

  // Size-only check: cheap enough for every call. Downloads are hash-verified
  // before they are swapped into place, so a complete set of correctly sized
  // files is the verified model.
  function hasCompleteModel(root: string): boolean {
    return files.every((file) => {
      const path = join(modelDir(root), file.path);
      return existsSync(path) && statSync(path).size === file.size;
    });
  }

  function findRoot(): { root: string; source: "bundled" | "downloaded" } | null {
    for (const root of bundledRoots()) {
      if (hasCompleteModel(root)) return { root, source: "bundled" };
    }
    const downloaded = downloadedRoot();
    return hasCompleteModel(downloaded) ? { root: downloaded, source: "downloaded" } : null;
  }

  function isDownloadDisabled(): boolean {
    return process.env[disabledEnv] === "0";
  }

  function getStatus(): ModelStatus {
    const found = findRoot();
    if (found) return { state: "ready", source: found.source, totalBytes };
    const current = state();
    if (current.promise) return { state: "downloading", totalBytes };
    if (isDownloadDisabled()) return { state: "missing", totalBytes, error: disabledMessage(disabledEnv) };
    if (current.error) return { state: "failed", totalBytes, error: current.error };
    return { state: "missing", totalBytes };
  }

  function startDownload({ force = false } = {}): Promise<string> {
    const found = findRoot();
    if (found) return Promise.resolve(withTrailingSep(found.root));
    const current = state();
    if (current.promise) return current.promise;
    if (isDownloadDisabled()) return Promise.reject(new Error(disabledMessage(disabledEnv)));
    if (!force && current.failedAt && Date.now() - current.failedAt < retryCooldownMs) {
      return Promise.reject(new ModelNotReadyError(failedMessage(current.error ?? "unknown error")));
    }
    const root = downloadedRoot();
    current.error = undefined;
    current.failedAt = undefined;
    current.promise = ensure(root, { timeoutMs })
      .then(() => {
        console.info(`${logTag} downloaded the ${label} into ${root}`);
        return withTrailingSep(root);
      })
      .catch((err: unknown) => {
        current.error = err instanceof Error ? err.message : String(err);
        current.failedAt = Date.now();
        console.warn(`${logTag} ${label} download failed:`, current.error);
        throw err;
      })
      .finally(() => {
        current.promise = undefined;
      });
    return current.promise;
  }

  /**
   * Installed root when present. Otherwise start the download in the
   * background and throw a transient error so the caller fails fast instead
   * of holding a request open for a multi-megabyte download.
   */
  function requireRoot(): string {
    const found = findRoot();
    if (found) return withTrailingSep(found.root);
    if (isDownloadDisabled()) throw new Error(disabledMessage(disabledEnv));
    startDownload().catch(() => {});
    const status = getStatus();
    throw new ModelNotReadyError(status.state === "failed"
      ? failedMessage(status.error ?? "unknown error")
      : downloadingMessage);
  }

  return { downloadedRoot, isDownloadDisabled, getStatus, startDownload, requireRoot };
}
