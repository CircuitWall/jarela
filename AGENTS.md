<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Jarela Project Instructions

These shared instructions apply to coding agents working in this repository. `CLAUDE.md` imports this file for Claude Code compatibility.

## Stack

- **Runtime:** Next.js 16 (App Router) on Node 24.15.0+ (24.x), or 26+
- **UI:** React 19, Tailwind, lucide-react, react-markdown
- **Agents:** LangGraph (`@langchain/langgraph` + SQLite checkpoint)
- **Providers:** Anthropic, OpenAI, Google GenAI, Cohere
- **Tools:** MCP via `@langchain/mcp-adapters` + built-ins under `lib/tools/`
- **Persistence:** SQLite under the platform data directory (`%LOCALAPPDATA%\Jarela` on Windows, `~/.jarela` on macOS/Linux; configurable via `JARELA_DB_DIR`)
- **Validation:** zod
- **Streaming:** ws + undici
- **PWA:** next-pwa

## Layout

```text
app/                # Next.js routes (UI + /api)
api/                # Shared client/types for API surface
components/         # React components by domain
contexts/           # React contexts
hooks/              # React hooks
lib/
	agents/           # LangGraph agent definitions
	providers/        # LLM provider adapters
	tools/            # Built-in tool implementations
	mcp/              # MCP client / adapter glue
	db/               # SQLite + checkpoint store
	stores/           # Memory / settings stores
	scheduler/        # cron-driven background jobs
	streaming/        # WS / SSE plumbing
	notifications/    # Local notifications
public/             # Static + PWA manifest
scripts/            # Maintenance / live tests
```

## Run And Test

- Dev: `npm run dev`
- Build: `npm run build && npm start`
- Lint: `npm run lint`
- Live tests: `npm run test:live` (smoke), `npm run test:live:full`

## Verified Workflows

- This applies to every workflow built into Jarela and every workflow its agents
  create, follow, or document, including workflow tools, skills, and scheduled
  procedures.
- **Code first:** if a step can be done by code, it must be done by code, not
  simulated through model reasoning. Reuse an authorized typed tool or existing
  implementation before authoring a script. Apply this to execution as well as
  validation: calculations, transformations, branching, iteration and checks
  belong in code when their rules are specified.
- Reserve model steps for interpreting intent, resolving ambiguity, judgment
  and explanation. Label their outputs as model-generated and validate every
  machine-checkable property before downstream use.
- Missing execution support or authorization is a blocker, not permission to
  bypass policy or pretend a prompt-only step executed. This direction does not
  imply that a checked script runner is already available.
- Define every building block with explicit **input**, **output**, and
  **validation** criteria. Validate each output before using it as the next
  block's input.
- Prefer executable, deterministic checks (tests, schemas, assertions, or
  scripts) whenever code can verify the result. Record the observed validation
  evidence; agents must not mark a step complete without it.
- Do not present unchecked assumptions or inferred values as verified facts.
  Preserve unknowns and report validation failures explicitly.

## Contribution And Releases

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full rules. Summary:

- Trunk-based: never push to `main`; use a topic branch (`feat/…`, `fix/…`, `chore/…`, `docs/…`, or `refactor/…`) and open a PR.
- Rebase merge only. Every commit that lands on `main` must have a Conventional Commit subject; the PR title is used in release notes.
- `package.json` is the semver source of truth. Nightly Jarela app releases use a minor bump for 3+ `feat` commits since the previous tag and a patch bump otherwise; breaking changes are held for a human to prepare a major release. Workspace packages use standard semver.
- `.github/workflows/nightly-release.yml` prepares the version/changelog/adoption PR, dispatches CI, auto-merges only after required checks pass, and tags the merged commit. `.github/workflows/release.yml` then builds and publishes through GitHub Actions/OIDC; never publish from a developer machine.

## Repository Conventions

- Persistent state goes through `lib/db` or `lib/stores`. Do not write ad-hoc state outside `JARELA_DB_DIR`.
- New LLM providers need an adapter under `lib/providers/`, registration in the agent factory, and documentation in the README provider list.
- New tools go under `lib/tools/` and register in the tool registry. Network or external-resource tools must use an explicit capability.
- Use zod schemas at API boundaries.
- No telemetry, external analytics, or required cloud calls beyond providers the user explicitly configures.
- Open an ADR before changing persistence schema or the data-directory layout, adding a provider, introducing another process, or adding an online-only feature.
- This repository may be OneDrive-synced. Avoid committing large binaries; `.next/` and `node_modules/` are gitignored.

