# Jarela

Jarela is a local-first desktop UI for orchestrating LangGraph agents on your own machine. It keeps agent state, memory, schedules, and model/tool configuration in SQLite under a local data directory, with no hosted backend required.

## Highlights

- Local-first, single-process Next.js app
- Multi-provider LLM support: Anthropic, OpenAI, Google GenAI, Cohere, DeepSeek, GitHub Copilot
- Per-agent tool policy, identity, memory, and harness configuration
- SQLite-backed checkpoints, memory, schedules, proposals, and local integrations
- PWA / desktop-friendly workflow with browser extension support
- MCP, integration manifests, and built-in tool extension points

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
- [Extending Jarela](docs/EXTENDING.md)
- [API reference](docs/api.md)
- [Contributing](CONTRIBUTING.md)

## Runtime and architecture

The app is built around a single Next.js process with clear layers:

- app + API routes
- agent runtime + prompt assembly
- provider adapters
- tools + MCP registry
- SQLite persistence and memory stores
- integrations, bridges, scheduler, and browser extension surfaces

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

```text
app/
components/
contexts/
hooks/
lib/
docs/
public/
packages/
```

## Project commands

```bash
npm run dev
npm run build
npm run lint
npm test
```

## License

Apache-2.0
