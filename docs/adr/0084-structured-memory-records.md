---
status: accepted
date: 2026-09-07
deciders: Andrew Ge Wu, GitHub Copilot
informed: Jarela contributors
---

# Use Versioned Structured Records For Durable Memory

## Context and Problem Statement

Free-form memory values work for notes but make reliable proactive retrieval,
expiry, confidence, and consolidation difficult. Agents need a compact,
search-oriented structure that can evolve without breaking existing local
memory.

## Decision Drivers

* Preserve existing `memory_store` rows and APIs.
* Improve semantic retrieval without an additional database or process.
* Keep recall bounded and local-first.
* Make persistence and retrieval behavior understandable to agents and users.

## Considered Options

* Keep arbitrary string values only.
* Add relational metadata columns and migrate every memory row.
* Store a versioned JSON envelope in the existing value column.

## Decision Outcome

Chosen option: "Store a versioned JSON envelope in the existing value column",
because it provides typed durable records while preserving legacy values and
the existing SQLite primary key.

### Consequences

* Good, because `memory_upsert` validates kind, subject, tags, confidence,
  provenance, observed date, and expiry without a schema migration.
* Good, because embeddings use subject, tags, and content rather than JSON
  syntax; proactive recall omits expired records.
* Good, because the global important/balanced/detailed policy lets operators
  control recall breadth and agent memorization guidance.
* Bad, because legacy free-form entries have no confidence or expiry metadata.
  They remain available in balanced and detailed modes for compatibility.

## More Information

* `lib/memory/record.ts`
* `lib/tools/memory.ts`
* `lib/agents/run-thread.ts`