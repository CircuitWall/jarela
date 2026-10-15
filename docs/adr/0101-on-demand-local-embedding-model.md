---
status: accepted
date: 2026-10-15
deciders: Jarela maintainers
---

# Download the Jarela Local embedding model on first use

## Context and Problem Statement

[ADR-0093](0093-bundled-local-embeddings.md) shipped the quantized `Xenova/multilingual-e5-small` model (about 136 MB of weights and tokenizer data) in every distribution. Jarela Local is opt-in: most installs use a configured provider or Auto and never load it. Even after ADR-0093's runtime pruning, every native, portable, npm, and Docker artifact carried the model, and artifacts that large contributed to the v2.1.0 release attach job failing to transfer them.

## Decision

Stop bundling the model by default. When the user selects Jarela Local, download it once into `<data dir>/models/local-embedding` (`%LOCALAPPDATA%\Jarela` or `~/.jarela`, or `JARELA_DB_DIR`).

* **Integrity.** A single manifest in `lib/embeddings/local-model-assets.mjs` pins the upstream repository, the revision, and each file's size and SHA-256 or Git blob hash. Each downloaded file is verified before it is written into a staging directory. The staging directory is swapped into place only after every file passes, so a partial or tampered download is never usable.
* **Resolution order.** A bundled model (`.jarela-assets/local-embedding` next to the server) is used first, then the downloaded copy.
* **Non-blocking.** Embedding calls never wait for the download. When the model is absent, the first call starts one background download and throws a transient `LocalModelNotReadyError`. Embedding callers already treat transient errors as "retry later": chat recall degrades, and indexing and vector rebuilds retry on their next pass. After a failure, background callers wait 5 minutes before retrying. Re-selecting Jarela Local retries immediately.
* **Visibility.** The embeddings settings probe reports `downloading`, and the UI polls until the model is ready. When the download completes, the stale memory and chat vectors are rebuilt.
* **Offline installs.** `JARELA_BUNDLE_LOCAL_EMBEDDING=1` at build time makes postbuild verify (or fetch) the model and copy it into the standalone bundle. `JARELA_LOCAL_EMBEDDING_DOWNLOAD=0` at runtime forbids downloading. In that case the probe explains how to install the model (`npm run model:prepare` or an offline bundle).
* **Inference stays local.** Inference is unchanged from ADR-0093: Transformers.js loads from the resolved local path with remote model loading disabled.

The download is an explicit, user-initiated fetch of a pinned public artifact. It is not telemetry, and nothing runs unless Jarela Local is selected.

## Consequences

* Good, because default distributions shrink by about 136 MB each, and the release pipeline no longer depends on Hugging Face for bundle jobs. Only the npm smoke test needs the model, and it uses the cached copy.
* Good, because the download uses the same pinned, hash-verified assets as before, and builds no longer need network access to Hugging Face.
* Bad, because the first use of Jarela Local needs network access to `huggingface.co`. Until the download finishes, embeddings with Jarela Local are unavailable, and recall falls back to the non-semantic paths.
* Neutral, because air-gapped deployments keep the previous behaviour with `JARELA_BUNDLE_LOCAL_EMBEDDING=1`.
