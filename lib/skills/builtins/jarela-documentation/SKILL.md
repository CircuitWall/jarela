---
name: jarela-documentation
description: "Use when: answering Jarela usage questions, finding version-scoped documentation, or choosing a supported extension surface."
---

# Jarela Documentation

Use this skill whenever the user needs to understand Jarela, locate architecture docs, or decide which extension surface matches a requested change.

## Input

The user's question, installed app/package version when observable, available
local documentation/source and permitted retrieval tools.

## Output

A source-backed answer or extension recommendation with file/section or URL
references, applicable version and explicit unknowns. Keep released behavior,
Unreleased changes and roadmap proposals separate.

## Validation

Read the cited material and check it answers the question for the relevant
version. A source path is not evidence that the file exists in this installation.
When material is absent, stale or inaccessible, state the gap; do not invent
local docs or claim a proposed capability exists. Reading documentation is not
runtime testing. Report denied retrieval or cancellation without bypassing it.
Do not upload private source, logs or credentials to a public documentation site
or include secrets in external search queries.

## Default workflow

1. Check for local documentation first. A source checkout and an installed
   package can ship different subsets; do not assume the full bundle exists.
2. Use the repo-local docs and source files before proposing code changes.
3. Use `describe_extension_surfaces` for any extension or customization request.
4. Read the narrowest relevant documents, then act.
5. Prefer configuration, skill, or harness changes over ad-hoc instruction sprawl when a task is reusable.
6. Verify optional tool schemas and the running installation before using
   Unreleased documentation. An open PR, approved ADR direction or passing
   source test does not establish that the user's installation has the feature.

## Local-first retrieval order

The local app is the preferred documentation source because it is stable, offline-safe, and does not depend on external reachability.

Use this order:

1. Available local docs (`docs/` in the current install or repo checkout)
2. Local app routes or embedded help pages if available
3. The project README for quick orientation
4. Only then use the public GitHub Pages site as a secondary mirror for broader context

## Required references

When the task concerns architecture or extension points, read the relevant
references below when available; identify missing/version-mismatched material
instead of assuming an installed package contains a source checkout:

- `docs/index.md` for the docs landing page
- `docs/EXTENDING.md` for extension surfaces and registration entrypoints
- `docs/ARCHITECTURE.md` for system boundaries and runtime flow
- `docs/INSTALL.md` for setup and environment details
- `README.md` for project summary and quick-start guidance

## Decide the right extension path

Use the extension catalog to map the ask to the correct layer:

- Built-in LLM provider -> `describe_extension_surfaces` + `lib/providers/builtins.ts` and `lib/providers/registry.ts`
- New tool -> `describe_extension_surfaces` + `lib/tools/` + `lib/tools/runtime/registry.ts`
- MCP server -> `describe_extension_surfaces` + `lib/stores/mcp-servers.ts`
- Agent harness -> `describe_extension_surfaces` + `lib/agents/harness/presets.ts`
- Integration manifest -> `describe_extension_surfaces` + `lib/integrations/` and relevant docs
- App branding -> `describe_extension_surfaces` + env-based app config
- Shared skill bundle -> `list_skills`, `read_skill` and the installed schemas;
  inspect optional metadata/resources only where supported. `SKILL.md` source
  sharing does not certify identical execution semantics in another host.
- Checked skill execution/consent -> `docs/adr/0112-checked-javascript-skill-execution.md`
  and installed runtime/Privacy & security surfaces. Separate inert inspection,
  stored checksum approval and an actual runner; none proves the next exists.
- In-chat interaction panel -> distinguish a design proposal from implemented
  approval or question tools. Do not claim arbitrary forms, durable pause/resume
  or workflow consent are available without an installed validated contract.

## Good practice

- Do not infer an extension path from memory alone when `describe_extension_surfaces` can answer it precisely.
- Keep edits aligned with the repo's architecture: app/API, agent runtime, storage, tool/provider registry, integrations.
- Prefer local docs over the public GitHub Pages site whenever the app is installed locally and the docs are available.
- Use the external GitHub Pages site only as a public mirror or fallback when the local docs cannot be read.
- Document the design in the repo when a change alters the extension model or introduces a new runtime boundary.

## When to stop

If the request is a code change and the architecture doc or extension catalog does not clearly map to the required layer, ask for confirmation before making a large structural change.
