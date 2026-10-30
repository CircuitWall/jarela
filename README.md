# Jarela

Jarela is a local-first desktop UI for orchestrating LangGraph agents on your own machine. It keeps agent state, memory, schedules, and model/tool configuration in SQLite under a local data directory, with no hosted backend required.

> **New to Jarela?** Visit the [documentation site](https://circuitwall.github.io/jarela/) for install, operations, architecture, and extension guides.

## Highlights

- Local-first, single-process Next.js app
- Multi-provider LLM support: Anthropic, OpenAI, Google GenAI, Cohere, DeepSeek, GitHub Copilot
- Per-agent tool policy, identity, memory, and harness configuration
- Wide-screen agent sidebar with per-agent model, usage strategy, and voice controls
- Per-agent Home, Work, Developer, and Everything usage profiles for response style, chat diagnostics, and credential discovery
- SQLite-backed checkpoints, memory, schedules, proposals, and local integrations
- Durable, agent-targeted lifecycle signals for restarts, approvals, configuration changes, and background work
- PWA / desktop-friendly workflow with browser extension support
- MCP, integration manifests, and built-in tool extension points
- Mermaid diagram previews with expandable, copyable source and sanitized SVG downloads
- Guided first-run setup that helps you create a default assistant and personalize it in chat

## Jarela in action

<p align="center">
	<img src="docs/assets/operations-agents.png" alt="Wide-screen studio layout with the agent sidebar, workspace, and selected-agent controls" width="49%">
	<img src="docs/assets/operations-mobile.jpg" alt="Mobile-width Agents view in a simulated iPhone frame; device frame and system indicators are illustrative" width="49%">
</p>
<p align="center">
	<img src="docs/assets/operations-dashboard.png" alt="Usage dashboard showing Jarela token and cost summaries" width="49%">
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

## Checked skills and durable workflows (Unreleased)

The Skills view includes explicit checked execution and durable workflow
controls. Enable the concrete execution tools for the selected agent and review
the exact code, inputs, workspace and limits before approval. Reading a skill
does not run it. Scripts run with full host permissions, **not in a sandbox**.
Windows Job Objects and delegated Linux cgroup-v2 ownership are supported;
missing host prerequisites and unsupported platforms fail explicitly.
Workflow choices are not execution consent, and uncertain writes require
authorized read-back rather than replay. See the [execution guide](docs/EXTENDING.md#checked-execution-and-durable-workflows-unreleased)
and [operations](docs/OPERATIONS.md#checked-execution-and-workflow-lifecycle-unreleased).

## Dashboard costs (Jarela 3.0.0)

The dashboard shows separate **input** and **output** prices per million tokens
for each model, and separate input/output spending in the summary, daily
selection, and vendor/model/agent reports. Input spending includes prompt-cache
read/write charges under the existing provider pricing assumptions. Costs are
current-rate estimates, not invoices; recorded historical totals remain unchanged.
When no matching rates are available, a recorded cost is shown as **unattributed**
instead of inventing an input/output split. Legacy messages still use
content-length token estimates.

## Document indexing and recall privacy (Jarela 3.0.0)

In Documents, use **Opt in to indexing** to choose a local folder or a supported
connected integration (Gmail, Outlook, iCloud, GitHub, Jira, or Confluence). Scope remote
sources to a mailbox, repository, project, or space. Connecting credentials
does not automatically index content. Removing a source deletes its indexed
documents and chunks without changing the originals.

Gmail, Outlook, and iCloud mail sources offer **Inbox**, a **chosen folder or
label**, or **whole mailbox** (including spam and trash). Search is optional.
For chosen folders, Gmail accepts an exact label name or ID; Outlook accepts a
folder ID or well-known name such as `sentitems`; iCloud accepts a mailbox path.
Leave **Max results** blank for all messages, or set a positive limit. Outlook
text search has a Microsoft Graph ceiling of 1,000 results; leave search blank
to scan a complete folder/mailbox. New sources keep an archive: previously
indexed messages remain even if moved, deleted, or no longer matching the
query. Enabled sources refresh approximately every ten minutes while Jarela is
running and unlocked; this is polling, not instant delivery. Large initial
scans may take longer. Existing query-only Gmail/Outlook sources retain their
previous bounded mirror behavior; recreate them to use the new scopes and
archive defaults. iCloud indexing requires the updated iCloud package.

### iCloud mail sending

The updated iCloud package also provides `icloud_mail_send_email`, classified
as **execute** like Gmail/Outlook sending. Enable it explicitly in the agent's
tool permissions and only request it when you want to send immediately; use
drafts for review. It reuses the saved app-specific password. If your Apple ID
differs from your mail address, set **Credentials → iCloud → iCloud Mail
address** (or `ICLOUD_MAIL_ADDRESS` with environment credentials). SMTP uses
the full mail address, with mandatory STARTTLS on port 587. A successful send
means SMTP acceptance, not confirmed delivery. Do not automatically retry
uncertain or partially accepted sends. See the [package sending guide](packages/icloud-langchain/README.md#smtp-sending).

Indexing with an embedding provider other than **Jarela Local** displays a warning
and requires confirmation in the source setup flow. Content may be sent to that
provider, including material later excluded from recall. Switching away from
Jarela Local also requires confirmation. Locally embedded excerpts can still be
sent to a cloud chat model when retrieved for an answer.

**Global recall exclusions** apply to all indexed sources, both existing and new:

- Save topic descriptions for automatic, best-effort semantic filtering of
  matching chunks. The default similarity cutoff is 0.8; lower values exclude
  more. Topic descriptions use the selected embedding provider.
- Search a topic and choose **Exclude document** to block all chunks of a
  selected document. This exact exclusion uses source ID and path, so it
  survives reindexing within that source. Recreating a source requires selecting
  its document exclusions again.
- Assistant document searches respect exclusions and cannot enable an override.
  The user-facing search preview has a separate **Include excluded content**
  checkbox, off by default, which does not grant the assistant access.
- If topic vectors or chunk embeddings are unavailable, invalid, or have
  incompatible dimensions or model signatures, filtered search fails explicitly
  rather than returning unchecked chunks. Reindex existing sources before using
  topic rules for the first time after upgrading: older vectors have no model
  provenance. Also reindex sources after changing embedding models.

Semantic filtering is not a privacy guarantee: mixed-topic chunks and indirect
references can be missed. Search previews are ranked and limited, not exhaustive
audits. Exclusions do not delete stored content, prevent external embedding,
remove excerpts already in chats, or restrict separate live email/file tools.

## Model updates (Jarela 3.0.0)

The built-in pricing-maintenance agent tool also checks official model
documentation for version and capability changes. It refreshes catalog/badge
metadata without switching saved models or enabling new APIs; confirmed adoption
gaps are escalated through deduplicated GitHub issues when access and approval
are available. See [model-update operations](docs/OPERATIONS.md#review-usage).

## Agent usage profiles

**Jarela 3.0.0:** On wide screens, the scrollable left sidebar
shows agent names, unread counts, usage profiles, selected-tool counts, and
model routing. The selected-agent card above the right menu provides quick
model, usage-strategy, and voice controls. These settings save immediately;
model and strategy changes apply to new runs. Narrow screens use the mobile
header and menu drawer instead of docked sidebars. The phone image above uses
an illustrative device frame around a mobile-width capture, not a verified
installed iOS PWA screenshot. See [desktop agent controls](docs/OPERATIONS.md#operating-jarela).

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

### Web search and fetch backends (Jarela 3.0.0)

`web_search` and `web_fetch` are Jarela tools, separate from model-native web-search
capabilities shown in model badges. Firecrawl Search and Jarela's guarded direct
page fetch remain the defaults. To opt in to DeepSeek's separate Search and Fetch
APIs, configure **DeepSeek Search & Fetch** under Settings → Credentials. This
dedicated encrypted credential is required; configuring a DeepSeek chat-model key
alone never sends web queries or URLs to DeepSeek. Removing the dedicated credential
restores the existing backends.

DeepSeek Fetch returns Markdown without image extraction. Raw HTML requests,
hosts in Allowed sites (including cookie-authenticated pages), and private-fetch
overrides retain the existing direct-fetch path. Jarela checks URLs against its
SSRF policy before using DeepSeek Fetch. As documented by
DeepSeek on 2026-10-25, successful Search and Fetch requests are each priced at
$0.75 per 1,000 requests; empty searches and failed requests are not billed.
See the [DeepSeek Search & Fetch guide](https://api-docs.deepseek.com/guides/search)
for current limits, pricing, and API behavior.

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

**Proposed post-3.0 direction:** maintain a dependable core and let users,
assisted by their connected agents, own specialized extensions. This is a
direction proposal, not a feature freeze or a claim that extension code is
sandboxed. See the [product requirements](docs/POST_3_DIRECTION.md) and
[ADR-0111](docs/adr/0111-dependable-core-user-owned-extensions.md) for scope,
trust boundaries, validation gates and future-work criteria.

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

The docs commands use [Zensical](https://zensical.org); install it with
`pip install -r requirements-docs.txt` (Python 3.11 or newer).

## License

Apache-2.0
