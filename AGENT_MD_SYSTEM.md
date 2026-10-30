# Agent.md Pattern System

**Purpose:** Single source of truth for module-specific implementation patterns  
**Scope:** All modules in Jarela repository  
**Audience:** Agents working in or modifying modules

---

## Overview

Each module has an `Agent.md` file that documents proven implementation patterns for that module. Agent.md files serve as the **canonical reference** for how to implement features in that module.

```
lib/agents/
├── Agent.md          ← Patterns for agent orchestration
├── run-thread.ts
├── base.ts
└── ...

lib/providers/
├── Agent.md          ← Patterns for LLM provider adapters
├── anthropic.ts
├── openai.ts
└── ...

lib/db/
├── Agent.md          ← Patterns for database operations
├── migrations.ts
├── transaction.ts
└── ...
```

---

## How Agents Use Agent.md

### When Implementing a Feature

1. **Identify the module** where feature belongs (e.g., `lib/agents/`)
2. **Load the Agent.md** file for that module
3. **Review relevant patterns** (usually 1-3 patterns apply)
4. **Copy pattern structure** and adapt to your implementation
5. **Follow anti-patterns** to avoid common mistakes
6. **Validate against testing requirements**
7. **Result:** Implementation aligned with module best practices

### When Reviewing Implementation

1. **Load the Agent.md** file for modified module
2. **Identify which pattern** was used
3. **Verify implementation** matches pattern structure
4. **Check anti-patterns** - ensure none are present
5. **Validate test requirements** met
6. **Result:** Systematic verification against standards

### When Updating Patterns

1. **Detect** pattern change (new approach emerging, drift observed, better way found)
2. **Validate** pattern reflects reality in codebase
3. **Update Agent.md** with new pattern information
4. **Include evidence** - link to code examples
5. **Document rationale** - why pattern is better
6. **Result:** Agent.md stays synchronized with actual implementations

---

## Agent.md Structure

Each Agent.md file contains these sections:

### Frontmatter
```yaml
---
description: Brief specialization description
tools: []
reasoning_effort: moderate
---
```

### Patterns (5+ core implementations)

Each pattern includes:
- **What:** Problem being solved
- **When:** Conditions and use cases
- **Example:** Working code agents can reference
- **Trade-offs:** Performance, complexity, maintenance

### Anti-Patterns (5+ common mistakes)

For each anti-pattern:
- ❌ **Wrong:** What NOT to do
- **Why:** Consequences and failures
- ✅ **Right:** Correct approach
- **Reference:** Link to correct pattern

### Testing Requirements

Defines test structure:
- Unit test patterns
- Integration test scenarios
- Edge cases to validate
- Performance expectations

### Pattern Notes

Implementation details:
- Subtle behaviors
- Common pitfalls
- Performance characteristics
- Maintenance considerations

### Frontier (Emerging patterns)

Patterns not yet standardized:
- **Pattern:** Description
- **Status:** Stability assessment
- **Examples:** Known implementations
- **Next:** Conditions for standardization

---

## Pattern Lifecycle

### Frontier Stage (Emerging)
- Observed in 1-2 implementations
- Behaviors may vary
- Not yet standardized
- Documented in Frontier section

### Candidate Stage (Consolidating)
- Multiple independent implementations found
- Behaviors converging
- Stable enough to standardize
- Move to numbered Pattern section

### Standard Stage (Established)
- Documented as numbered pattern
- Active best practice for module
- Reference in all new implementations
- Examples kept current

### Deprecated Stage (Superseded)
- Better pattern emerged
- Keep for reference only
- Mark as deprecated
- Suggest alternative pattern

---

## Continuous Pattern Monitoring

Agents maintain Agent.md accuracy through:

### During Code Implementation
- Scan for implementation patterns
- Compare against documented patterns
- Note deviations or new approaches
- Flag pattern drift immediately

### On Pattern Queries
- When agent needs pattern guidance
- Validate pattern still current
- Mark if pattern needs update
- Update references if changed

### On Dependency Changes
- Check API compatibility
- Validate pattern still works
- Update examples if needed
- Flag incompatibilities

### On Pattern Completion
- When code fully implements pattern
- Verify examples are current
- Confirm test requirements met
- Mark pattern as validated

---

## Cross-Module Pattern Coordination

When patterns span multiple modules:

```
Pattern change in lib/providers (error handling)
    ↓
Affects: lib/agents (error recovery patterns)
         lib/tools (error propagation)
         app/api (error response formatting)
    ↓
All affected Agent.md files updated together
```

---

## Validation Requirements

Agent.md files must maintain:

- **Accuracy:** Code examples match actual implementations
- **Completeness:** All patterns in module documented
- **Relevance:** Patterns reflect current best practices
- **Consistency:** No contradictions between patterns
- **Practicality:** Test requirements are achievable
- **Evidence:** Performance claims supported by code

