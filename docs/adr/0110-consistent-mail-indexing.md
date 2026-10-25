# ADR-0110: Consistent opt-in mail indexing

Status: Accepted

## Context

Gmail and Outlook document sources require provider-native search queries.
iCloud has IMAP tools but no document indexer. Users cannot consistently select
an Inbox, another folder/label, or a whole mailbox.

## Decision

Use the existing document source table, JSON config, encrypted credentials, and
scheduler for all three providers. Add the `icloud_mail` source kind. New mail
sources specify `scope` (`inbox`, `folder`, or `all`), an optional `folder`,
optional provider-native `query`, optional positive `max_results`, and optional
`page_size` (1-100). Folder scopes require a folder identifier.

New scoped sources default to unlimited coverage and `retention: archive`.
Archive refreshes upsert current matches but keep previously indexed messages,
including messages moved or deleted upstream. Removing the source deletes its
local archive. An explicit `retention: mirror` removes nonmatching documents
only after a successful scan. Existing query-only Gmail/Outlook sources retain
their default 250-result limit, 5,000-result cap, and mirror behavior.

Gmail uses label IDs (resolving exact label names), Outlook uses folder IDs or
well-known folder names, and iCloud uses IMAP mailbox paths. Whole-mailbox scans
include spam/trash and other selectable folders. No new credential permissions
or storage location is introduced. iCloud scanning uses one read-only IMAP
connection per sweep and bounded body downloads. Outlook scoped sources request
immutable IDs; iCloud document identities use Message-ID where available, with
mailbox/UIDVALIDITY/UID fallback.

The existing scheduler refreshes enabled sources approximately every ten
minutes while the app is running and unlocked. Complete scans follow provider
pagination; Outlook text search remains subject to Graph's 1,000-result ceiling
and must report that ceiling rather than claim complete coverage.

## Validation

Mocked provider tests verify scope requests, pagination, limits, archive
retention, legacy defaults, and failures. API tests reject invalid source
settings. UI tests verify provider availability, query-free Inbox consent, and
folder validation. IMAP tests verify read-only locks, UID-based reads, stable
identities, and connection cleanup.

## References

Reviewed 2026-10-25:

- https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/graph/search-query-parameter
- https://support.apple.com/en-us/102525
- Installed `imapflow` type declarations for IMAP operations.
