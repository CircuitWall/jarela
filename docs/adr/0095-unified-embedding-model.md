---
status: accepted
date: 2026-10-08
---

# One embedding model for documents, memory, and conversation recall

## Context

[ADR-0093](0093-bundled-local-embeddings.md) kept the bundled local embedding model scoped to Documents and required memory and conversation-message vectors to keep using the app-wide provider selection. That left two embedding settings with the same purpose, and users who chose Jarela Local to keep text on-device still sent memory and chat text to a provider.

## Decision

There is one embedding selection, shown under Settings → Models. Documents, memory entries, and conversation messages are all embedded with it. When Jarela Local is selected, stored content uses the E5 `passage: ` side and recall queries use the `query: ` side; otherwise the configured provider is used as before.

The persisted keys are unchanged (`embedding_model_config` and `documents_use_bundled_local_embeddings`), so no migration is needed. One new settings key, `embedding_vectors_signature`, records which model (`provider:model_id`, or the bundled model id) the stored memory and message vectors belong to.

Memory and message vectors produced by a different model cannot be compared with new ones. They are rewritten in the background in small batches when either signal fires: the stored signature differs from the active model (this also catches two models with the same dimension), or a stored vector's length differs from the live query vector. On first run after upgrade the current signature is adopted without rewriting. A failed pass pauses for a minute and resumes where it stopped; progress and failures are shown in Settings → Models. Documents keep their explicit per-source Reindex flow from ADR-0093.

## Consequences

* Good, because choosing Jarela Local keeps documents, memory, and chat text on the device.
* Good, because there is a single setting and a single resolver (`resolveEmbeddingClient`) instead of two.
* Bad, because switching models triggers background re-embedding of all memory and message vectors, which uses CPU until it finishes; until then affected rows fall back to keyword overlap.
* Neutral, because document vectors are not covered by the signature and still rely on Reindex or the dimension-mismatch repair in document search.
