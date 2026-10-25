---
status: "accepted"
date: 2026-10-25
---

# ADR-0109: Embedding provenance for document topic exclusions

## Context

Global topic exclusions compare topic vectors with stored document vectors.
Matching dimensions do not prove that two vectors belong to the same embedding
space. Changing models can otherwise silently defeat a user's exclusion.

## Decision

Add a nullable `embedding_model_signature` column to `document_chunks`, using
the signature already returned by the embedding pipeline. Persist each signature
with its vector, including backfills. Generate topic vectors with one resolved
query client and compare only chunks with that client's signature.

Existing chunks have unknown provenance. When topic exclusions are enabled,
unknown or incompatible provenance blocks assistant document search with an
actionable error until the source is reindexed. Searches without topic rules
retain their existing behavior. Exact document exclusions work without vectors.
The user-facing preview can explicitly bypass exclusions; the agent tool cannot.

## Validation

Migration tests exercise an existing database and repeat migrations. Retrieval
tests cover same-dimension model changes, unknown signatures, unavailable
vectors, exact exclusions, and the preview override. Indexer tests verify that
initial ingestion and backfill persist vector provenance.
