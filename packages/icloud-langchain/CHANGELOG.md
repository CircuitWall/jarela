# Changelog

All notable changes to this package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
