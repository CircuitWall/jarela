# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-21

### Added

- **`icloudReadTools` / `icloudWriteTools` / `icloudExecuteTools`
  bundles.** Splits the 17 tools by capability tier so host apps (e.g.
  Jarela's `registerLangChainPackage`) can grant agents read-only, full
  edit, or destructive access in the same shape used by
  `@circuitwall/atlassian-langchain`,
  `@circuitwall/github-langchain`, and
  `@circuitwall/jira-align-langchain`. The pre-existing
  domain-grouped bundles (`icloudMailTools`, `icloudCalendarTools`,
  `icloudReminderTools`, `icloudTools`) remain.

### Fixed

- **`icloud_mail_list_messages` with no filters returned `iCloud IMAP
  error: Command failed`.** Calling IMAP `SEARCH` with an empty
  criteria list is invalid per RFC 3501 §6.4.4, and iCloud's server
  replies `NO Command failed` instead of treating it as ALL. The tool
  now substitutes `{ all: true }` when the caller passes no
  `unseen_only` / `query` / `since` / `before`, matching the
  "give me the most recent N" use case the schema's `limit` parameter
  implies. Also guards the subsequent `client.fetch(uids, …)` against
  an empty UID set so a zero-result search returns `{ messages: [] }`
  instead of another IMAP error.

## [0.1.0] - 2026-06-20

### Added

- Initial release. LangChain tools for **iCloud Mail** (IMAP) and
  **iCloud Calendar / Reminders** (CalDAV), authenticated with an Apple
  ID plus an app-specific password generated at
  <https://appleid.apple.com>. No OAuth, no MCP — pure protocol calls
  via [`imapflow`](https://imapflow.com) and
  [`tsdav`](https://github.com/natelindev/tsdav), with iCal payloads
  parsed by [`ical.js`](https://github.com/mozilla-comm/ical.js).
- **Mail (7 tools)** — `icloud_mail_list_folders`,
  `icloud_mail_list_messages`, `icloud_mail_get_message`,
  `icloud_mail_create_draft`, `icloud_mail_move_message`,
  `icloud_mail_flag_message`, `icloud_mail_delete_message`. Draft
  creation uses IMAP `APPEND` into the SPECIAL-USE `\Drafts` folder;
  there is intentionally no `send_message` tool in this release.
- **Calendar (6 tools)** — `icloud_calendar_list_calendars`,
  `icloud_calendar_list_events`, `icloud_calendar_get_event`,
  `icloud_calendar_create_event`, `icloud_calendar_update_event`,
  `icloud_calendar_delete_event`.
- **Reminders (3 tools)** — `icloud_reminders_list`,
  `icloud_reminders_create`, `icloud_reminders_complete`. Reminders
  collections are CalDAV calendars whose
  `supported-calendar-component-set` advertises `VTODO`.
- **Auth resolver hook** — `setAuthResolver()` for embedders (Jarela,
  vault-backed apps) that manage credentials elsewhere. Default
  resolver reads `ICLOUD_APPLE_ID` + `ICLOUD_APP_PASSWORD` from the
  process environment.
- **Principal cache** — the first CalDAV call discovers the
  `current-user-principal` and `calendar-home-set` via `PROPFIND` and
  caches them per-resolver-result, so subsequent calls skip the
  discovery round-trips. iCloud occasionally omits
  `current-user-principal` on the first response; `tsdav` handles the
  retry transparently.
