# Changelog

## [0.1.0] - 2026-06-13

### Added
- Initial extraction from Jarela.
- 22 LangChain tools covering Jira Align v2 (work items, comments, hierarchy
  entities, dependencies).
- `setAuthResolver()` API for pluggable credential resolution.
- Default env-var resolver (`JIRA_ALIGN_URL`, `JIRA_ALIGN_TOKEN`).
- `jiraAlignFetch()` low-level escape hatch.
- Pre-grouped capability arrays (`jiraAlignReadTools`,
  `jiraAlignWriteTools`, `jiraAlignExecuteTools`, `jiraAlignTools`).
