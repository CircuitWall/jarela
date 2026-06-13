# Changelog

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
