---
status: "accepted"
date: 2026-10-23
deciders: Jarela maintainers
---

# Persist bounded workspace tree scans

## Context and Problem Statement

`workspace_init` walks a bounded directory tree whenever an agent enters a workspace, even when the same root and scan options were just used. The repeated traversal is slow on large or cloud-synced workspaces. Persisting the complete context bundle would retain README text, package scripts, and live git state beyond the turn that requested them.

## Decision Drivers

* Reuse the expensive bounded tree scan when the same workspace is reopened soon.
* Make cache age visible and provide an explicit fresh-scan escape hatch.
* Keep transient or user-authored content out of the persistent cache where possible.
* Preserve fresh git status and other inexpensive metadata on every initialization.

## Considered Options

* Cache the full workspace context bundle.
* Persist only the bounded tree scan in the existing SQLite data directory.
* Keep a process-local in-memory cache.

## Decision Outcome

Chosen option: "Persist only the bounded tree scan in SQLite", because it survives process restarts while avoiding persistence of README contents, package scripts, and live git state.

The cache key is a SHA-256 digest of the normalized workspace path and tree-entry cap. Cache entries contain only the tree rows, the truncation flag, and the scan timestamp. Entries are reused for at most 15 minutes; `workspace_init` accepts `refresh_scan: true` to bypass reuse. Git status, README, manifests, and other project metadata are reprobed on every call. Expired entries are removed during cache writes.

### Consequences

* Good, because reopening the same workspace can skip the recursive tree walk and reports when that tree was scanned.
* Good, because the persistent cache does not store README text, package scripts, or git status.
* Bad, because tree changes can remain absent from a reused scan for up to 15 minutes; callers can force a refresh.
* Bad, because the database gains a small cache table and its migration/store tests.

## Pros and Cons of the Options

### Cache the full workspace context bundle

* Good, because it avoids nearly all initialization probes.
* Bad, because it persists user-authored README/script content and stale git state.

### Persist only the bounded tree scan in SQLite

* Good, because the expensive traversal is skipped without persisting unrelated context.
* Bad, because cheap metadata still needs to be probed on each initialization.

### Keep a process-local in-memory cache

* Good, because it requires no migration.
* Bad, because it is lost on restart and does not satisfy persistent reuse.

## More Information

* Related: ADR-0003 (SQLite local persistence).
