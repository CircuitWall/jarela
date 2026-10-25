<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Jarela Project Instructions

These shared instructions apply to coding agents working in this repository. `CLAUDE.md` imports this file for Claude Code compatibility.

## Stack

- **Runtime:** Next.js 16 (App Router) on Node 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+
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
