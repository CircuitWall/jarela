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

### Message content and attachments

Tools and providers exchange message content through `ContentPart` from
`@circuitwall/jarela/lib/tools/types`:

- `text` carries plain user-visible text.
- `image` is the legacy inline base64 image form. New persisted paths should
  prefer `image_ref`.
- `image_ref` points at a content-addressed file under `~/.jarela/files/`,
  served by `GET /api/v1/files/[name]` and materialized to provider bytes only
  when the active model call needs vision input.
- `file` carries inline text file content. Keep this for small text-like files
  whose contents should enter the prompt.
- `file_ref` points at a binary file under `~/.jarela/files/`. Use this for
  PDFs, audio, video, and other binary files so chat-run JSON stays small.

External tools that produce large binary artifacts should write them through
the file store and return a ref-shaped content part or a `/api/v1/files/[name]`
URL. Do not embed large base64 blobs in normal chat/run payloads.

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

Jarela is published as `@circuitwall/jarela` on npm and licensed Apache-2.0.
Brand overlays (internal forks, white-label deployments) override identity
through configuration and assets — **no source edits**, so there is no rename
diff to rebase on every upstream release.

### You need a build you control

Read this before planning a rollout. The web app's brand values are
`NEXT_PUBLIC_*` env vars, which Next **inlines textually during `next build`**.
They are not read at runtime.

The npm package ships a *prebuilt* `.next/standalone`, already carrying the
Jarela name. So `npm i @circuitwall/jarela && jarela start` **cannot** be
rebranded by setting env vars — the strings are baked in, and `jarela-bin.mjs`
deliberately refuses to rebuild from inside `node_modules` (webpack excludes
that path). Rebranding the web app therefore means running the build yourself:

- **Fork and rebase.** Clone the repo, add `.env.production` with your
  `NEXT_PUBLIC_APP_*` values, drop your assets into `public/`, run
  `npm run build`. Your diff against upstream is config and assets only, so
  tracking each release stays cheap. This is the common case.
- **Wrapper repo.** Keep only `brand.json`, `.env.production`, and logos in
  your repo; have CI check out Jarela at a pinned tag, apply your env, build,
  and publish the artifact. Cleaner ownership boundary, same build step.

Runtime-switchable branding (no rebuild) is **not** supported — it would mean
serving brand config from an API and fetching it on boot. See ADR-0077.

The browser extension is the exception: its build is a packaging step over
static files, so it needs no Next build.

Accordingly the two surfaces differ: the web app reads build-time env vars,
while the browser extension takes a `brand.json` packaging step (its MV3
manifest and icons are static files).

### Web app: `NEXT_PUBLIC_APP_*`

Everything lives in [`lib/env/app-config.ts`](../lib/env/app-config.ts),
exported as the public subpath `@circuitwall/jarela/lib/env/app-config`.

| Env var                                    | Drives                                           |
|--------------------------------------------|--------------------------------------------------|
| `NEXT_PUBLIC_APP_NAME`                     | Page title, PWA `name`, notification titles       |
| `NEXT_PUBLIC_APP_SHORT_NAME`               | PWA `short_name` (defaults to the app name)       |
| `NEXT_PUBLIC_APP_DESCRIPTION`              | Meta description, PWA `description`               |
| `NEXT_PUBLIC_APP_ISSUE_URL`                | "Report a bug" link — **your** tracker            |
| `NEXT_PUBLIC_APP_LOGO_LIGHT`               | In-app wordmark on light surfaces                 |
| `NEXT_PUBLIC_APP_LOGO_DARK`                | Wordmark on dark surfaces (defaults to the light one) |
| `NEXT_PUBLIC_APP_ACCENT_COLOR`             | `--color-accent` (hex only)                       |
| `NEXT_PUBLIC_APP_ACCENT_HOVER_COLOR`       | `--color-accent-hover` (defaults to accent −15% lightness) |
| `NEXT_PUBLIC_APP_FAVICON_SVG` / `_ICO`     | Favicon                                           |
| `NEXT_PUBLIC_APP_ICON_192` / `_512`        | PWA icons (`any` purpose)                         |
| `NEXT_PUBLIC_APP_ICON_192_MASKABLE` / `_512_MASKABLE` | PWA icons (`maskable` purpose)         |
| `NEXT_PUBLIC_APP_ICON_192_LIGHT` / `_512_LIGHT` (+ `_MASKABLE_LIGHT`) | Light-background icon variants |
| `NEXT_PUBLIC_APP_APPLE_TOUCH_ICON`         | iOS home-screen icon                              |

The simplest icon/logo swap is to **drop replacement files into `public/`
under the same names** — then you need none of the asset env vars. Set them
only when your assets live on other paths or a CDN.

Two things to know:

- These are inlined by Next at **build time**, so changing the brand means a
  rebuild, not a restart.
- The accent color must be a hex literal — 6-digit (`#7c3aed`) or 3-digit
  (`#7c3`). It is injected into a `<style>` block, so anything else is
  rejected and ignored.

The data directory follows the brand too: `JARELA_DB_DIR=~/.foo` gets isolated
state.

### Browser extension: `brand.json` + `npm run build:extension`

```bash
npm run build:extension -- --brand ./brand.json --out dist/my-extension
```

```jsonc
// brand.json — all keys optional
{
  "name": "Acme Assistant",
  "shortName": "Acme",
  "description": "Browser companion for Acme Assistant: …",
  "accentColor": "#7c3aed",
  "logo": "./brand/mark.png"   // toolbar icons are regenerated from this
}
```

This emits a ready-to-load extension folder with a templated `manifest.json`
(name, description, toolbar title, command description), a regenerated
`lib/brand.mjs`, and rebuilt icons. Run without `--brand` and the output
matches the in-tree Jarela extension (a test enforces this).

See [`browser-extension/README.md`](../browser-extension/README.md#rebranding).

### What you may not rebrand

Rebranded builds keep a small **"Powered by Jarela"** link — on the web boot
screen and the extension options page — pointing at the upstream repository.
`UPSTREAM_NAME` / `UPSTREAM_URL` are plain constants, not env vars, and
`build-extension.mjs` never templates them. The credit renders **only** once
you have actually renamed the app; the upstream build shows nothing.

This is separate from `NEXT_PUBLIC_APP_ISSUE_URL`, which is yours to redirect.
Upstream-facing machinery (update checks, tool-telemetry issue drafts) also
keeps pointing at `CircuitWall/jarela`.

Internal identifiers stay `jarela*` on both surfaces — DOM ids, `chrome.storage`
keys, CSS class/keyframe names, `globalThis` keys, DB tables. They are not
product names, and renaming them orphans stored config.

### Beyond the accent color

If you need deeper visual changes than one accent color, the pattern is still
to consume the package's `.next/standalone` build and apply tree-level
mutations in your own pipeline. Blessing arbitrary CSS overrides would turn
internal class names into a public API.

ADR: [0077](../docs/adr/0077-rebranding-overlay-contract.md), building on
[0005](../docs/adr/0005-rebrand-jarela.md).

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
