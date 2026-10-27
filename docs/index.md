# Jarela documentation

> A local-first desktop workspace for building, running, and extending LangGraph agents.

Jarela is a local-first desktop chat UI for LangGraph agents. It runs as a single Next.js process on your machine, keeps state in SQLite, and exposes a structured tool ecosystem for agents, integrations, document indexing, and provider-backed workflows.

**Version scope:** This documentation snapshot targets Jarela `3.0.0` and
covers repository changes through commit
`50f0be5ce99917e2f580ad74716cc4169be14e71` (2026-10-27). Features listed under
[Unreleased](CHANGELOG.md#unreleased) are not part of 3.0.0. Workspace package
documentation follows that package's version and identifies unreleased behavior
separately. Update this baseline after each full documentation review.

## Find your path

### Release updates

Read the [per-release changelog](CHANGELOG.md) for user-visible changes and
[agent upgrade details](adoption/index.md) for prompt/tool schema deltas.
The [project history chart](PROJECT_HISTORY.md) shows automatically generated
commit statistics and accumulated net text lines without an editorial storyline.
Machines should use the [JSON changeset feed](adoption/changesets.json), not scrape
the HTML preview. The schema-versioned feed includes each release's predecessor,
adoption hints, prompt deltas, and tool parameter changes.
Automatic adoption uses bundled changesets for the installed version and asks
the agent to prefer this feed for supplementary guidance when
`web_fetch` is available and permitted. It excludes Unreleased/future entries
and reports unavailable web access while continuing with local evidence.

### Using Jarela

Start with installation and the [first-run setup](FIRST_RUN.md), then learn the runtime model and main extension points.

[Install Jarela](INSTALL.md) · [Set up your first assistant](FIRST_RUN.md) · [Operate Jarela](OPERATIONS.md) · [Understand the architecture](ARCHITECTURE.md)

### Developing Jarela

Set up the repository, run the checks, and use the architecture docs before changing a shared boundary.

[Set up development](DEVELOPMENT.md) · [Explore extension surfaces](EXTENDING.md)

### Teaching the agent

The built-in documentation skill makes local documentation the first source of truth and uses the public site only as a fallback.

[Read the architecture](ARCHITECTURE.md) · [Read the extension guide](EXTENDING.md)

## Why Jarela exists

- Local-first: a single app on your own machine, no hosted backend required.
- Multi-provider: Anthropic, OpenAI, Google GenAI, Cohere, DeepSeek, and GitHub Copilot can all be configured.
- Agent-first: conversations are checkpointed, tool policies are per-agent, and scheduled/background flows are first-class.
- Extensible: providers, tools, MCP servers, harnesses, and integration manifests all have explicit extension surfaces.

## Core documentation map

| Area | Purpose |
| --- | --- |
| [INSTALL.md](INSTALL.md) | install channels, service setup, first-run guidance |
| [FIRST_RUN.md](FIRST_RUN.md) | first-run wizard, provider/model setup, assistant identity, and first chat |
| [OPERATIONS.md](OPERATIONS.md) | agents, profile, settings, dashboard, tools, tasks, and chat workflows |
| [DEVELOPMENT.md](DEVELOPMENT.md) | local dev workflow, repo conventions, build/test commands |
| [ARCHITECTURE.md](ARCHITECTURE.md) | container, component, and runtime architecture |
| [architecture-patterns.json](architecture-patterns.json) | machine-readable catalog of canonical operation patterns and their tests |
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

- [README](https://github.com/CircuitWall/jarela#readme)
- [CONTRIBUTING.md](https://github.com/CircuitWall/jarela/blob/main/CONTRIBUTING.md)
- [CHANGELOG.md](https://github.com/CircuitWall/jarela/blob/main/CHANGELOG.md)
