# Agent.md Pattern System

**Purpose:** Single source of truth for module-specific implementation patterns  
**Scope:** All modules in Jarela repository  
**Audience:** Agents working in or modifying modules

---

## Overview

Each guided module owns an `Agent.md` that documents how to implement
features in that module — its patterns, anti-patterns, canonical files, and
testing requirements. It is the canonical reference for that module. The
module index lives in [AGENTS.md](./AGENTS.md#module-guidance).

The guide loads from the directory being edited:

- `lib/agents/file.ts` → `AGENTS.md` + [lib/agents/Agent.md](./lib/agents/Agent.md)
- `lib/db/file.ts` → `AGENTS.md` + [lib/db/Agent.md](./lib/db/Agent.md)

---

## How agents use the guide

- **Implementing:** identify the module, load its guide, apply the patterns
  that fit (usually one to three), avoid the anti-patterns, and meet the
  testing requirements.
- **Reviewing:** load the guide for the touched module and verify the change
  against its patterns, anti-patterns, and review checks.
- **Changing the guidance:** follow
  [Updating Agent.md Files](#updating-agentmd-files).

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

For change-scoped review, [docs/MODULE_REVIEW.md](./docs/MODULE_REVIEW.md)
generates this procedure as a portable brief for each touched module. For
features spanning three or more modules,
[docs/FEATURE_CONTRACT.md](./docs/FEATURE_CONTRACT.md) freezes interfaces and
emits per-module implementation packets for any coding agent.

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

## Documentation Validation

A guide must stay accurate, complete, current, consistent, and
evidence-backed. `npm run lint` runs `node scripts/check-agent-docs.mjs`, which enforces the structural contract for module guidance:

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
