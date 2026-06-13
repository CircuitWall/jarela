# Changelog

## [1.0.0] - 2026-06-13

### Changed

- **Promoted to 1.0.0.** The public surface (tool list, `setAuthResolver`
  hook, `githubFetch` / `_ghFetch` escape hatches, capability arrays,
  pure helpers) has been stable since `0.1.0` and is now consumed
  directly by Jarela itself (the wrapper file in `lib/tools/github.ts`
  was removed in Jarela 1.9.0). Bumping the major signals API stability
  — no source changes, no breaking changes, semver-major bump only.

## [0.1.0] - 2026-06-13

### Added
- Initial extraction from Jarela.
- 22 LangChain tools covering the GitHub REST API (issues, pull requests,
  repo content, code search).
- `setAuthResolver()` API for pluggable credential resolution.
- Default env-var resolver (`GITHUB_TOKEN`, then `GH_TOKEN`).
- `githubFetch()` low-level escape hatch (plus `_ghFetch` alias for
  consumers that ported from Jarela's internal name).
- Pure helpers `truncate()` and `decodeContentsBlob()` for reuse outside
  the LangChain tool wrappers.
- Pre-grouped capability arrays (`githubReadTools`, `githubWriteTools`,
  `githubExecuteTools`, `githubTools`).
