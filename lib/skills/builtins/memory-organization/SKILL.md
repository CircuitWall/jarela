# Memory Organization

Use this skill when the user asks to remember information, retrieve prior
context, clean up accumulated memory, or tune how proactively Jarela remembers.

## Standard Record

Use `memory_upsert` for durable knowledge. Store it under namespace `facts`
with a stable, descriptive key. Every record follows this shape:

```json
{
  "version": 1,
  "kind": "preference | fact | decision | constraint | project_context | contact | task",
  "subject": "short entity or topic name",
  "content": "concise standalone statement",
  "tags": ["search", "labels"],
  "confidence": "explicit | inferred | verified",
  "source": "conversation | tool_result | user_profile | import",
  "observed_at": "RFC 3339 timestamp or null",
  "expires_at": "RFC 3339 timestamp or null"
}
```

Use `confidence="explicit"` for user-stated preferences, `verified` for tool
or source-backed facts, and `inferred` only when the inference is useful and
clearly reversible. Set `observed_at` when the fact became true; set
`expires_at` for temporary status, deadlines, or access details. Never store
secrets, access tokens, passwords, or raw private transcripts.

## Retrieval And Consolidation

1. Let proactive recall supply matching facts on normal user turns. Use
   `memory_read` for an exact key and `memory_list` for inspection or keyword
   lookup.
2. Before adding a record, inspect matching `facts` entries. Update the stable
   key instead of creating duplicates or contradictory copies.
3. When memories overlap, keep the newest verified or explicit record; merge
   non-conflicting tags and remove superseded entries with `memory_delete`.
4. Keep `content` independently understandable. Put searchable nouns in
   `subject` and `tags`, not only in prose.
5. Do not turn every chat message into memory. Store information only when it
   will help a later conversation, task, or decision.

## Proactivity Policy

The Memory panel controls the global policy:

- `important`: retrieve and save only explicit or verified preferences, facts,
  decisions, constraints, and project context. Excludes inferred details,
  contacts, and tasks from proactive recall.
- `balanced`: default. Keeps durable preferences, facts, decisions,
  constraints, and useful cross-session task context.
- `detailed`: retrieve a broader set of active records and preserve relevant
  recurring workflow/task detail. Still avoid secrets, duplicates, and raw
  transcripts.

When the user asks to change this policy, explain the retrieval/noise tradeoff
and direct them to the Memory panel. Do not silently change a persistent
memory policy.