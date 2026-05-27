---
status: "proposed"
date: 2026-05-27
deciders: andwu
---

# ADR-0029: GitHub remote document-RAG source

## Context and Problem Statement

ADR-0026 introduced remote document sources for Jira and Confluence
under `lib/documents/remote/` so the agent's `documents_search` covers
Atlassian content alongside local folders. The same retrieval surface
should cover GitHub: PR descriptions + reviews are where most code-change
context lives, and repos increasingly hold canonical product docs in
`/docs` and READMEs that beat the corresponding wiki pages. ADR-0028's
expanded native GitHub tool surface (PR write/merge/review, code search,
file fetch) closes the *active* read-write loop, but it doesn't make a
PR's content searchable after-the-fact via embeddings.

How do we add GitHub repos to document RAG without (a) duplicating the
sources/chunks/search stack, (b) forcing the user to embed every commit
or every diff, or (c) forking ADR-0026's per-kind handler model that
already works for Atlassian?

## Decision Drivers

* **Reuse ADR-0026's shape.** A GitHub indexer should plug into the same
  `runRemoteSource(kind)` switch + `upsertRemoteDocument` upsert path,
  not invent a parallel pipeline.
* **Bounded scope per source.** "All issues across all repos" is not
  useful — context budgets and embedding cost both balloon. Sources are
  scoped to one repo, with a recency window and an optional path
  prefix for the file-walking kind.
* **Incremental syncs.** Same as ADR-0026: each source carries a
  watermark so a sweep only re-fetches what changed since last run.
* **No new credentials.** Reuse the GitHub PAT the user already
  configures via `Connections → GitHub` (env `GITHUB_TOKEN`/`GH_TOKEN`
  or the encrypted integrations row).
* **Single-process invariant** (ADR-0011) — no new daemon, no new
  background queue.

## Considered Options

* **A. Index every PR + every issue + every file across the whole
  account.** Would maximise recall but explodes embedding cost and
  invariably surfaces irrelevant content; rejected by the same logic
  ADR-0026 used to reject "index all of Confluence".
* **B. Add per-repo kinds: `github_pulls` (PRs+comments+reviews of
  one repo) and `github_repo` (text files on the default branch
  of one repo, walked via the Trees API).** Mirrors `jira_project` /
  `confluence_space`. Bounded by repo + recency + path prefix.
