---
status: accepted
date: 2026-10-07
---

# Bundle a local document embedding model

## Context

Local-folder RAG currently resolves embeddings through configured providers. Users need an option that keeps document and query text inside Jarela, works without a separate model server, and is present in the installed distribution rather than downloaded at first use.

## Decision

Ship the quantized `Xenova/all-MiniLM-L6-v2` ONNX model with Jarela and run it through Transformers.js in the existing Node process. The model is English-focused, emits 384-dimensional vectors, and its upstream model card declares Apache-2.0. Pin the upstream revision and verify each model/tokenizer asset before packaging. Keep generated assets under the ignored `.jarela-assets/` directory; do not commit model binaries. The normal build prepares the assets, and postbuild copies them into `.next/standalone/` so npm, portable/native archives, and Docker inherit the same bundle.

Set Transformers.js to use the local model path and disable remote model loading. No Python process, Ollama service, or network request is used for inference. The Node package uses ONNX Runtime's in-process Node binding.

Expose the bundled model as an explicit Documents embedding selection. Keep `Auto` and existing provider selection precedence unchanged. Split long inputs into overlapping tokenizer windows before inference and average window vectors into one normalized vector per indexed chunk.

Store this Documents-only choice separately from the existing app-wide embedding model setting. Selecting Jarela Local must not change the embedding backend used for memory or conversation-message vectors.

Changing the selected embedding model does not trigger an automatic full-corpus rescan. The user can run Reindex on each local-folder source; that action force-rebuilds vectors even when file contents and timestamps are unchanged. Filesystem watchers remain content-change triggers, not model-change triggers. Background sweeps continue to backfill chunks whose embeddings are null.

## Consequences

* Good, because local embeddings need no configured provider key or external inference service.
* Good, because source checkouts and published distributions obtain the same pinned model artifacts and verify their hashes.
* Bad, because the bundled model adds about 23 MB of weights plus tokenizer/runtime files to each distribution, and a clean build needs access to the pinned public model artifacts.
* Bad, because the default bundled model is English-focused and smaller than current hosted embedding models; users can still choose a configured provider model instead.
* Neutral, because changing embedding models remains an explicit source-by-source reindex operation to avoid unexpectedly reprocessing large corpora.
