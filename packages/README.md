# Workspace packages

This directory holds standalone npm packages published under the
`@circuitwall/*` scope from this monorepo. Each subdirectory is a separate
package with its own `package.json`, `README.md`, and `CHANGELOG.md`.

## Why a monorepo

Jarela's `lib/` contains several pieces that have value outside the app
itself — most notably the Atlassian (Jira / Confluence) tool adapters, the
LLM pricing catalog, and the redaction pipeline. Publishing them as
standalone packages lets:

1. **Jarela consume them via workspace symlinks** during development,
   so any change is immediately exercised by the app — far better feedback
   than the "publish to npm, bump consumer, observe" cycle.
2. **External users install only what they need** — e.g. a LangGraph user
   who wants Jira tools without the rest of Jarela.
3. **Each package version independently**, since adapter packages
   (e.g. `@circuitwall/jira-langchain`) move at LangChain's pace while the
   underlying client (`@circuitwall/jira-client`) is stable.

## Layout

```
packages/
  <name>/
    package.json
    README.md
    CHANGELOG.md
    src/
    dist/        (gitignored — build output)
```

Packages declare workspace dependencies on each other with
`"dependencies": { "@circuitwall/foo": "workspace:^" }`. npm rewrites
`workspace:^` to the published version range at publish time.

## Adding a new package

Open an ADR first if the package is non-trivial. The general checklist:

1. `mkdir packages/<name>` and add `package.json`, `tsconfig.json`,
   `README.md`, `CHANGELOG.md`.
2. Inherit from the shared base configs (see existing packages for the
   pattern).
3. Add the package's test glob to the root `vitest.config.ts` include
   array.
4. Register the npm package name with the `@circuitwall` org's OIDC
   Trusted Publishing config on npmjs.com (one-time manual step per new
   package name) before the first release.
5. Wire the package into the root release workflow.

## Releasing

Packages release on tag push, matching Jarela's existing release model
(see [CONTRIBUTING.md](../CONTRIBUTING.md#release-process)). Each package
tracks its own `MAJOR.MINOR.PATCH` in its `package.json`; bumps follow the
same Conventional Commits rules as Jarela.
