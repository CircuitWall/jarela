# Agent.md Pattern System - Quick Reference

## Core Concepts

**Auto-loading**
```text
Edit lib/agents/file.ts  → AGENTS.md + lib/agents/Agent.md load
Edit lib/db/file.ts      → AGENTS.md + lib/db/Agent.md load
```

**Required guide sections**
- Frontmatter: `description: Use when: …`, `tools`, `reasoning-effort`
- Scope and contracts: ownership, boundaries, canonical files, patterns
- Anti-patterns: at least five module-specific failure modes
- File map: where the owning implementation and tests live
- Testing requirements: unit, integration, edge cases
- Review checks: 5-10 evidence-based checkboxes

Optional: **Frontier** (emerging patterns) and **Pattern Notes**.

---

## Implementation Workflow

1. **Load the owning Agent.md**
   - Auto-loads when editing that module
   - Read its patterns, anti-patterns, and boundaries

2. **Implement using the guide**
   - Reuse the canonical files and patterns
   - Avoid documented anti-patterns
   - Meet the testing requirements

3. **Validate**
   - `npm run review:module -- --staged`
   - `npm run check:impact -- --staged`
   - `npm run lint`

4. **Resolve drift**
   - Code is authoritative for what happens; the guide is authoritative for
     what should happen.
   - Fix the authoritative side and both in the same change.

---

## Module Organization

**Tier 1 (Core Infrastructure)**
- [lib/agents/Agent.md](lib/agents/Agent.md) - LangGraph orchestration
- [lib/providers/Agent.md](lib/providers/Agent.md) - LLM provider adapters
- [lib/db/Agent.md](lib/db/Agent.md) - SQLite persistence
- [app/api/Agent.md](app/api/Agent.md) - API routes
- [lib/tools/Agent.md](lib/tools/Agent.md) - Tool implementations

**Tier 2 (Components & State)**
- [components/Agent.md](components/Agent.md) - React components
- [hooks/Agent.md](hooks/Agent.md) - React hooks
- [lib/stores/Agent.md](lib/stores/Agent.md) - State management

**Tier 3 (Integration & Testing)**
- [lib/mcp/Agent.md](lib/mcp/Agent.md) - MCP integration
- [scripts/Agent.md](scripts/Agent.md) - Automation
- [tests/Agent.md](tests/Agent.md) - Testing patterns

---

## Key Files

- [AGENTS.md](AGENTS.md) - Root instructions and module index
- [AGENT_MD_SYSTEM.md](AGENT_MD_SYSTEM.md) - Pattern system, drift, and audit rules
- Module `Agent.md` files - Canonical module contracts
- [CONTRIBUTING.md](CONTRIBUTING.md) - Contribution workflow

---

## Drift Monitoring

Automatic:
- `npm run lint` verifies guide frontmatter, links, paths, module coverage, and
  the Review checks section.
- `npm run review:module -- --staged` maps changed files to the owning guide,
  prints its review checks, and runs mechanical module invariants.
- `npm run check:impact -- --staged` lists affected modules.

Not automatic:
- Semantic drift requires an explicit audit. A fresh subagent must be told to
  read `AGENTS.md` and the owning guide first.
- Each finding needs the guide claim, file and line, and test/command evidence.
  See [Pattern Drift](AGENT_MD_SYSTEM.md#pattern-drift-detection-and-authority).

---

## Success Indicators

✅ Patterns and contracts match real implementations
✅ Anti-patterns prevent repeated mistakes
✅ Review checks are current and evidence-based
✅ Examples compile and named tests exist
✅ Cross-references resolve
✅ No orphaned or stale guides
