# Changelog

All notable changes to `@circuitwall/atlassian-langchain` are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] — 2026-06-13

### Added

- Initial release. Extracted from
  [Jarela](https://github.com/CircuitWall/jarela)'s `lib/tools/atlassian.ts`.
- 64 LangChain tools covering Jira Cloud and Confluence Cloud:
  - **Jira (42 tools)**: issue CRUD, JQL search, transitions, comments,
    attachments, worklogs, changelog, links (issue + remote), boards, sprints
    (CRUD + move + rank), backlog, projects, versions, components,
    create-meta + custom-field resolution.
  - **Confluence (22 tools)**: page CRUD, page-by-title, children, ancestors,
    space listing, CQL search, comments CRUD, attachments (list + upload +
    download + delete), labels (add + remove + list), page move.
- `setAuthResolver()` for plugging in your own credential provider.
- Default env-var resolver (`ATLASSIAN_URL` / `ATLASSIAN_EMAIL` /
  `ATLASSIAN_API_TOKEN`) when no resolver is set.
- Pure helpers exported for reuse: `confluenceTextToStorage`,
  `parseV2NextCursor`, `resolveCustomFieldNames`, `extractFieldValue`,
  `validateSprintTransition`.
- Lower-level `atlassianFetch(auth, path, init)` for callers that need to
  hit endpoints not yet wrapped as tools.
- Read/write/execute capability arrays
  (`atlassianReadTools`, `atlassianWriteTools`, `atlassianExecuteTools`)
  for agents that want to gate by capability.

[0.1.0]: https://github.com/CircuitWall/jarela/releases/tag/atlassian-langchain-v0.1.0
