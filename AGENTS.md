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
- **Providers:** Anthropic, OpenAI, Google GenAI, DeepSeek, GitHub Copilot; Cohere via the LangChain bridge
- **Tools:** MCP via `@langchain/mcp-adapters` + built-ins under `lib/tools/`
- **Persistence:** SQLite under the platform data directory (`%LOCALAPPDATA%\Jarela` on Windows, `~/.jarela` on macOS/Linux; configurable via `JARELA_DB_DIR`)
- **Validation:** zod
- **Streaming:** SSE (EventSource) + undici
- **PWA:** Serwist (`@serwist/next`)

## Layout

```text
app/          # Next.js routes (UI + /api)
api/          # Shared client/types for the API surface
components/   # React components by domain
contexts/     # React contexts
hooks/        # React hooks
public/       # Static + PWA manifest
scripts/      # Maintenance / live tests
lib/
  agents/ providers/ tools/   # LangGraph, LLM adapters, built-in tools
  mcp/ db/ stores/            # MCP glue, SQLite, memory/settings
  documents/ embeddings/      # RAG indexers, embedding adapters
  integrations/ pricing/      # OAuth/manifests, pricing catalog
  skills/ scheduler/          # Skill discovery/policy, cron jobs
  notifications/ dependencies/  # Local notifications, dependency probes
  voice/ workflows/           # STT/TTS engines, durable workflows
```

## Run And Test

- Dev: `npm run dev`
- Build: `npm run build && npm start`
- Lint: `npm run lint`
- Live tests: `npm run test:live` (smoke), `npm run test:live:full`

## Verified Workflows

Applies to every workflow Jarela ships and every workflow its agents create, follow, or document — including workflow tools, skills, and scheduled procedures.

- **Code first:** if a step can be done by code, it must be done by code — calculations, transformations, branching, iteration, validation. Reuse an authorized typed tool or existing implementation before writing a script.
- Reserve model steps for intent, ambiguity, judgment, and explanation. Label model-generated output and validate every machine-checkable property before downstream use.
- Missing execution support or authorization is a blocker, not permission to bypass policy or pretend a prompt-only step ran.
- Define every building block with explicit **input**, **output**, and **validation** criteria, and validate each output before it becomes the next block's input.
- Prefer executable, deterministic checks (tests, schemas, assertions, scripts), and record the observed evidence. Never mark a step complete without it.
- Never present unchecked assumptions or inferred values as verified facts; preserve unknowns and report validation failures explicitly.

## Contribution And Releases

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full rules. Summary:

- Trunk-based: never push to `main`; use a topic branch (`feat/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`) and open a PR.
- Rebase merge only. Every commit that lands on `main` needs a Conventional Commit subject; the PR title is used in release notes.
- `package.json` is the semver source of truth. Nightly releases take a minor bump for 3+ `feat` commits since the previous tag, a patch bump otherwise; breaking changes are held for a human to prepare a major release. Workspace packages use standard semver.
- `.github/workflows/nightly-release.yml` prepares the version/changelog/adoption PR, dispatches CI, auto-merges only after required checks pass, and tags the merged commit. `.github/workflows/release.yml` builds and publishes through GitHub Actions/OIDC; never publish from a developer machine.

## Repository Conventions

- Persistent state goes through `lib/db` or `lib/stores`. Do not write ad-hoc state outside `JARELA_DB_DIR`.
- UI modules (`components/`, `hooks/`) consume `api/client.ts` and hooks; ESLint blocks imports of `lib/db`, `lib/stores`, `lib/crypto`, `lib/scheduler`, and `lib/notifications` there.
- New LLM providers need an adapter under `lib/providers/`, registration in `lib/providers/builtins.ts`, and documentation in the provider list in `docs/index.md`.
- New tools go under `lib/tools/` and register in the tool registry. Network or external-resource tools must use an explicit capability.
- Use zod schemas at API boundaries.
- `package.json` is authoritative for dependency and engine versions; update README, `AGENTS.md`, and architecture claims in the same PR when a major version changes.
- No telemetry, external analytics, or required cloud calls beyond providers the user explicitly configures.
- The bundled Gmail OAuth client routes token exchange through a Jarela-hosted Cloud Run proxy. It is used only when that optional integration is enabled; BYO client credentials or `JARELA_GOOGLE_TOKEN_PROXY` bypass it.
- Open an ADR before changing persistence schema or the data-directory layout, adding a provider, introducing another process, or adding an online-only feature.
- This repository may be OneDrive-synced. Avoid committing large binaries; `.next/` and `node_modules/` are gitignored.

## Architecture

- Architecture at a glance: [README.md](./README.md).
- C4 container, component, and sequence diagrams: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
- Update both when component boundaries or external dependencies change.

## Module Guidance

Each guided module owns an `Agent.md` — the canonical reference for its patterns, anti-patterns, and testing requirements. It auto-loads when you edit that module's files; load it before implementing or reviewing work there.

| Module | Guide |
| --- | --- |
| Agent orchestration | [lib/agents/Agent.md](./lib/agents/Agent.md) |
| LLM providers | [lib/providers/Agent.md](./lib/providers/Agent.md) |
| Database | [lib/db/Agent.md](./lib/db/Agent.md) |
| API routes | [app/api/Agent.md](./app/api/Agent.md) |
| Agent tools | [lib/tools/Agent.md](./lib/tools/Agent.md) |
| Components | [components/Agent.md](./components/Agent.md) |
| Hooks | [hooks/Agent.md](./hooks/Agent.md) |
| Stores | [lib/stores/Agent.md](./lib/stores/Agent.md) |
| MCP | [lib/mcp/Agent.md](./lib/mcp/Agent.md) |
| Scripts | [scripts/Agent.md](./scripts/Agent.md) |
| Tests | [tests/Agent.md](./tests/Agent.md) |

Workflow: load the owning guide → follow its patterns and avoid its anti-patterns → run `npm run review:module -- --staged`, `npm run check:impact -- --staged`, and `npm run lint`; update the guide when the change moves a canonical file, invariant, or test. When code and guide disagree, decide which is authoritative — code for behavior, guide for policy — and fix both in the same change.

Guide structure, pattern lifecycle, drift audits, and the full update workflow are documented in [AGENT_MD_SYSTEM.md](./AGENT_MD_SYSTEM.md).

## Documentation Validation

`npm run lint` also enforces the documentation contract:

- Every module guide has loader frontmatter (`description` starting with `Use when:`, `tools`, `reasoning-effort`), resolvable links and inline paths, a Testing or Validation section, and a `## Review checks` list.
- Every `Agent.md` under a module root is declared in [scripts/check-agent-docs.mjs](./scripts/check-agent-docs.mjs) and linked from this file.
- [docs/api.md](./docs/api.md) matches every `@public` and `@public-internal` route; ADR ids, citations, and links resolve; [docs/architecture-patterns.json](./docs/architecture-patterns.json) entries exist on disk.
- Direct `fetch` / `localStorage` use in `components/`, `hooks/`, and `contexts/` is ratcheted against [scripts/ui-data-access-baseline.json](./scripts/ui-data-access-baseline.json). Move an endpoint into [api/client.ts](./api/client.ts) or browser state into [lib/ui/browser-store.ts](./lib/ui/browser-store.ts) instead of raising the count.
- `npm run check:impact -- --staged` maps changed module files to follow-up checks, including updating the owning guide.

Passing checks are necessary but not sufficient: reviewers also verify that examples compile, patterns reflect real implementations, anti-patterns match observed failures, and named tests exist.
