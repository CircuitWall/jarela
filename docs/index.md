# Jarela documentation

> A local-first desktop workspace for building, running, and extending LangGraph agents.

Jarela is a local-first desktop chat UI for LangGraph agents. It runs as a single Next.js process on your machine, keeps state in SQLite, and exposes a structured tool ecosystem for agents, integrations, document indexing, and provider-backed workflows.

## Find your path

=== "Using Jarela"

	Start with installation, then learn the runtime model and the main extension points.

	[Install Jarela](INSTALL.md){ .md-button .md-button--primary }
	[Understand the architecture](ARCHITECTURE.md){ .md-button }

=== "Developing Jarela"

	Set up the repository, run the checks, and use the architecture docs before changing a shared boundary.

	[Set up development](DEVELOPMENT.md){ .md-button .md-button--primary }
	[Explore extension surfaces](EXTENDING.md){ .md-button }

=== "Teaching the agent"

	The built-in documentation skill makes local documentation the first source of truth and uses the public site only as a fallback.

	[Read the architecture](ARCHITECTURE.md){ .md-button .md-button--primary }
	[Read the extension guide](EXTENDING.md){ .md-button }

## Why Jarela exists

- Local-first: a single app on your own machine, no hosted backend required.
- Multi-provider: Anthropic, OpenAI, Google GenAI, Cohere, DeepSeek, and GitHub Copilot can all be configured.
- Agent-first: conversations are checkpointed, tool policies are per-agent, and scheduled/background flows are first-class.
- Extensible: providers, tools, MCP servers, harnesses, and integration manifests all have explicit extension surfaces.

## Core documentation map

| Area | Purpose |
| --- | --- |
| [INSTALL.md](INSTALL.md) | install channels, service setup, first-run guidance |
| [DEVELOPMENT.md](DEVELOPMENT.md) | local dev workflow, repo conventions, build/test commands |
| [ARCHITECTURE.md](ARCHITECTURE.md) | container, component, and runtime architecture |
| [EXTENDING.md](EXTENDING.md) | extension surfaces for providers, tools, MCP, harnesses, and branding |
| [api.md](api.md) | API surface for routes and integration points |
| [PRICING_EXTRACTION_POLICY.md](PRICING_EXTRACTION_POLICY.md) | model pricing extraction and provider policy |
| [DEMO_GMAIL_CONNECT.md](DEMO_GMAIL_CONNECT.md) | example integration flow for Gmail |
| [ui-hook-api.md](ui-hook-api.md) | UI hook contracts and browser UX patterns |

## Documentation contract

The agent itself should not guess at the codebase. Instead, it should discover the relevant docs and extension surface before acting on repo-level changes.

Use the built-in documentation skill and the `describe_extension_surfaces` tool when the task touches:

- provider integration
- tool registration
- MCP server wiring
- harness behavior changes
- app branding or runtime configuration

The installed local docs are the preferred source because they are available offline and match the app version. The GitHub Pages site is a public mirror for browsing and a fallback when local docs cannot be read.

## Architecture note

The codebase is intentionally organized into a few stable layers:

- app and API routes
- agent runtime and prompt assembly
- storage and persistence
- tool/provider/MCP registries
- integration and docs surfaces

This separation is what makes the app extendable without collapsing into one monolith.

## Further reading

- [README](../README.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [CHANGELOG.md](../CHANGELOG.md)
