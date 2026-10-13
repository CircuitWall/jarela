# Jarela

Jarela is a local-first desktop UI for orchestrating LangGraph agents on your own machine. It keeps agent state, memory, schedules, and model/tool configuration in SQLite under a local data directory, with no hosted backend required.

> **New to Jarela?** Visit the [documentation site](https://circuitwall.github.io/jarela/) for install, operations, architecture, and extension guides.

## Highlights

- Local-first, single-process Next.js app
- Multi-provider LLM support: Anthropic, OpenAI, Google GenAI, Cohere, DeepSeek, GitHub Copilot
- Per-agent tool policy, identity, memory, and harness configuration
- SQLite-backed checkpoints, memory, schedules, proposals, and local integrations
- Durable, agent-targeted lifecycle signals for restarts, approvals, configuration changes, and background work
- PWA / desktop-friendly workflow with browser extension support
- MCP, integration manifests, and built-in tool extension points

## Jarela in action

<p align="center">
	<img src="docs/assets/operations-dashboard.png" alt="Usage dashboard showing Jarela token and cost summaries" width="49%">
	<img src="docs/assets/operations-tools.png" alt="Tools view showing installed packages and runtime controls" width="49%">
</p>

## Quick start

```bash
npm install
npm run dev
```

Then open http://127.0.0.1:4312.

## Documentation

Full docs are organized under the docs site and source docs folder:

- [Live documentation site](https://circuitwall.github.io/jarela/)
- [Docs home](docs/index.md)
- [Install guide](docs/INSTALL.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations guide](docs/OPERATIONS.md)
- [Extending Jarela](docs/EXTENDING.md)
- [API reference](docs/api.md)
- [Contributing](CONTRIBUTING.md)

## Modular design

Jarela is a single Next.js process organized around domain modules and explicit runtime boundaries:

- The UI calls typed API routes; route handlers guard and validate requests before delegating to `lib/`.
- `lib/agents/` coordinates turn execution through provider and tool registries, with stores owning persistence.
- Providers, built-in tools, MCP servers, bridges, and integrations connect through adapters and registries instead of reaching into each other's implementations.
- Background work reuses the existing scheduler, agent queues, SQLite outbox, and leased signal delivery; there is no additional broker or agent process.

See the [C4 architecture and module map](docs/ARCHITECTURE.md) for runtime relationships, and the [development guide](docs/DEVELOPMENT.md) for module-specific extension rules.

## Extension surfaces

Jarela supports explicit extension points for:

- built-in LLM providers
- external provider plugins
- built-in tools
- MCP servers
- custom harnesses
- integration manifests
- app branding / runtime config

Use the agent tool `describe_extension_surfaces` and the docs guide for the correct entry point before editing frameworks or config.

## Repository structure

| Path | Owns |
| --- | --- |
| `app/` | App Router pages and HTTP route adapters |
| `api/` | Shared API client and contracts |
| `components/`, `hooks/`, `contexts/` | Domain UI, view behavior, and browser state |
| `lib/agents/` | Agent runtime and turn lifecycle |
| `lib/providers/`, `lib/tools/`, `lib/mcp/` | Model adapters, tool registry/domains, and MCP integration |
| `lib/stores/`, `lib/db/`, `lib/crypto/` | Persistence, SQLite access, and encryption |
| `lib/scheduler/`, `lib/bridges/`, `lib/streaming/` | Background triggers, transports, and run updates |
| `packages/` | Isolated npm workspace packages |
| `docs/`, `public/` | Architecture and user docs; static assets |

## Project commands

```bash
npm run dev
npm run build
npm run lint
npm test
npm run docs:dev
npm run docs:build
```

## License

Apache-2.0
