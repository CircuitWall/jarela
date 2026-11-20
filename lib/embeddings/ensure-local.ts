/**
 * "Enable it and make it work" for local embeddings.
 *
 * Enabling Jarela Local now has two prerequisites:
 *   1. the inference runtime (`@huggingface/transformers` + ONNX), an
 *      on-demand package (ADR-0122);
 *   2. the bundled model assets, downloaded on first use (ADR-0101).
 *
 * `ensureLocalEmbeddings()` obtains both. The runtime is ~426 MB, so callers
 * fire it in the background and poll `getLocalEmbeddingsReadiness()` rather
 * than holding an HTTP request open.
 */
import { ensureTarget, getEnsureOutcome, type EnsureOutcome } from "@/lib/dependencies/ensure";
import {
  getLocalModelStatus,
  startLocalModelDownload,
  type LocalModelStatus,
} from "./local-model";

/** The catalogue id of the embedding runtime (lib/dependencies/optional-catalog.ts). */
export const LOCAL_EMBEDDINGS_RUNTIME = "@huggingface/transformers";

export interface LocalEmbeddingsReadiness {
  /** Runtime install state; null until the first attempt. */
  runtime: EnsureOutcome | null;
  runtime_installed: boolean;
  model: LocalModelStatus;
  ready: boolean;
  /** One line for the UI: what is happening or what to do next. */
  message: string;
}

function runtimeTarget() {
  return { kind: "runtime", id: LOCAL_EMBEDDINGS_RUNTIME } as const;
}

export function getLocalEmbeddingsReadiness(): LocalEmbeddingsReadiness {
  const runtime = getEnsureOutcome(runtimeTarget());
  const model = getLocalModelStatus();
  const runtimeInstalled = runtime?.status === "ready" || runtime?.status === "installed";
  const ready = runtimeInstalled && model.state === "ready";

  let message: string;
  if (ready) message = "Local embeddings are ready.";
  else if (!runtime || runtime.status === "running") {
    message = runtime?.message ?? "Installing the embedding runtime…";
  } else if (!runtimeInstalled) message = runtime.message;
  else if (model.state === "downloading") message = "Downloading the Jarela Local model…";
  else if (model.state === "failed") message = model.error ?? "The model download failed.";
  else message = "Preparing the Jarela Local model…";

  return { runtime, runtime_installed: runtimeInstalled, model, ready, message };
}

export interface EnsureLocalEmbeddingsOptions {
  /** Retry a previous failure instead of waiting out its cooldown. */
  force?: boolean;
}

/**
 * Install the runtime if needed, then ensure the model is present. Safe to
 * call repeatedly: installs are single-flight and the download is shared.
 */
export async function ensureLocalEmbeddings(
  options: EnsureLocalEmbeddingsOptions = {},
): Promise<LocalEmbeddingsReadiness> {
  const runtime = await ensureTarget(runtimeTarget(), options);
  if (runtime.status !== "ready" && runtime.status !== "installed") {
    return getLocalEmbeddingsReadiness();
  }

  const model = getLocalModelStatus();
  if (model.state === "ready") return getLocalEmbeddingsReadiness();

  try {
    await startLocalModelDownload({ force: options.force });
  } catch (err) {
    console.warn(
      "[embeddings] model download after enable failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return getLocalEmbeddingsReadiness();
}
