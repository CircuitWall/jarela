# Development journal

Free-form notes on what was built, why, what got tried, and what to revisit.
Lower bar than an ADR: no template, no review, no "decision" required — just
write things down so future-you (and any agents on the project) have context
that doesn't fit in a commit message or an ADR.

## Conventions

- One file per entry: `YYYY-MM-DD-short-slug.md`.
- Start with an H1 that matches the slug. Keep entries focused; split topics
  into separate entries rather than long mixed posts.
- Cross-link related ADRs (`../adr/000N-...md`) and commits when relevant.
- It is fine for an entry to age out — drop a "superseded by …" line at the
  top rather than rewriting history.

## When to write an ADR instead

If the entry is making (or recording) a decision that constrains future work —
e.g. picking a runtime, schema, or boundary — promote it to `docs/adr/` per
[ADR-0001](../adr/0001-record-architecture-decisions.md). The journal is for
narrative; ADRs are for commitments.
