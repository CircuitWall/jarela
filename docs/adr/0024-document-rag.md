# ADR-0024: Document RAG (folder watchers + semantic search)

Date: 2026-05-25
Status: Accepted

## Context

Jarela's agents have rich access to live data (the web, Atlassian, Jira
Align, GitHub, Gmail, Outlook, Calendar, MCP servers, …) but have no
durable awareness of the user's local text corpus — notes, README files,
project docs, configs, code. Today the only ways for an agent to read
those are:

1. The user pastes the text into the chat (small, one-shot).
2. `file_read` invoked by the agent with an exact path the user
   mentioned (no discovery; no "what do my notes say about X?").
3. Manual entries into the long-term memory store.

The product gap is **discovery + recall over arbitrary text the user has
on disk**. This ADR records the v1 design that closes it.

## Decision

Introduce a *Documents* surface: the user picks one or more folders;
Jarela scans them on a timer, chunks text files, embeds each chunk with
the configured embedding model, and exposes a `documents_search` tool
that agents call to recall passages by semantic similarity.

### Data model

Three new SQLite tables (ADR-0001 sqlite-backed storage):

- `document_sources(id, path, label, enabled, last_scan_at, last_error,
  created_at, updated_at)` — one row per folder the user added.
- `documents(id, source_id, path, rel_path, mtime_ms, size_bytes,
  content_hash, last_indexed_at, chunk_count)` — one row per text file
  currently indexed. `UNIQUE(source_id, path)`. `ON DELETE CASCADE` from
  `document_sources`.
- `document_chunks(id, document_id, chunk_index, text, start_offset,
  end_offset, embedding)` — paragraph-greedy chunks ≤ ~3200 chars
  (~800 tokens) with ~400-char overlap. `embedding` is JSON-encoded
  `number[]`, same shape as `memory_store.embedding` (ADR-0005). `ON
  DELETE CASCADE` from `documents`.

### Indexing loop

Reuses the existing scheduler tick (`lib/scheduler/index.ts`,
`POLL_INTERVAL_MS = 30_000`). Every 20 ticks (~10 minutes) the
scheduler calls `indexAllSources()` which for each enabled source:

1. `walk(root)` honoring an extension allowlist (markdown / text /
   common code / config files), a fixed dir denylist (`node_modules`,
   `.git`, `.next`, `dist`, `build`, `target`, …), a size cap
   (2 MB / file), and a hard ceiling (5 000 files / source).
2. Diffs against `documents.mtime_ms` + `size_bytes`. Files whose
   stats are unchanged are skipped without reading them — `stat()`
   is the only I/O on the happy path.
3. For changed files: read, run a binary-detect heuristic (>5%
   suspicious bytes in the first 4 KB ⇒ skip), hash the text; if
   content hash matches the prior version, just touch the row
   (defends against `touch foo.md` flapping the index).
4. Otherwise chunk + persist chunks first (no embedding), then call
   `embed(chunks.map(c => c.text))` in one batch and persist the
   resulting vectors. Embed failures are tolerated — the substring
   fallback in `searchDocuments` keeps the source useful.
5. Files removed on disk get their rows + chunks deleted via the
   `ON DELETE CASCADE` chain.

Per-tick file cap (`MAX_INDEX_PER_TICK_PER_SOURCE = 50`) ensures a
newly-added 5 000-file source doesn't block the scheduler for minutes.
Subsequent ticks pick up the rest. The `Reindex now` button bumps the
cap to 5 000 so an explicit user click is bounded but exhaustive.

### Search

`searchDocuments(query, { limit, sourceId? })`:

- Embed the query (`embedOne`), pull all chunks from enabled sources
  (capped at 20 000 rows per call as a defensive ceiling), score each
  with cosine, return top-k.
- For chunks without embeddings (no provider configured, or new
  chunks still waiting on the embed batch), fall back to substring
  / token-overlap scoring with a known-lower ceiling so embedded hits
  always sort first when both exist.

Exposed via the `documents_search` tool (category `Documents`) and the
`GET /api/v1/documents/search` endpoint (used by the panel's preview
input). A second tool, `documents_list_sources`, lets agents discover
available folders before scoping a search with `source_id`.

### UI

A new top-level `documents` tab under the Common section of the menu.
The panel lets the user:

- Add a folder by absolute path with an optional label.
- Toggle each source `enabled` / `disabled`.
- Reindex on demand.
- See per-source stats (`files`, `chunks`, `embedded`, `last scan`,
  last error).
- Run a quick preview search.

Deletes only remove the index entries — files on disk are untouched.

## Alternatives considered

### A. Continuous fs.watch instead of polling

Reactively pick up changes the moment a file lands on disk. Considered
and **deferred to PR-D**. The poll cost is bounded (one `stat()` per
file, every 10 minutes) and gives a single, simple scheduler entry
point — `fs.watch`'s reliability is OS-dependent (recursive watching is
not portable; the Linux inotify watch count is limited), so wiring it
in safely is a bigger lift than this PR warrants. Polling is the
forcing function that ships the rest of the feature today.

### B. Per-source include/exclude globs

Considered. v1 ships fixed defaults (extension allowlist + dir
denylist) because the right defaults cover ~90 % of usage and adding
glob configuration meant another row of UI + a non-obvious migration
path. The defaults are documented above and easy to widen later
without a schema change (`document_sources` already has spare columns
free to repurpose).

### C. PDF / docx / OCR ingestion

Out of scope for v1. Adding a binary-document pipeline doubles the
surface area (new optional deps, more failure modes, much higher
per-file cost). The extension allowlist excludes them on purpose;
follow-up PRs can add per-extension parsers as plug-ins.

### D. Store embeddings in `sqlite-vec` / DuckDB

Considered and rejected for the same reason as memory_store (ADR-0005):
at the scales we expect (tens of thousands of chunks per source), an
in-process cosine pass over `Float32Array`-equivalent JS arrays is
sub-second and avoids a new native dependency. Revisit if a single
user reports a corpus > 100 000 chunks.

### E. Per-agent source scoping

Considered. v1 makes sources installation-wide — every agent that
holds the `documents_search` tool sees every enabled source. The
mental model is "Jarela knows about these folders," not "agent X has
access to folder Y." Per-agent scoping is a real future ask but
needs a clear UX (where does the toggle live in the Agent editor?)
that hasn't surfaced yet.

## Trust model

`document_sources.path` is an absolute path supplied by the user via
the panel. The API route resolves the path with `path.resolve` and
verifies it exists + is a directory before creating the source row,
but does not blocklist directories. Users wanting to keep credential
directories out should not add them; the indexer also honors the
hidden-directory convention (dot-dirs are not descended).

Indexed chunks are *not* end-user-encrypted at rest — the same
trade-off as `messages` and `memory_store` plaintext rows (ADR-0005
encrypts only the sensitive-namespace subset). Don't add folders
containing secrets you wouldn't paste into the chat panel today.

## Consequences

- New table family + new scheduler workload — `~/.jarela/jarela.db`
  grows with text-corpus size, dominated by `document_chunks.text`
  and `embedding`. A 10 000-chunk corpus with 768-dim embeddings is
  ~30 MB, well within SQLite's comfort zone.
- The `documents_search` tool joins the agent toolbelt by default;
  agent configs that explicitly enumerate tools will need to opt in.
- A new `Documents` category appears in the Agent editor.
- PR-D upgrades the polling sweep to event-driven `fs.watch` so
  reindex latency for actively-edited files drops from minutes to
  ~seconds. PR-B/C extend the same diff-and-react primitive used
  here (`{previous, current, diff}`) to general "watcher" triggers
  for arbitrary tool output.
