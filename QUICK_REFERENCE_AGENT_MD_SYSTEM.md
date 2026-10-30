# Agent.md Pattern System - Quick Reference

## Core Concepts

**Auto-Loading**
```
Open lib/agents/file.ts  → AGENTS.md + lib/agents/Agent.md load
Edit lib/db/file.ts      → AGENTS.md + lib/db/Agent.md load
etc.
```

**Pattern Structure**
- Patterns: 5+ proven implementations with examples
- Anti-Patterns: 5+ mistakes to avoid
- Testing: Test requirements for pattern
- Frontier: Emerging patterns under observation

**Pattern Lifecycle**
```
Frontier (emerging) → Candidate (consolidating) → Standard (established)
```

---

## Implementation Workflow

1. **Load module's Agent.md**
   - Auto-loads when editing module files
   - Contains patterns for that module

2. **Reference relevant pattern**
   - Usually 1-3 patterns apply to feature
   - Review examples and structure

3. **Implement using pattern**
   - Follow documented structure
   - Avoid anti-patterns
   - Meet testing requirements

4. **Validate implementation**
   - Pattern correctly applied
   - Tests match requirements
   - Cross-module patterns coordinated

---

## Module Organization

**Tier 1 (Core Infrastructure)**
- lib/agents/Agent.md - LangGraph orchestration
- lib/providers/Agent.md - LLM provider adapters  
- lib/db/Agent.md - SQLite persistence
- app/api/Agent.md - API routes
- lib/tools/Agent.md - Tool implementations

**Tier 2 (Components & State)**
- components/Agent.md - React components
- hooks/Agent.md - React hooks
- lib/stores/Agent.md - State management

**Tier 3 (Integration & Testing)**
- lib/mcp/Agent.md - MCP integration
- scripts/Agent.md - Automation
- tests/Agent.md - Testing patterns

---

## Key Files

- **[AGENTS.md](./AGENTS.md)** - Root hub and project context
- **[AGENT_MD_SYSTEM.md](./AGENT_MD_SYSTEM.md)** - Pattern system guide
- **Module Agent.md files** - Specific pattern documentation
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** - Contribution workflow

---

## Pattern Monitoring

Agents continuously ensure patterns stay current:

- **Pattern Drift Detection** - Code diverging from pattern
- **New Pattern Emergence** - Same approach repeated
- **Anti-Pattern Recurrence** - Mistakes repeating
- **Dependency Changes** - APIs affecting patterns
- **Coverage Analysis** - Patterns matching reality

Result: Agent.md files improve continuously.

---

## Cross-Module Coordination

When patterns span modules:

```
lib/providers pattern change (error handling)
    ↓
Triggers updates: lib/agents, lib/tools, app/api
    ↓
All affected Agent.md files updated together
```

---

## Success Indicators

✅ Patterns match code implementations  
✅ Anti-patterns prevent mistakes  
✅ Examples are current and work  
✅ Tests match pattern requirements  
✅ All cross-references valid  
✅ Frontier patterns progress toward standard  
✅ No orphaned patterns  

---

## System Philosophy

Agent.md files are **canonical references** for module patterns:

- Pattern-based implementation
- Continuous validation
- Evidence-backed approaches
- Cross-module aware
- Evolutionary improvement

Use these files as foundation for all implementations.
