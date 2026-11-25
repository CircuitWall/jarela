# Workspace package guidance

These rules apply to every package under `packages/`. Repository-wide rules in
the root [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md)
still apply.

## Boundary

- Packages are standalone npm artifacts. They must not import Jarela-private
  modules (`app/`, `lib/`, `components/`, `hooks/`, `api/`) or sibling package
  source.
- The host-side adapter seam stays in `lib/tools/packages/default-packages/`
  and `lib/providers/`; packages expose typed tools and clients only.
- A package may depend on another package with a `workspace:` range, but the
  built artifact must not rely on workspace symlinks at runtime.

## Layout and build

- Each package owns `package.json`, `README.md`, `CHANGELOG.md`, `src/`, `test/`
  (or co-located tests), and `tsconfig.json`.
- `npm run packages:build` runs each package's `build` script through
  `scripts/build-workspace-package.mjs`; keep the Node target aligned with the
  app's supported lines.
- Do not add package-specific copies of shared build logic. If the central
  build needs a package-specific option, extend the shared script.

## Testing

- Each package declares a `test` script. `npm run packages:test` invokes it in
  every workspace; package tests are not part of the root Vitest include.
- Add focused tests next to the source. Network/provider boundaries should be
  mocked or opt-in, matching the root testing rules.
- Run `npm run packages:test`, `npm run lint`, and the package build before
  opening a PR.

## Versioning and release

- The package's `package.json` is its semver source of truth. Follow
  Conventional Commits; a higher minimum Node version is a breaking change and
  needs the corresponding major (or pre-1.0 minor) bump.
- Releases run on tag push through the root release workflow. Do not publish
  from a developer machine, and register a new package name with the
  `@circuitwall` OIDC trusted-publishing configuration before its first release.
- Update the package `README.md` and `CHANGELOG.md` for user-visible changes;
  update the root provider/tool documentation when the package becomes a
  default integration.

## Adding a package

Open an ADR first if the package is non-trivial, then follow
[packages/README.md](./README.md#adding-a-new-package).