---

## Updating Agent.md Files

### Detect Pattern Change

Pattern updates triggered by:
- New proven approach appearing repeatedly
- Existing pattern becoming less relevant
- Better technique discovered
- Dependency changes affecting implementation
- Module systematically drifting from patterns

### Validate Pattern

Before documenting:
- Collect evidence (code examples, test results)
- Verify approach works in multiple contexts
- Check performance and complexity
- Confirm backward compatibility or breaking change

### Update Documentation

1. Add pattern to appropriate section (Patterns or Frontier)
2. Provide working code example
3. Document when to use and trade-offs
4. Link to implementations in codebase
5. Update related anti-patterns if needed
6. Verify all cross-references still valid

### Document Change Rationale

Include in update:
- What changed and why
- When this became relevant
- Examples from codebase
- Impact on existing code
- Any backward compatibility notes

---

## Success Indicators

Healthy Agent.md files show:

✅ **Patterns match code** - Implementations follow documented approaches  
✅ **Anti-patterns prevent mistakes** - Agents avoid documented pitfalls  
✅ **Examples are current** - Code samples work with latest implementations  
✅ **Tests match requirements** - Testing strategies match patterns  
✅ **Cross-references valid** - All links resolve correctly  
✅ **Frontier patterns progress** - Emerging patterns move toward standardization  
✅ **No orphaned patterns** - All patterns actively used in codebase  

---

## Tier 1 Modules (Complete)

**[lib/agents/Agent.md](./lib/agents/Agent.md)**
- LangGraph agent orchestration patterns
- 5 patterns, 5 anti-patterns, testing guide

**[lib/providers/Agent.md](./lib/providers/Agent.md)**
- LLM provider adapter patterns
- 5 patterns, 5 anti-patterns, testing guide

**[lib/db/Agent.md](./lib/db/Agent.md)**
- SQLite persistence patterns
- 5 patterns, 5 anti-patterns, testing guide

**[app/api/Agent.md](./app/api/Agent.md)**
- Next.js API route patterns
- Pattern reference, testing guide

**[lib/tools/Agent.md](./lib/tools/Agent.md)**
- Agent tool implementation patterns
- Pattern reference, testing guide

---

## Tier 2 Modules (Ready)

**components/Agent.md** - React component patterns  
**hooks/Agent.md** - React hooks patterns  
**lib/stores/Agent.md** - State management patterns

---

## Tier 3 Modules (Ready)

**lib/mcp/Agent.md** - MCP integration patterns  
**scripts/Agent.md** - Automation patterns  
**tests/Agent.md** - Testing patterns

---

## Root Agent Guidance

**[AGENTS.md](./AGENTS.md)** - Project-level instructions
- Project stack and conventions
- Verified workflows (code-first principle)
- Contribution and release process
- Repository conventions
- Auto-loading explanation
- Pattern evolution process
- Auto-monitoring and maintenance

---

## Accessing Pattern Information

### Direct Reference
Agent auto-loads module's Agent.md based on file location:
- Edit `lib/agents/file.ts` → loads `lib/agents/Agent.md`
- Edit `lib/providers/file.ts` → loads `lib/providers/Agent.md`
- etc.

### Pattern Lookup
When implementing feature:
1. Identify module
2. Load that module's Agent.md
3. Find relevant pattern
4. Reference while implementing

### Cross-Module Patterns
When patterns span modules:
1. Identify primary module
2. Load that module's Agent.md
3. See Cross-Module coordination section
4. Load related modules' Agent.md files

---

## Maintenance Philosophy

**Agent.md files evolve continuously:**

- Patterns capture real implementations from codebase
- New patterns emerge when better approaches proven
- Anti-patterns prevent repeated mistakes
- Agent monitoring keeps patterns current
- Cross-module coordination prevents drift
- Frontier section tracks emerging approaches

**Result:** Agent.md files become increasingly valuable as codebase matures.

---

## Using This System

### For Feature Implementation
1. Load module's Agent.md
2. Review patterns (usually 1-3 apply)
3. Copy pattern template
4. Implement using pattern structure
5. Validate against testing requirements

### For Pattern Verification
1. Load module's Agent.md
2. Identify pattern used
3. Verify implementation matches
4. Check anti-patterns absent
5. Validate tests match requirements

### For Pattern Updates
1. Detect change needed
2. Validate against codebase
3. Update Agent.md
4. Include code examples
5. Document rationale

---

## Summary

Agent.md files are the **canonical reference** for module implementation patterns:

✅ **Auto-loaded** by directory (no manual setup)  
✅ **Pattern-based** (reference while implementing)  
✅ **Self-improving** (evolve with codebase)  
✅ **Evidence-backed** (grounded in actual code)  
✅ **Cross-module aware** (coordinate changes)  
✅ **Continuously validated** (stay current)  

Use these files as the foundation for all module implementations.