## Architecture

- C4 Context: `README.md`.
- C4 Container, Component, and sequence diagrams: `docs/ARCHITECTURE.md`.
- Update both when component boundaries or external dependencies change.

## Modular Agent Patterns

Each module has specialized Agent.md files that auto-load when editing that module's code. These files are the **canonical reference** for implementation patterns.

See [AGENT_MD_SYSTEM.md](./AGENT_MD_SYSTEM.md) for complete pattern system documentation.

### How It Works

**Auto-Loading by Directory:**
```
Edit lib/agents/file.ts     → loads lib/agents/Agent.md
Edit lib/providers/file.ts  → loads lib/providers/Agent.md
Edit lib/db/file.ts         → loads lib/db/Agent.md
Edit app/api/route.ts       → loads app/api/Agent.md
Edit lib/tools/file.ts      → loads lib/tools/Agent.md
```

**Pattern References:**
- Patterns: 5+ core implementations with examples
- Anti-Patterns: 5+ common mistakes to avoid
- Testing Requirements: Test structure and validation
- Frontier: Emerging patterns not yet standardized

### Tier 1: Core Infrastructure

**[lib/agents/Agent.md](./lib/agents/Agent.md)** - LangGraph orchestration
**[lib/providers/Agent.md](./lib/providers/Agent.md)** - LLM provider adapters
**[lib/db/Agent.md](./lib/db/Agent.md)** - SQLite persistence
**[app/api/Agent.md](./app/api/Agent.md)** - Next.js API routes
**[lib/tools/Agent.md](./lib/tools/Agent.md)** - Agent tool implementations

### Tier 2: Components & State

**components/Agent.md** - React component patterns
**hooks/Agent.md** - React hooks patterns
**lib/stores/Agent.md** - State management patterns

### Tier 3: Integration & Testing

**lib/mcp/Agent.md** - MCP integration patterns
**scripts/Agent.md** - Automation patterns
**tests/Agent.md** - Testing patterns

### Implementation Workflow

1. **Load the module's Agent.md**
   - Identifies relevant patterns (usually 1-3 apply)

2. **Reference appropriate pattern**
   - Review pattern structure and examples
   - Note any trade-offs or edge cases

3. **Implement using pattern**
   - Follow structure from pattern section
   - Avoid documented anti-patterns
   - Meet testing requirements

4. **Validate against requirements**
   - Ensure pattern correctly applied
   - All test scenarios covered
   - Cross-module patterns coordinated

## Agent.md Auto-Evolution & Maintenance

Agent.md files are **living documents** that improve with codebase maturity. Agents continuously monitor patterns and keep documentation synchronized.

### Automated Pattern Monitoring

Agents detect when patterns need updates:

**Pattern Drift Detection**
- Code implementation diverges from documented pattern
- Action: Flag for pattern validation and potential update

**New Pattern Emergence**
- Same implementation approach appears in multiple modules
- Action: Candidate for standardization and documentation

**Anti-Pattern Recurrence**
- Same mistake appears repeatedly across code
- Action: Document as anti-pattern to prevent future occurrences

**API Compatibility**
- Dependency changes affect documented patterns
- Action: Validate and update pattern implementations

**Pattern Coverage Analysis**
- Systematic scan of module files against documented patterns
- Action: Identify gaps and new standardization opportunities

### Pattern Update Workflow

**For Any Agent Modifying Patterns:**

1. Detect pattern change needed (via monitoring or new implementation)
2. Validate pattern against codebase evidence
3. Update Agent.md with pattern changes
4. Update code examples to reflect current best approach
5. Document change rationale in section notes

**Validation Before Update:**

- [ ] Pattern reflects current best practice in codebase
- [ ] All known implementations of pattern catalogued
- [ ] Code examples compile and match pattern specification
- [ ] Related patterns updated if dependencies exist
- [ ] Cross-references and links verified
- [ ] Frontier section updated if pattern moving to stable
- [ ] Change is backward compatible or breaking change noted

### Pattern Lifecycle

