# Changelog

## [0.1.0] - 2026-06-16

### Added
- Initial extraction from Jarela.
- 12 LangChain tools covering the Microsoft To Do surface of Microsoft
  Graph (`/me/todo`): list/create/update/delete task lists,
  list/get/create/update/complete/delete tasks, plus checklist sub-item
  read/add.
- `setAuthResolver()` API for pluggable credential resolution; default
  env-var resolver does the OAuth2 refresh-token dance internally
  (`MS_TODO_CLIENT_ID`, `MS_TODO_CLIENT_SECRET`,
  `MS_TODO_REFRESH_TOKEN`, optional `MS_TODO_TENANT`).
- `graphFetch()` low-level escape hatch for endpoints not yet wrapped
  as tools.
- Pre-grouped capability arrays (`msTodoReadTools`, `msTodoWriteTools`,
  `msTodoTools`).
