# Changelog

## [1.0.1] - 2026-10-08

### Fixed

- `jira_align_search_items` filters features by `additionalProgramIds` when
  `program_id` is given, instead of the `programId` field that features do not
  expose.
- `jira_align_list_entities` filters releases by `title` when `name_filter` is
  given, instead of `name`.

## [1.0.0] - 2026-06-13

### Changed

- **Promoted to 1.0.0.** The public surface (tool list, `setAuthResolver`
  hook, `jiraAlignFetch` escape hatch, capability arrays) has been
  stable since `0.1.0` and is now consumed directly by Jarela itself
  (the wrapper file in `lib/tools/jira-align.ts` was removed in Jarela
  1.9.0). Bumping the major signals API stability — no source changes,
  no breaking changes, semver-major bump only.

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
