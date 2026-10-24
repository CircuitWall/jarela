# Jarela

Jarela is a local-first desktop UI for orchestrating LangGraph agents on your own machine. It keeps agent state, memory, schedules, and model/tool configuration in SQLite under a local data directory, with no hosted backend required.

> **New to Jarela?** Visit the [documentation site](https://circuitwall.github.io/jarela/) for install, operations, architecture, and extension guides.

## Highlights

- Local-first, single-process Next.js app
- Multi-provider LLM support: Anthropic, OpenAI, Google GenAI, Cohere, DeepSeek, GitHub Copilot
- Per-agent tool policy, identity, memory, and harness configuration
- Per-agent Home, Work, Developer, and Everything usage profiles for response style, chat diagnostics, and credential discovery
- SQLite-backed checkpoints, memory, schedules, proposals, and local integrations
- Durable, agent-targeted lifecycle signals for restarts, approvals, configuration changes, and background work
- PWA / desktop-friendly workflow with browser extension support
- MCP, integration manifests, and built-in tool extension points
- Guided first-run setup that helps you create a default assistant and personalize it in chat

## Jarela in action

<p align="center">
	<img src="docs/assets/operations-dashboard.png" alt="Usage dashboard showing Jarela token and cost summaries" width="49%">
	<img src="docs/assets/operations-tools.png" alt="Tools view showing installed packages and runtime controls" width="49%">
</p>

## First launch

<p align="center">
	<img src="docs/assets/first-run-splash.png" alt="Jarela splash transitioning into first-run setup" width="49%">
	<img src="docs/assets/first-run-profile.png" alt="First-run profile step" width="49%">
</p>
<p align="center">
	<img src="docs/assets/first-run-provider.png" alt="Choose a model provider during first-run setup" width="49%">
	<img src="docs/assets/first-run-assistant.png" alt="Choose a name and starting goal for the default assistant" width="49%">
</p>

Follow the [first-run guide](docs/FIRST_RUN.md) for the full setup flow and what to expect in your first chat.

## Agent usage profiles

The top-left agent switcher keeps the current agent first, followed by agent
icons that fade with distance. Hover or keyboard focus restores their opacity;
selecting one brings it forward and opens its chat with an animated handoff.
The strip scrolls horizontally on small screens and respects reduced motion.
Background icons retain the existing default/latest-message ordering. Unread
notifications use shared per-agent tracking and appear as bright
dots, independent of icon fading; opening the agent's chat clears its unread state.

The menu is destination-based rather than a second agent picker. Workspace
contains Agents, plus Knowledge, Automations, and Usage in Full mode.
Profile and Settings live under Preferences; Capabilities is under the
collapsible Advanced section in Full mode. Models, credentials, and logs remain
in Settings. Full-width, touch-friendly rows use complete labels on small screens
and close the menu after navigation. Switch agents or return to chat using the
header strip; selecting an agent there also closes the menu.
Public branding values, including unset values, are inlined at build time so
default logos and names do not require a browser-side Node `process.env` shim.

Choose a **Persona** under an agent's **Identity** settings:

| Profile | Replies | Chat | Suggested defaults |
| --- | --- | --- | --- |
| Home | Friendly, plain-language summaries; expand when needed | Technical details hidden until revealed | Warmth 80, expressiveness 65, detail 25, cue adaptation 40; standard citations |
| Work | Professional results, decisions, and next steps | Technical details hidden until revealed | Warmth 55, expressiveness 35, detail 45, cue adaptation 30; standard citations |
| Developer | Evidence-backed claims, explicit assumptions and validation limits | Full diagnostics | Warmth 30, expressiveness 20, detail 60, cue adaptation 20; strict citations |
| Custom / Everything | No preset response organization | Full diagnostics | Keeps current settings |

Selecting a persona applies editable style and citation defaults. Tune warmth,
expressiveness, response detail, and conversational-cue adaptation in the same
Persona section; citation coverage stays independent in **Advanced settings**.
Zero cue adaptation keeps style steady. Disabling style customization retains
saved sliders and the profile's organization. MBTI has been removed from the editor
and prompt behavior; existing tuned slider values are preserved, with no automatic
reset on upgrade or save. Home and Work keep **Technical details** inside chat's
single expandable **Filters & focus** control, alongside channel and focus controls.
Failures, approval requests, source links, and factual-accuracy requirements remain
visible or applicable in every profile. Diagnostics are still collected locally;
the profile changes presentation, not tool permissions or model-context filters.
Actual model adherence to style and grounding instructions depends on the provider.

System prompts separate instruction composition, agent identity/instructions,
navigation, a single resolved Persona, and grounding/citations into named chapters.
The Persona combines the selected profile's organization and direct style targets;
explicit task depth takes priority. Conversational cues are tentative heuristics,
not emotion or personality diagnoses. Citation coverage follows the independently
editable citation setting. Assumptions never count as verified evidence, and
resource-saving modes cannot skip required validation. Plain-text delivery channels
use source URLs instead of Markdown citation wrappers.

The Credentials catalog follows the active agent's profile. Configured integrations
and saved credentials stay accessible; **Show all integrations** bypasses discovery
filtering. With no active agent, the catalog shows everything. Global Essential/Full
mode still controls app configuration panels independently.

On upgrade, the old user-profile Persona preset is copied once to existing agents,
without rewriting their tuned personality or citation settings. New agents default
to Everything. See [ADR-0105](docs/adr/0105-per-agent-usage-profiles.md).

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
- [First-run guide](docs/FIRST_RUN.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Operations guide](docs/OPERATIONS.md)
- [Extending Jarela](docs/EXTENDING.md)
- [API reference](docs/api.md)
- [Contributing](CONTRIBUTING.md)

Maintainers can optionally run Copilot to propose a version-to-version
documentation PR. Releases do not require this review or a Copilot token;
ordinary CI and nightly releases never start paid AI sessions. See the
[on-demand release documentation workflow](CONTRIBUTING.md#on-demand-release-documentation).
This is development/release infrastructure, not a cloud dependency of the app.

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
