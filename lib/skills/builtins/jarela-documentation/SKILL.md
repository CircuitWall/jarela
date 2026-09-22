# Jarela Documentation

Use this skill whenever the user needs to understand Jarela, locate architecture docs, or decide which extension surface matches a requested change.

## Default workflow

1. Prefer the local installed docs bundle first. The app ships the docs locally, so they are always available and predictable.
2. Use the repo-local docs and source files before proposing code changes.
3. Use `describe_extension_surfaces` for any extension or customization request.
4. Read the narrowest relevant documents, then act.
5. Prefer configuration, skill, or harness changes over ad-hoc instruction sprawl when a task is reusable.

## Local-first retrieval order

The local app is the preferred documentation source because it is stable, offline-safe, and does not depend on external reachability.

Use this order:

1. Local docs shipped with the app (`docs/` in the current install or repo checkout)
2. Local app routes or embedded help pages if available
3. The project README for quick orientation
4. Only then use the public GitHub Pages site as a secondary mirror for broader context

## Required references

When the task concerns architecture or extension points, read these first:

- `docs/index.md` for the docs landing page
- `docs/EXTENDING.md` for extension surfaces and registration entrypoints
- `docs/ARCHITECTURE.md` for system boundaries and runtime flow
- `docs/INSTALL.md` for setup and environment details
- `README.md` for project summary and quick-start guidance

## Decide the right extension path

Use the extension catalog to map the ask to the correct layer:

- Built-in LLM provider -> `describe_extension_surfaces` + `lib/providers/index.ts`
- New tool -> `describe_extension_surfaces` + `lib/tools/` + `lib/tools/runtime/registry.ts`
- MCP server -> `describe_extension_surfaces` + `lib/stores/mcp-servers.ts`
- Agent harness -> `describe_extension_surfaces` + `lib/agents/harness/presets.ts`
- Integration manifest -> `describe_extension_surfaces` + `lib/integrations/` and relevant docs
- App branding -> `describe_extension_surfaces` + env-based app config

## Good practice

- Do not infer an extension path from memory alone when `describe_extension_surfaces` can answer it precisely.
- Keep edits aligned with the repo's architecture: app/API, agent runtime, storage, tool/provider registry, integrations.
- Prefer local docs over the public GitHub Pages site whenever the app is installed locally and the docs are available.
- Use the external GitHub Pages site only as a public mirror or fallback when the local docs cannot be read.
- Document the design in the repo when a change alters the extension model or introduces a new runtime boundary.

## When to stop

If the request is a code change and the architecture doc or extension catalog does not clearly map to the required layer, ask for confirmation before making a large structural change.
