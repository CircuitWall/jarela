# ADR-0121: Optional tool and integration dependencies

Status: **Accepted**

Date: 2026-11-20

Related: [ADR-0010](./0010-agent-led-setup-and-integration-manifests.md)
(integration manifests), [ADR-0078](./0078-tool-integration-declaration.md)
(tool → integration declaration), [ADR-0111](./0111-dependable-core-user-owned-extensions.md)
(dependable core, user-owned extensions), [ADR-0120](./0120-copilot-sdk-delegate.md)
(Node-runtime prerequisite for the Copilot SDK delegate).

## Context

A Jarela tool can depend on code or binaries that are not part of the app:

- a Circuit Wall LangChain package (`@circuitwall/github-langchain`) that is
  resolved from the workspace when present and from
  `$JARELA_PACKAGES_DIR` when installed on demand;
- an operator-installed npm package described by a manifest under
  `$JARELA_PACKAGES_DIR/manifests/*.json`;
- a globally installed CLI (`@openai/codex`, `@anthropic-ai/claude-code`);
- a runtime binary an MCP server needs (`npx`, `uvx`, `docker`).

Today Jarela detects these only *after* the fact, and the failure modes are
inconsistent:

- a missing `@circuitwall/*` package makes `optionalTools()` return an empty
  list, so the package registers zero tools and the category silently has no
  tools instead of reporting a missing dependency;
- a missing CLI surfaces as `ENOENT` inside a tool result
  (`codex_delegate`, `claude_delegate`) or as an `unconfigured` health probe;
- an MCP server whose `uvx`/`npx` binary is absent fails at connect time and
  is recorded through `setMcpServerError`;
- the toggles that "enable" a tool or integration (built-in category, default
  package, npm manifest, drop-in tool, integration credentials) never check
  whether the underlying dependency exists. `listDefaultPackages()` already
  reports `installed`, but nothing acts on it.

The pieces needed to fix this already exist and should be reused rather than
duplicated: `package-install.ts` (managed npm install + pending approvals),
`package-allowlist.ts` (publisher trust), `optional-package.ts` (resolve at
call time so an install is live without a restart), and `probe-cache.ts`
(non-blocking readiness with a TTL and `unknown`-is-not-missing semantics).

## Decision

Introduce a **dependency declaration plus probe layer** that every enabling
surface consults, and require installs to be explicit.

1. A dependency is declared as data next to the capability that needs it, in
   one zod schema (`lib/dependencies/schema.ts`).
2. A *probe* answers "is it installed?" without side effects. Probes are
   cached, single-flight, and never throw.
3. A *plan* turns a target (`tool:<name>`, `integration:<id>`,
   `package:<id>`, `manifest:<name>`, `mcp:<name>`) into
   `ready`, `install_required`, `manual`, or `unverified`.
4. Features are **disabled before enabling**, not after failing: the tool
   catalog and the execution guard consult the probe, so a tool whose
   dependency is missing is never bound to a model.
5. **Nothing installs during a probe.** Installing requires an explicit
   request. Allowlisted publishers (`package-allowlist.ts`) install on that
   request; non-allowlisted *managed* packages join the existing
   `package-install.ts` approval queue; non-allowlisted *global* installs are
   refused with the exact command, because approving a global install is an
   operator action outside Jarela's package queue.

### Enabling surfaces that consult the plan

`gateEnable(target, { installMissing })` is the single decision point:

| Surface | Target | Effect while a dependency is missing |
| --- | --- | --- |
| `POST /api/v1/packages/defaults/[id]` | `package:<id>` | `409 dependency_blocked` with the plan, flag untouched |
| `POST /api/v1/packages/manifests/[name]/enabled` | `manifest:<name>` | same |
| `propose_config_change(enable_integration)` | `integration:<id>` | proposal fails with the install hint (check-only) |
| `GET /api/v1/dependencies?target=` | any | read-only plan |
| `POST /api/v1/dependencies/install` | any | runs the plan, then re-probes |

`install_missing` defaults to true for the package toggles: an explicit enable
is the request to obtain what it needs. Integrations stay check-only so saving
credentials never triggers an install.

### Dependency kinds (v1)

| Kind | `id` | Satisfied when | Install |
| --- | --- | --- | --- |
| `node-package` (`scope: managed`) | npm name | resolvable from `$JARELA_PACKAGES_DIR` | `npm install --save` in the packages dir |
| `node-package` (`scope: workspace`) | npm name | resolvable from the app root | same managed install |
| `node-package` (`scope: global`) | npm name | `bin` found on `PATH`, else resolvable from an npm global root | `npm install -g` |
| `executable` | binary name | found on `PATH` | never (manual hint) |
| `node-runtime` | `"node"` | `process.version` satisfies `version` | never (manual hint) |

`python-package` and `container-image` are deliberately deferred. Their real
prerequisite is the runner (`uv`/`uvx`, `docker`), which the `executable` kind
already models honestly; claiming to install a container image or a Python
distribution would add an installer surface with no consumer yet.

### Gating layers

The existing three-layer pattern (catalog → permission map → execution) is
extended rather than replaced:

- `ToolCatalogEntry.dependencies` carries the probed status; `status_reason`
  gains `dependency_missing` (installable) and `dependency_manual`.
- `applyAgentPermissionsToCatalog` marks those tools `unavailable`, so they
  are never bound.
- `executeTool` refuses with the install hint, protecting stale agent
  configs.

`unverified` (probe failed or has not run yet) never hides a tool, matching
`probe-cache.ts`: a transient failure must not make an agent's toolset
disappear mid-conversation.

### Explicit non-goals

- No shell execution: installers use `cross-spawn` with argv arrays.
- No system-package installs (`winget`/`brew`/`apt`): elevation, licensing and
  supply-chain reasons keep those `manual`.
- No new SQLite table. Probe state is in-memory; install history stays on the
  filesystem under `$JARELA_PACKAGES_DIR`.
- No automatic dependency recursion: `uvx` is itself an `executable`
  dependency, resolved explicitly where a pypi MCP server is declared.

## Consequences

### Positive

- A missing dependency is a *state* the UI and the agent can act on, with a
  concrete install action, instead of an `ENOENT` mid-turn.
- Uninstalled optional capabilities stop polluting the tool catalog and stop
  registering empty packages.
- The trust model, allowlist, approval queue, and reload path are shared with
  the existing package installer.

### Negative / costs

- Every enabling surface and the catalog gain a dependency check; probes must
  stay cheap (PATH scan, `require.resolve`) and cached.
- Default packages must declare `dependencies` centrally; a descriptor without
  a declaration keeps today's behavior (no gating) rather than guessing.
- Two new manifest fields (`dependencies` on integration manifests and npm
  package manifests) become part of the documented extension contract.

## More Information

- Implementation: `lib/dependencies/` (`schema`, `probe`, `plan`, `index`).
- Registry surface: `registerTools(..., dependencies?)`,
  `registerLangChainPackage({ dependencies })`, `setToolDependencies`.
- Gating: `lib/tools/runtime/catalog.ts` (`unconfiguredReason`),
  `lib/tools/runtime/runtime.ts` (`executeTool`).
- Health precedent: `lib/health/probe-cache.ts`.
- Install precedent: `lib/tools/packages/package-install.ts`,
  `lib/tools/packages/package-allowlist.ts`.
