---
status: "accepted"
date: 2026-05-26
deciders: andwu
---

# ADR-0026: Remote document-RAG sources (Jira + Confluence)

## Context and Problem Statement

ADR-0024 introduced document RAG for **local folders only** — the user
points at a directory, the indexer walks the filesystem, chunks the text
files, embeds them, and exposes recall via `documents_search`. The same
shape of "scoped, incremental, semantic retrieval" is exactly what the
agent needs for Atlassian content (Jira issues, Confluence pages), but
indexing everything in a tenant is undesirable: context budgets are
finite, embedding cost is non-trivial, and most users only care about a
few projects / spaces.

How do we add Jira + Confluence to document RAG without (a) building a
parallel sources/chunks/search stack, (b) forcing the user to index all
of Atlassian, or (c) blowing up the chat context window with low-quality
retrievals?

## Decision Drivers

* **No parallel stack.** ADR-0024 already owns sources, documents,
  chunks, embeddings, and the scheduler sweep. A second module duplicating
  that shape is a maintenance burden.
* **Smart, scoped indexing.** The user must be able to say "only this
  Confluence space" or "only tickets matching this JQL" rather than
  ingesting everything.
* **Incremental syncs.** A nightly re-fetch of every page/issue is
  wasteful — sync only what changed since last run.
* **Single retrieval surface.** Agents already call `documents_search`
  for local content; they shouldn't need a separate tool for Atlassian.
* **Single-process invariant** (ADR-0011) — no new daemon.

## Considered Options