* **C. Lean exclusively on the on-demand URL flow** (`indexOnDemand`):
  user / agent indexes one PR or file at a time when they reference it.
  Works for ad-hoc Q&A, fails when the agent doesn't yet know which PR
  is relevant ("did anyone touch the auth middleware in the last
  month?"). The bulk indexer fills that gap.

## Decision Outcome

Chosen option: **B**, complemented by **C**. Two new bulk kinds
(`github_pulls`, `github_repo`) plus extended on-demand URL recognition
for `https://github.com/o/r/pull/N`, `/issues/N`, and
`/blob/<ref>/<path>` URLs.

The `github_issues` kind that would mirror `jira_project` for the
issue-tracker side is deferred. Most users either run their issues in
GitHub (and these would be additive to `github_pulls`) or in Jira
(where ADR-0026 already covers them); building it now adds another
schema variant for marginal coverage. We can add it as a follow-up
once `github_pulls` is in production and we know whether users actually
miss it.

### Data model

No schema change. ADR-0026's three columns on `document_sources`
(`kind`, `config`, `last_cursor`) cover everything. Two new values for
the `kind` discriminator:

* `github_pulls` — config `{ owner, repo, recency_days?, state? }`. `state`
  is `open | closed | all`, default `all`. Synthetic path
  `github-pulls://<owner>/<repo>`. Cursor is the max upstream
  `updated_at` ISO seen so far.
* `github_repo` — config `{ owner, repo, ref?, path_prefix? }`.
  `ref` defaults to the repo's default branch. `path_prefix` constrains
  the walk (e.g. `docs/`) so a single repo can be split into multiple
  scoped sources. Synthetic path `github-repo://<owner>/<repo>`. Cursor
  is the SHA of the tree last walked — a no-op sweep returns early when
  the head SHA matches.

Per-document `path`s mirror the Jira / Confluence pattern:

* PR body+comments → `github-pull://<owner>/<repo>/<number>`
* Issue (on-demand only) → `github-issue://<owner>/<repo>/<number>`
* Repo file → `github-file://<owner>/<repo>@<ref>/<rel-path>`

`rel_path` carries the human-readable label (`PR #123: title` or the
relative file path). `mtime_ms` re-purposes to the upstream
`updated_at` timestamp parsed via `Date.parse`. `content_hash` is
SHA-256 of the flattened text — a touch-without-content-change is a
no-op.

### Indexing loop

`indexAllSources` already iterates enabled sources. The dispatcher in
`lib/documents/remote/index.ts` switches on `source.kind` and gets two
new cases delegating to `runGithubIndexer` from
`lib/documents/remote/github.ts`. That handler:

* For `github_pulls`: paginates `GET /repos/{owner}/{repo}/pulls?state=…&sort=updated&direction=desc`,
  caps at 200 PRs / run, fetches `/issues/{n}/comments` + `/pulls/{n}/reviews`
  for each new-or-updated PR, flattens to one document.
* For `github_repo`: `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1`,
  walks tree blobs whose path matches the existing local-folder
  extension allowlist (re-imported from `indexer.ts` so the two
  surfaces stay in sync), `GET /repos/.../contents/{path}?ref=<ref>`
  for each, decodes base64, skips binaries via the same
  `isLikelyBinary` heuristic.

Both run through the existing `upsertRemoteDocument` so chunking,
embedding, and embed-failure surfacing are inherited.

### On-demand URL extension

`indexOnDemand(input)` already recognises Jira issue keys, Jira browse
URLs, and Confluence page URLs. We add three GitHub matchers, all
going through the shared `on_demand_url` source row:

* `/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/`
* `/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/`
* `/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/`

Each delegates to a one-shot helper in `lib/documents/remote/github.ts`
that reuses the same flattening and `upsertRemoteDocument` path as the
bulk indexer.

### Tool surface

`documents_add_remote_source` accepts the two new kinds. No new tool
names. Repurposes the existing `documents_index_url` for the on-demand
flow; the description gets one extra example for GitHub.

### HTTP & ingress

The existing GitHub auth resolver (`_resolveGithubAuth` in
`lib/tools/github.ts`) is the single ingress for credentials. We
export a thin `_ghFetch(auth, path, init?)` so the document indexer
can reuse the same `Authorization` + `User-Agent` + version-pin
plumbing without copy-pasting it. Same pattern as
`_atlassianFetch` in ADR-0026.

## Trust model

* GitHub PAT scopes: same as ADR-0028 — `repo` (or `public_repo`),
  `read:org` for org repos. No extra scopes needed for the indexing
  paths because every endpoint we hit is already covered.
* Indexed text is **not** encrypted at rest; same trade-off as
  ADR-0024 / ADR-0026. Restricted private repos must not be indexed if
  the user can't accept that.
* Per-source `recency_days` (for `github_pulls`) caps how far back the
  PR history sweep looks; `path_prefix` (for `github_repo`) caps the
  blast radius of accidentally pointing the indexer at a giant repo.

## Consequences

* `lib/documents/remote/github.ts` is a new module. No other module
  learns about GitHub REST shapes — `lib/tools/github.ts` remains the
  single ingress.
* The Documents panel grows two more `<select>` options + a small form
  for `{owner, repo, …}`. UX is parallel to the existing Jira/Confluence
  forms.
* Extension allowlist (`ALLOWED_EXT`) is now imported by remote
  indexers, not just the local walker. Adding a new extension benefits
  both.
* `documents_search` retrieval is unchanged — GitHub hits show up in
  the same ranked results as Jira / Confluence / local files.

## Out of scope (v1)

* `github_issues` (bulk issue indexer). Deferred until usage shows it's
  needed beyond what `github_pulls` + on-demand cover.
* PR diffs / patches. We index the human-written content (titles,
  bodies, review prose); patches are too noisy for embeddings without
  bigger investment. Use `github_list_pull_files` (ADR-0028) for
  patch-level retrieval.
* GitHub Discussions, Wikis, Releases. Same logic — not enough demand
  to justify v1.
* Per-agent source scoping (deferred at the documents layer, ADR-0024).