Patterns evolve through stages:

**Frontier** (Emerging)
- Initial observation: pattern used in 1-2 implementations
- Status: Under observation, not yet standardized
- Agent behavior: Document in Frontier section, request more examples

**Candidate** (Consolidating)
- Multiple independent implementations found
- Status: Stable enough to document as standard pattern
- Agent behavior: Move from Frontier to numbered pattern section

**Standard** (Established)
- Pattern documented and actively used
- Status: Core best practice for module
- Agent behavior: Reference in all related implementations

**Deprecated** (Superseded)
- Better pattern emerged or use case eliminated
- Status: Keep for reference, don't use in new code
- Agent behavior: Mark as deprecated, suggest alternative

### Pattern Documentation Structure

Each Agent.md maintains consistent sections:

**Patterns** (5+ core implementations)
- What: Clear problem and solution
- When: Use cases and conditions
- Example: Working code that agents can reference
- Trade-offs: Performance, complexity, maintenance implications

**Anti-Patterns** (5+ common mistakes)
- ❌ What NOT to do
- Why: Consequences and failure modes
- ✅ What to do instead
- Reference: Link to correct pattern

**Testing Requirements**
- Unit test structure for pattern
- Integration test scenarios
- Edge cases to validate
- Performance expectations

**Pattern Notes**
- Implementation details
- Common pitfalls
- Performance characteristics
- Maintenance considerations

**Frontier** (Emerging patterns)
- Pattern: Description of emerging approach
- Status: Stability assessment
- Examples: Known implementations
- Next: Conditions for standardization

### Continuous Monitoring

Agents maintain Agent.md accuracy through:

**On Code Commits**
- Scan for implementation patterns
- Compare against documented patterns
- Flag deviations or new approaches

**On Pattern Queries**
- When agent needs pattern guidance
- Validate pattern still current
- Update references if pattern evolved

**On Dependency Changes**
- Check for API compatibility
- Validate pattern still works
- Update examples if needed

**On Pattern Completion**
- When code fully implements pattern
- Confirm examples are current
- Verify test requirements met

### Integration with Code Repositories

Agent.md files are **source of truth** for module patterns:

- Agents reference Agent.md before implementing features
- Code must align with documented patterns
- Pattern changes require Agent.md updates
- Examples in Agent.md must match codebase reality

### Cross-Module Pattern Coordination

When patterns span multiple modules:

```
Pattern change in lib/providers/ error handling
    ↓
Agents update: lib/agents/ error recovery patterns
              lib/tools/ error propagation
              app/api/ error response formatting
    ↓
All affected Agent.md files updated together
```

### Frontier: Pattern Stabilization Track

Emerging patterns documented until ready for standardization:

```markdown
## Frontier Patterns

### Streaming with Backpressure
- Status: 2 implementations, behaviors diverging
- Requirement: 3+ aligned implementations before standard
- Current: Use Pattern X as base, document variations
- Next: Collect implementations, extract common approach

### Multi-Provider Failover
- Status: 1 implementation, pattern under observation
- Requirement: 2+ independent implementations
- Current: Document in Frontier, gather evidence
- Next: Extract pattern once consensus reached
```

### Documentation Validation

Agent.md quality checks:

- Code examples compile against current codebase
- Links resolve to actual files and line numbers
- Patterns reflect actual implementations in codebase
- Anti-patterns match observed failure modes
- No contradictions between patterns
- Test requirements achievable
- Performance claims supported by evidence

### Success Indicators

Healthy Agent.md files show:

- Patterns match actual code implementations
- Anti-patterns prevent repeated mistakes
- New code follows documented patterns
- Examples remain current and accurate
- No orphaned patterns (patterns with no uses)
- Frontier patterns progress toward standardization
- Cross-module patterns stay synchronized

---

## Summary: Self-Improving Documentation

Agent.md files continuously improve:

✅ **Automated monitoring** keeps patterns aligned with codebase
✅ **Pattern detection** captures new approaches for standardization
✅ **Continuous validation** ensures accuracy and relevance
✅ **Lifecycle tracking** moves patterns from frontier to standard
✅ **Cross-module coordination** prevents pattern drift across modules
✅ **Evidence-based** patterns grounded in actual implementations

Agent.md serves as **single source of truth** for how agents should implement features.
