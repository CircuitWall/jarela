# Extending Jarela

This is the single integration guide for everything you can plug into,
hook on top of, or layer around Jarela. It covers seven extension surfaces.
Inside the running app, the agent-callable
[`describe_extension_surfaces`](#agent-introspection-tools) tool returns the
same map this document is built around.

> **Public surface contract.** Plugin authors should rely only on the type
> exports listed in [CONTRIBUTING.md → Public API surface](../CONTRIBUTING.md#public-api-surface).
> Anything else is internal and may change between minor versions.

## Table of contents

- [Adding an LLM provider (built-in)](#adding-an-llm-provider-built-in)
- [Adding an LLM provider (external `.cjs` plugin)](#adding-an-llm-provider-external)
- [Adding a built-in tool](#adding-a-built-in-tool)
- [Adding an MCP server](#adding-an-mcp-server)
- [Adding a custom harness](#adding-a-custom-harness)
- [Adding an integration manifest](#adding-an-integration-manifest)
- [Branding the app](#branding-the-app)
- [Agent introspection tools](#agent-introspection-tools)

---

## Adding an LLM provider (built-in)

In-tree provider adapters (Anthropic, OpenAI, Gemini, DeepSeek, GitHub
Copilot, …) live under `lib/providers/<name>.ts` and are wired in via the
static `BUILTINS` map in `lib/providers/index.ts`.

Steps:

1. Create `lib/providers/<name>.ts` exporting a `ModelProvider` from
   `@circuitwall/jarela/lib/providers/types`. Implement at least `chat`;
   add `invoke` and `streamInvoke` if the provider supports tools, and
   `embed` / `listModels` if it supports those.
2. Add an entry to `BUILTINS` in `lib/providers/index.ts`.
3. If the provider has known model context windows that the live API
   doesn't surface, register them in `lib/providers/known-context-windows.ts`.
4. Document the new provider in the README "Providers" section.

Reference contract: `lib/providers/types.ts` (the `ModelProvider`
interface and its companion event/message types). See
[`lib/providers/anthropic.ts`](../lib/providers/anthropic.ts) for a
non-trivial worked example with tool calling, prompt caching, and
multi-modal input.

ADR: [0013](../docs/adr/0013-external-providers-and-tools.md).

---

## Adding an LLM provider (external)

If you don't want to vendor your provider in the tree (closed-source
gateway, vendor-internal model catalogue, etc.), drop a CommonJS plugin
into `~/.jarela/providers/<name>.cjs`. It's hot-loaded per call — no
rebuild, no restart.

Steps:

1. Copy [`lib/providers/template-external.cjs.example`](../lib/providers/template-external.cjs.example) to `~/.jarela/providers/<name>.cjs`.
2. Implement the same `ModelProvider` shape from
   `@circuitwall/jarela/lib/providers/types`. The plugin file just
   `module.exports = { name, chat, invoke?, streamInvoke?, ... }`.
3. Confirm with the agent: ask `list_providers` to see your name appear,
   and `describe_provider` for capability/model details.

Auth, retries, and error mapping are the plugin's responsibility.
Capability flags (`vision`, `tools`, `streaming`, `json_mode`,
`web_search`, `audio`, `files`) come from `listModels()` if you implement
it; otherwise the runtime infers from which methods are present.

ADR: [0013](../docs/adr/0013-external-providers-and-tools.md).

---

## Adding a built-in tool

Built-in tools register themselves at module load. Adding one is two
files:

1. Create `lib/tools/<name>.ts`:
   ```ts
   import { tool } from "@langchain/core/tools";
   import { z } from "zod";
   import { registerLangChainPackage } from "./langchain-package";

   export const myTool = tool(
     async ({ foo }) => JSON.stringify({ result: foo.toUpperCase() }),
     {
       name: "my_tool",
       description: "What this does, when the agent should call it.",
       schema: z.object({ foo: z.string() }),
     },
   );

   registerLangChainPackage({
     category: "Files",
     tools: { read: [myTool] },
   });
   ```
2. Add `import "./<name>";` to `lib/tools/builtins.ts`.

That's it — no central array, no parallel category map. The new tool is
visible in `GET /api/v1/tools`, callable by every agent (subject to its
tool policy), and surfaced through the `list_tools` agent tool.

**Capability gating** (`registerLangChainPackage({ category, tools: { read | write | execute: [...] } })`):

- `read` — pure read of local or remote state. No side effects.
- `write` — mutates local or remote state.
- `execute` — runs arbitrary code (shell, sandboxed eval, …).

External (`.cjs`) and MCP tools default to `execute` until manifest-level
overrides land. See [ADR-0038](../docs/adr/0038-tool-capability-tiers.md).

**Description text matters.** The text in `description` is what the LLM
sees. Multi-sentence is fine — tell it WHEN to call this tool, not just
WHAT it does. Look at [`lib/tools/integrations.ts`](../lib/tools/integrations.ts)
for the pattern.

Reference contract: `lib/tools/types.ts` and `lib/tools/registry.ts`.
Worked example: [`lib/tools/template.ts`](../lib/tools/template.ts).

---

## Hot-loading a vanilla LangChain tool package

Any npm package that exports a class implementing
`StructuredToolInterface` (the LangChain.js convention used by
`@langchain/community`, `@langchain/google-community`, third-party
packages, …) can be loaded into Jarela without writing code. The
operator manages the install themselves; Jarela reads a JSON manifest,
dynamic-imports the package, calls the constructor, and registers the
returned tool under a Jarela category + capability.

1. Pick a directory for installed packages. Default is
   `~/.jarela/packages/`; override with `JARELA_PACKAGES_DIR`.
2. Inside that directory, run `npm init -y` once, then `npm install`
   each package you want (e.g. `npm install @langchain/community`).
3. Create `<packages-dir>/manifests/<name>.json` per tool:
   ```json
   {
     "package": "@langchain/community/tools/tavily_search",
     "export": "TavilySearchResults",
     "category": "Web",
     "capability": "read",
     "args": { "maxResults": 5 },
     "requiredEnv": ["TAVILY_API_KEY"]
   }
   ```
   Fields:
   - `package` — npm module specifier (resolved from your packages dir's
     `node_modules`).
   - `export` — named export. Default `"default"`.
   - `category` — Jarela category (`"Web"`, `"Mail"`, … — same vocabulary
     as built-in tools, see [`registry.ts`](../lib/tools/registry.ts)).
   - `capability` — `"read"` / `"write"` / `"execute"`. Default
     `"execute"` (conservative).
   - `args` — constructor arguments, passed as a single object.
   - `requiredEnv` — optional. If any listed env var is unset, the
     manifest is skipped (with a `skipped` reason) instead of erroring.
4. Either restart the server (the agent sees the tool on its next turn)
   or hit `POST /api/v1/packages/reload` to re-scan without restart.

Inspect the loader state any time with `GET /api/v1/packages`, which
returns the resolved `packagesDir`, registered tool names, skipped
manifests (with reasons, e.g. `requiredEnv` unset), and per-manifest
errors. Both endpoints are thin wrappers around
[`lib/tools/langchain-packages.ts`](../lib/tools/langchain-packages.ts).

**Installing a package via API.** `POST /api/v1/packages/install`
with `{ "spec": "<npm-spec>", "version": "<optional>" }` runs
`npm install` inside `$JARELA_PACKAGES_DIR` and returns the
introspected `StructuredTool` exports it found. Packages from a
publisher in `PACKAGE_PUBLISHER_ALLOWLIST` (default `@langchain/*`,
`@circuitwall/*`, `langchain`; extend via the
`JARELA_PACKAGE_ALLOWLIST` env var, same pattern as
`ENV_ALLOWLIST` in [`lib/env/allowlist.ts`](../lib/env/allowlist.ts))
install immediately. Anything else returns `202` with a pending
approval id; `GET /api/v1/packages/install` lists pending approvals,
`POST /api/v1/packages/install/:id` approves and runs, and
`DELETE /api/v1/packages/install/:id` denies.

**Registering an installed package.** Once the package is on disk,
the manifest-CRUD endpoints create the file that the loader picks up:

- `GET /api/v1/packages/manifests` — list current manifests.
- `POST /api/v1/packages/manifests` with `{ name, package, export?,
  category, capability?, args?, requiredEnv? }` — write a new
  manifest and trigger a reload. 409 on duplicate name.
- `GET|PUT|DELETE /api/v1/packages/manifests/:name` — fetch, upsert
  (replace), or remove a single manifest.

Each mutating call triggers `reloadLangChainPackages()` so the tool
becomes live (or disappears) on the agent's next turn.

**Trust model.** A loaded package runs with full Node privilege in the
Jarela process, same as `JARELA_TOOLS_DIR` extensions. Only install
packages you would `npm install` into any of your own projects.

**Auth.** The constructor's `args` are the auth surface for this
release — for packages whose env vars do the work (Tavily, SerpAPI,
many community tools) just set the env var and add it to `requiredEnv`.
A future PR will add an Integrations-panel form for packages that need
operator-managed credentials.

---

## Adding an MCP server

Jarela's tool pool merges MCP-server tools with built-ins. To register a
server:

- **Via the UI.** App → Settings → MCP → Add server. Pick `stdio`
  (subprocess) or `http` (remote SSE/HTTP), fill in the spec, save.
- **Programmatically.** Call `upsertMcpServer(...)` from
  [`lib/stores/mcp-servers.ts`](../lib/stores/mcp-servers.ts) with a
  `McpServerInput`. Spec env vars and headers are encrypted at rest
  (ADR-0005).
- **From the registry picker.** The MCP picker UI fetches the official
  registry (registry.modelcontextprotocol.io). Variables (`${TOKEN}` etc.)
  are substituted via `applyVariables` from
  [`lib/mcp/registry.ts`](../lib/mcp/registry.ts).

After save, the agent sees the new tools in its pool on the next turn —
verify with the `list_tools` or `list_mcp_servers` tools. If a server's
`last_error` is non-null, fix the spec and the next request retries.

ADR: [0014](../docs/adr/0014-mcp-registry-online-discovery.md).

---

## Adding a custom harness

A harness is the system-prompt scaffold an agent runs under: it composes
sections like "plan first," "list capabilities up front,"
"propose-config-change rules," etc. Built-in presets live in
[`lib/agents/harness/presets.ts`](../lib/agents/harness/presets.ts).

To add a custom harness:

- **From inside the app.** Use the agent's `propose_config_change` tool
  with kind `upsert_harness`. The user approves; the harness is stored in
  the `memory_store` table under the `app-settings` namespace.
- **By editing presets.** For an in-tree built-in harness, add a new
  entry to `presets.ts` — section keys, default order, body text.

An agent binds to a harness by `harness_id` on its config row. Resolution
order is per-agent → global default → `builtin:default` (see
[`lib/agents/harness/resolve.ts`](../lib/agents/harness/resolve.ts)).

ADR: [0036](../docs/adr/0036-agent-driven-harness-edits.md).

---

## Adding an integration manifest

An integration manifest tells the agent how to walk a user through
setting up a new external service (Atlassian, Gmail, GitHub, …). The
agent uses `list_integrations` and `get_integration_setup` tools to
narrate the recipe and proposes the corresponding config changes.

Steps:

1. Add a manifest under [`lib/integrations/registry.ts`](../lib/integrations/registry.ts) with prerequisites, ordered steps, and troubleshooting hints.
2. Each step that triggers a config change names its `proposes` kind
   (e.g. `install_mcp`, `update_agent_tools`, `update_agent`).
3. Each step that produces a verifiable side effect names its
   `verify.tool` so the agent can confirm success.
4. The manifest schema is enforced by
   `scripts/check-integration-manifests.mjs` (runs on lint).

ADR: [0010](../docs/adr/0010-agent-led-setup-and-integration-manifests.md).

---

## Branding the app

Jarela is published as `@circuitwall/jarela` on npm. Brand overlays (e.g.
internal forks) consume the package and override identity strings via
environment variables — no code change required.

| Env var                          | Drives                         |
|----------------------------------|--------------------------------|
| `NEXT_PUBLIC_APP_NAME`           | UI title, page titles, PWA name |
| `NEXT_PUBLIC_APP_DESCRIPTION`    | Meta description, install help |
| `NEXT_PUBLIC_APP_ISSUE_URL`      | "Report a bug" link in footer  |

The data directory follows the brand: an overlay with `JARELA_DB_DIR=~/.foo`
gets isolated state. There's a one-shot rename from `~/.langgui` → `~/.jarela`
on first launch (kept around for in-place migration).

If you need richer overlay behaviour (e.g. injected CSS, alternate icon
set, additional preflight steps), the current pattern is to consume the
package's `.next/standalone` build and apply tree-level mutations during
your own build pipeline. There is no sanctioned "code hook" for overlays
yet — open an issue if you need one.

ADR: [0005](../docs/adr/0005-rebrand-jarela.md).

---

## Agent introspection tools

The agent can introspect every extension surface above without any
out-of-band knowledge:

- `list_tools` — every tool currently in the pool, with category,
  capability, source. Filter by category / capability / source.
- `list_providers`, `describe_provider({ name })` — registered LLM
  providers and their static capabilities + known-model context windows.
- `list_mcp_servers` — configured MCP servers with enabled state, last
  error, transport, and tool count.
- `describe_extension_surfaces` — the curated catalog (mirrors this
  document) with registration entrypoints and doc anchors.
- `list_integrations`, `get_integration_setup({ id })` — agent-led setup
  manifests (the highest-level extension recipe).

When the user asks "what can you do" or "how do I add an X," the agent
should call these instead of describing the system from memory.