* **A. New parallel `lib/rag/` module + tools (`rag_*`).** Self-contained:
  own schema, own chunker (FTS5 + cosine + RRF), own indexer, own auto-inject.
  Pros: independent tuning. Cons: two RAG stacks, two stores, two tool
  vocabularies — directly contradicts CLAUDE.md ("avoid one-off features;
  if it doesn't fit, fix the structure").
* **B. Extend `lib/documents/` with a per-kind discriminator.** Add
  `kind` + `config` + `last_cursor` columns to `document_sources`. Local
  folders stay `kind = 'local_folder'`. New kinds (`confluence_space`,
  `confluence_cql`, `jira_project`, `jira_jql`, `on_demand_url`) dispatch
  to per-kind indexers under `lib/documents/remote/` that flatten content
  to plain text and reuse the existing `chunkText` + `documents` +
  `document_chunks` tables. Search is unchanged.
* **C. Build a new MCP server.** Out of process; clean boundary. But the
  user explicitly excluded a second process (ADR-0011), and an MCP server
  for what is effectively "fetch + chunk + cache" is over-engineering.

## Decision Outcome

Chosen option: **B**. Reuses ADR-0024's storage + retrieval surface
completely; remote-specific concerns (ADF/HTML flattening, REST
pagination, incremental cursors) live in a thin `lib/documents/remote/`
sub-module. Agents see one tool family (`documents_*`) and one stats
view; the Documents panel will surface remote sources next to local
folders with the same affordances.

### Data model

Three columns added to `document_sources` (idempotent ALTERs in
`ensureDocumentSourceRemoteColumns`):

* `kind TEXT NOT NULL DEFAULT 'local_folder'` — discriminator.
* `config TEXT` — JSON blob, per-kind shape:
  * `confluence_space`: `{space_key, recency_days?}`
  * `confluence_cql`: `{cql, recency_days?}`
  * `jira_project`: `{project_key, recency_days?}`
  * `jira_jql`: `{jql, recency_days?}`
  * `on_demand_url`: `null` (singleton row)
* `last_cursor TEXT` — incremental watermark (max upstream `updated`
  ISO timestamp seen so far).

The `documents` row shape is unchanged. For remote sources:

* `path` is a synthetic URI (`jira://ABC-123`, `confluence://12345`,
  `confluence-space://ENG`, …) so the existing `UNIQUE(source_id, path)`
  constraint provides natural deduplication.
* `rel_path` carries the human-readable title (Jira `KEY: Summary`,
  Confluence page title) so the search UI shows useful labels.
* `mtime_ms` stores the parsed upstream `updated` timestamp as ms; the
  column re-purposes cleanly because nothing outside the local indexer
  treats it as a filesystem mtime.
* `content_hash` is SHA-256 of the flattened plain text, so a no-op
  upstream re-publish (touch a page, save with no changes) doesn't
  trigger re-chunking + re-embedding.

### Chunking

`lib/documents/chunker.ts` (paragraph-greedy, ≤3200 chars, 400-char
overlap) is reused unchanged. Remote content is **flattened to plain
text first** by `lib/documents/remote/flatten.ts`:

* **Jira (ADF):** walk the JSON tree, keep `text` nodes, insert blank
  lines on block boundaries (`paragraph`, `heading`, `listItem`,
  `codeBlock`, `blockquote`, `panel`). Drops marks, mentions, embedded
  Smart Links, attachments.
* **Confluence (storage-format HTML):** drop `<script>`/`<style>`,
  collapse common block closes to `\n`, strip remaining tags, decode the
  handful of entities Atlassian emits.

Both flatteners are intentionally lossy — "good enough for retrieval",
not "round-trips to source". Each Jira issue becomes one document
(summary + URL + description + chronological comments); each Confluence
page becomes one document (title + body).

### Indexing loop

`indexAllSources()` already iterates enabled sources every 20 scheduler
ticks (~10 min). The dispatch is extended:

```
if (isRemoteKind(source.kind)) runRemoteSource(source)
else                            indexSource(source)
```

`runRemoteSource` switches on `kind`:

* `confluence_space` / `confluence_cql` → `runConfluenceIndexer`:
  builds CQL with `type = page` + the configured scope + a
  `lastmodified > "<since>"` watermark, paginates via
  `/wiki/rest/api/content/search?cql=...&start=N`, caps at 200 pages /
  run.
* `jira_project` / `jira_jql` → `runJiraIndexer`: builds JQL with the
  configured scope + an `updated > "<since>"` watermark and a
  monotonic `ORDER BY updated ASC` (so partial runs still advance the
  cursor safely), paginates via `/rest/api/3/search/jql` with
  `nextPageToken`, caps at 500 issues / run.
* `on_demand_url` → no-op in the sweep; populated only via
  `documents_index_url` (one issue / page at a time).

Per-source caps + Atlassian's REST rate limit interactions are why we
keep this single-process: tighter feedback than queueing through a
worker.

### Retrieval

`searchDocuments` is **unchanged**. Same cosine-with-substring-fallback
JOIN across `document_chunks → documents → document_sources`. Hits
from remote sources appear in the same ranking as local hits; the
caller can pass `source_id` to scope. The `documents_search` tool
description is unchanged because its semantics didn't change.

### Tool surface

Added to the existing `Documents` category:

* `documents_add_remote_source(kind, label, config)`
* `documents_remove_source(source_id, confirm)`
* `documents_reindex_source(source_id)` — force an immediate sync
* `documents_index_url(input)` — bare key / browse URL / wiki URL

`documents_search` and `documents_list_sources` already cover the
remote sources without modification.

### HTTP surface

* `POST /api/v1/documents/sources` accepts either `{path, label?}`
  (local) or `{kind, label, config}` (remote). 409 on duplicate
  synthetic path.
* `POST /api/v1/documents/sources/{id}/reindex` was already a local-only
  endpoint; extended to dispatch through `runRemoteSource` when `kind`
  is non-local.

### Auto-inject (deferred)

ADR-0024 ships without auto-inject — the agent calls `documents_search`
explicitly. We follow the same model here for consistency. A future ADR
will decide whether to auto-inject the top N chunks per turn under a
token budget, and that decision will apply to **all** document sources
(local + remote), not just Atlassian.

## Trust model

* Atlassian credentials reused as-is — env-first
  (`ATLASSIAN_URL`/`EMAIL`/`API_TOKEN`), then the encrypted
  integrations row (`getIntegrationRaw("atlassian")`). No new secret
  storage.
* Indexed text is **not** encrypted at rest; same trade-off as ADR-0024
  for local content. Restricted Jira issues / Confluence pages should
  be excluded at the JQL / CQL level by the user.
* `recency_days` config caps how far back the indexer looks, both
  shrinking the corpus and bounding the blast radius of a misconfigured
  scope.

## Consequences

* `document_sources` gains three columns; existing rows are
  back-compatible (`kind` defaults to `local_folder`, `config` and
  `last_cursor` are nullable).
* `lib/documents/remote/` is a new sub-module; no other module learns
  about Atlassian REST shapes — the `_atlassianFetch` accessor in
  `lib/tools/atlassian.ts` is the single ingress.
* The scheduler sweep already runs `indexAllSources` every ~10 min; no
  scheduler changes. Remote sources just appear in that loop.
* The Documents panel UI continues to work for local sources without
  changes; a follow-up PR will add the "Add remote source" affordance.

## Out of scope (v1)

* Per-agent source scoping (same deferral as ADR-0024).
* Auto-inject into the agent's system prompt (deferred to a separate
  cross-cutting ADR).
* PDF / image / OCR ingestion.
* Per-source manual deletion of stale documents (the indexer never
  evicts on remote runs — restricted/deleted upstream items linger
  until a full re-sync, which v1 doesn't offer; users wanting a clean
  slate can delete + re-create the source).
