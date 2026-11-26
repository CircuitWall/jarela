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

Each module guide is opinionated about its own domain. The required sections
are:

### Frontmatter
```yaml
---
description: Use when: implementing, fixing, or testing <module scope>
tools: [read, edit, search, execute]
reasoning-effort: high
---
```

The structural checker enforces this contract: `description` must start with
`Use when:`, `tools` must be a non-empty list, and `reasoning-effort` must be
`low`, `medium`, or `high`. Copy the shape from an existing guide rather than
the prose above.

### Scope and contracts

State what the module owns, what it must not reach into, and its canonical
files. Document the module's canonical patterns or contract sections — most
guides have five or more substantive entries. Each entry states what it covers,
when it applies, and where the canonical implementation or test lives; working
code is optional.

### Anti-patterns (5+)

At least five module-specific failure modes. Prefer concise Wrong/Why/Fix
bullets; code examples are optional. Link to the correct pattern or canonical
file.

### File map

A table of canonical files or file groups so agents can find the owning
implementation and tests.

### Testing Requirements

Defines test structure:
- Unit test patterns
- Integration test scenarios
- Edge cases to validate
- Performance expectations

### Review checks (required)

Every module guide has a `## Review checks` section with 5-10 checkboxes. Each
item states a review obligation that can be verified with evidence: a file and
line, a test, or a named command. Separate automated checks from judgment calls.

`scripts/check-agent-docs.mjs` requires the heading, and
`node scripts/check-module-review.mjs --staged` prints the section for every
touched module while running the mechanical checks.

### Optional sections

- **Frontier** — emerging patterns not yet standardized; use it only when the
  module has candidates.
- **Pattern Notes** — implementation details not already captured above.

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

## Pattern Drift: Detection and Authority

Drift is any mismatch between a guide and the code, tests, or architecture it
governs. Some drift is caught mechanically; the rest requires an explicit audit.

### What is automatic

- `npm run lint` runs `node scripts/check-agent-docs.mjs`, which catches missing
  guides, bad frontmatter, broken links, missing inline paths, and undeclared
  module guides.
- `node scripts/check-change-impact.mjs --staged` maps changed module files to
  follow-up checks, including updating the owning guide.
- `node scripts/check-module-review.mjs --staged` prints the touched guides'
  Review checks and runs the mechanical module invariants. It does not verify
  the manual checklist items.
- Module boundaries are declared in `GUIDES` in
  [`scripts/check-agent-docs.mjs`](./scripts/check-agent-docs.mjs) and in each
  guide. Intentional architecture changes update both in the same PR (plus an
  ADR when a boundary moves). Review checks are extracted from the guide, so the
  gate does not encode a second architecture.
- Domain gates catch API-doc, ADR, architecture-pattern, and UI data-access
  drift.
- None of these compare behavior to prose. A green lint run does **not** mean a
  guide is accurate.

### What an agent can detect

An agent can detect drift only in code it actually reads, and only when its task
asks for a comparison. Auto-loaded guidance supplies the rules; it does not
trigger a repository scan. A fresh subagent that is not told to audit usually
will not find drift. For a read-only audit, the brief must explicitly tell it to
read `AGENTS.md` and the owning guide first.

### Audit procedure

Input: one guide and its scope, for example `lib/tools/Agent.md` and `lib/tools/`.

1. Read `AGENTS.md`, the guide, and its declared scope and canonical files.
2. Extract the checkable claims: invariants, required registration, ownership
   boundaries, anti-patterns, file-map entries, and named tests.
3. Verify each claim against code or tests: open the canonical file, grep for the
   pattern, or run the named test/check. Do not infer from filenames or prose.
4. Classify each finding:
   - **Behavioral drift** — code violates an invariant or anti-pattern. Cite the
     file and line and describe the observed behavior.
   - **Stale guide** — the guide names an API, file, or test that no longer
     exists, or contradicts the implementation.
   - **Undocumented pattern** — the same approach appears in two or more
     independent implementations but is not in the guide.
   - **Structural gap** — a new module file, registration, or test is missing
     from the file map. Low severity unless it changes a contract.
5. Report before editing. Every finding needs the guide claim, file and line,
   evidence (test result or command output), severity, and a proposed authority
   decision.
6. **Authority rule:** code is authoritative for what happens; the guide is
   authoritative for what should happen. Decide which side is wrong. Never
   silently edit the guide to match a bug, or the code to match an aspirational
   claim.
7. Fix the authoritative side, update cross-references, then run
   `npm run check:impact -- --staged` and `npm run lint`.

### When to audit

- While implementing or reviewing in a module, compare the touched code to its
  guide.
- When `check:impact` names the module.
- On dependency or major-version changes that can invalidate patterns.
- Periodically or before a release for high-churn modules; record the scope and
  date so coverage is auditable.

### Subagent brief (copy-paste)

> Audit `<guide>` against `<scope>`. Read `AGENTS.md` and the guide first.
> Extract its invariants, anti-patterns, canonical files, and named tests.
> Verify each against the code and tests with file-and-line evidence; run the
> named checks. Do not edit files. Report only confirmed findings plus suspected
> ones labeled as such, using: severity, guide claim, evidence, authority
> decision. If nothing drifted, list the claims checked and commands run.

### Limits

- Semantic audit is model judgment, not proof. Every finding needs code or test
  evidence.
- A clean audit covers only the guide and files read; it does not certify the
  whole repository.
- Structural checks remain the merge gate; audits supplement them.

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

## Documentation Validation

`npm run lint` runs `node scripts/check-agent-docs.mjs`, which enforces the structural contract for module guidance:

