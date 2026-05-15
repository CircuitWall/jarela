---
status: accepted
date: 2026-05-15
deciders: Andrew Wu
---

# Record architecture decisions

## Context and Problem Statement

We need a lightweight, version-controlled way to capture significant architectural decisions so future maintainers (and Claude Code) understand *why* the system looks the way it does.

## Decision Drivers

* Decisions must live next to the code they constrain.
* Format must be Markdown-renderable on GitHub.
* Low ceremony — high signal.

## Considered Options

* MADR 4.0
* Nygard's original ADR template
* Confluence pages
* No formal record

## Decision Outcome

Chosen option: **MADR 4.0**, because it is the de-facto modern standard, has explicit fields for drivers/options/consequences, and renders cleanly on GitHub.

### Consequences

* Good — every non-trivial choice has a discoverable rationale.
* Good — Claude Code reads `docs/adr/` as part of its day-to-day decision loop.
* Bad — minor overhead per decision; mitigated by keeping ADRs short.

## More Information

* MADR: https://adr.github.io/madr/
* Triggers and workflow: see global `~/.claude/CLAUDE.md` § Architecture Decision Records.
