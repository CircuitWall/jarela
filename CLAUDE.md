# CLAUDE.md â€” Jarela

Project-specific instructions. Inherits from `~/.claude/CLAUDE.md`.

## Stack

- **Runtime:** Next.js 15 (App Router) on Node 25
- **UI:** React 19 + Tailwind + lucide-react + react-markdown
- **Agents:** LangGraph (`@langchain/langgraph` + sqlite checkpoint)
- **Providers:** Anthropic, OpenAI, Google GenAI, Cohere
- **Tools:** MCP via `@langchain/mcp-adapters` + built-ins under `lib/tools/`
- **Persistence:** SQLite at `~/.jarela` (configurable via `JARELA_DB_DIR`)
- **Validation:** zod
- **Streaming:** ws + undici
- **PWA:** next-pwa

## Layout

```
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

## Run / Test

- Dev: `npm run dev`
- Build: `npm run build && npm start`
- Lint: `npm run lint`
- Live tests: `npm run test:live` (smoke), `npm run test:live:full`

## Conventions specific to this repo

- All persistent state goes through `lib/db` or `lib/stores`. Never write ad-hoc state outside `JARELA_DB_DIR`.
- New LLM providers: add adapter in `lib/providers/`, register in agent factory, document in README provider list.
- New tools: add under `lib/tools/<name>.ts`, register in tool registry; if it calls a network/external resource, gate behind a capability flag.
- Schemas at every API boundary use `zod`.
- No telemetry. No external analytics. No required cloud calls beyond the LLM/MCP/GitHub providers the user explicitly configures.

## Decision triggers (in addition to global rules)

Open a new ADR before:
- Adding a new LLM/embedding provider.
- Changing the persistence schema or directory layout under `~/.jarela`.
- Introducing a second process / daemon (current invariant: single Next.js process).
- Adding any feature that requires the app to be online.

## Known constraints

- Repo lives on a OneDrive-synced path. Avoid committing large binaries; `.next/` and `node_modules/` are gitignored.

## Architecture diagrams

- C4-Context in `README.md`.
- C4-Container + Component + sequence flows in `ARCHITECTURE.md`.
- Update both whenever component boundaries or external dependencies change.