- Every declared guide exists; each module `Agent.md` has loader frontmatter (`description` starting with `Use when:`, `tools`, `reasoning-effort`).
- Every markdown link and inline repository path resolves. Fenced code examples are exempt because they may be sketches.
- `AGENTS.md` links every declared module guide, and its own links and paths resolve.
- Relative links in `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/API_DESIGN_STANDARD.md`, `docs/EXTENDING.md`, `docs/ui-hook-api.md`, `packages/README.md`, and `packages/AGENTS.md` resolve.
- Every `Agent.md` found under `app/`, `components/`, `hooks/`, `lib/`, `scripts/`, or `tests/` is declared in the checker — a new module cannot ship without guidance.

Other documentation gates in `npm run lint`:

- `node scripts/check-architecture-patterns.mjs` verifies every canonical and validation source in [`docs/architecture-patterns.json`](./docs/architecture-patterns.json) exists.
- `node scripts/check-api-docs.mjs` verifies every `@public` and `@public-internal` route is documented in [`docs/api.md`](./docs/api.md), every documented endpoint has a public marker, and no public route is also listed as out-of-scope.
- `node scripts/check-adr-registry.mjs` verifies ADR numbers are unique, every `ADR-NNNN` citation resolves, and ADR-relative links exist.
- `node scripts/check-ui-data-access.mjs` ratchets direct `fetch` / `localStorage` use in `components/`, `hooks/`, and `contexts/` against [`scripts/ui-data-access-baseline.json`](./scripts/ui-data-access-baseline.json); move an endpoint into [`api/client.ts`](./api/client.ts) (or browser state into [`lib/ui/browser-store.ts`](./lib/ui/browser-store.ts)) instead of raising the count.
- `node scripts/check-change-impact.mjs --staged` maps changed module files to follow-up checks, including updating the owning guide.

Change-scoped rather than part of `npm run lint`:
[`scripts/check-module-review.mjs`](./scripts/check-module-review.mjs) maps
touched files to the owning guide, prints its Review checks, and runs mechanical
module invariants (UI boundaries, route SQL/UI imports, tool and provider
registration, DB pragmas, manual store transactions, script `shell: true`).
Pre-commit and PR CI run it. Warnings stay advisory; hard failures block.

These checks are necessary but not sufficient. Reviewers still verify:

- Code examples compile against the current codebase.
- Patterns reflect actual implementations, not aspirational designs.
- Anti-patterns match observed failure modes.
- No contradictions between patterns or with [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
- Test requirements are achievable and named tests exist.
- Performance claims are supported by evidence.

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

### Validate the Update

1. Run `npm run agent-docs:check` (also part of `npm run lint`): frontmatter, links, inline paths, module coverage, and the Review checks section must resolve.
2. Run `npm run check:impact -- --staged`; update the owning guide when a canonical file, invariant, or test moved.
3. Run `npm run review:module -- --staged`; resolve hard findings and update Review checks when the contract changed.
4. Confirm code examples compile and every named test exists.
5. Document the change rationale (below).

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
✅ **Review checks current** - Each guide has evidence-based, module-specific checks
✅ **Frontier patterns progress** - Emerging patterns move toward standardization
✅ **No orphaned patterns** - All patterns actively used in codebase  

---

## Tier 1 Modules (Complete)

**[lib/agents/Agent.md](./lib/agents/Agent.md)**
- LangGraph agent orchestration patterns
- Pattern reference, anti-patterns, testing guide

**[lib/providers/Agent.md](./lib/providers/Agent.md)**
- LLM provider adapter patterns
- Pattern reference, anti-patterns, testing guide

**[lib/db/Agent.md](./lib/db/Agent.md)**
- SQLite persistence patterns
- Pattern reference, anti-patterns, testing guide

**[app/api/Agent.md](./app/api/Agent.md)**
- Next.js API route patterns
- Pattern reference, testing guide

**[lib/tools/Agent.md](./lib/tools/Agent.md)**
- Agent tool implementation patterns
- Pattern reference, testing guide

---

## Tier 2 Modules (Complete)

**[components/Agent.md](./components/Agent.md)**
- Panel/controller/view ownership, shared primitives, dialog and state contracts
- Pattern reference, testing guide, frontier

**[hooks/Agent.md](./hooks/Agent.md)**
- Async supersede, subscription cleanup, command identity, list-state primitive
- Pattern reference, testing guide, frontier

**[lib/stores/Agent.md](./lib/stores/Agent.md)**
- Transactional writes, encryption, tolerant decoding, retention and invalidation
- Pattern reference, testing guide, frontier

---

## Tier 3 Modules (Complete)

**[lib/mcp/Agent.md](./lib/mcp/Agent.md)**
- Connection manager, transport selection, result normalization, registry bounds
- Pattern reference, testing guide, frontier

**[scripts/Agent.md](./scripts/Agent.md)**
- Gate conventions, repo-root resolution, exit codes, stdout protocols
- Pattern reference, testing guide, frontier

**[tests/Agent.md](./tests/Agent.md)**
- Unit/e2e/live layer ownership, isolation, selectors, validation gates
- Pattern reference, testing guide, frontier

`npm run lint` runs `node scripts/check-agent-docs.mjs`, which verifies guide
frontmatter, links, referenced paths, and module coverage. See
[Documentation Validation](#documentation-validation).

---

## Root Agent Guidance

**[AGENTS.md](./AGENTS.md)** - Project-level instructions
- Project stack and layout, run/test commands
- Verified workflows (code-first principle)
- Contribution and release process
- Repository conventions
- Module guide index and auto-loading pointer
- Documentation validation summary
- Drift detection, evidence, and authority rules

---

## Accessing Pattern Information

Short version: [QUICK_REFERENCE_AGENT_MD_SYSTEM.md](./QUICK_REFERENCE_AGENT_MD_SYSTEM.md).

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
