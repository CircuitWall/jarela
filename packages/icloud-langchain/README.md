# @circuitwall/icloud-langchain

LangChain tools for **iCloud Mail** (IMAP/SMTP), **iCloud Calendar**, and
**iCloud Reminders** (CalDAV) — direct protocol calls, no MCP, no Apple
SDK (there isn't one for end-user data). Extracted from
[Jarela](https://github.com/CircuitWall/jarela) so any LangGraph /
LangChain.js agent can give an LLM the same iCloud toolbelt without
running the full Jarela stack.

Requires Node 24.15.0+ on Node 24.x, or Node 26.0.0+; Node 25 is not supported.

## Why

Apple does **not** ship an OAuth-protected REST API for a user's own
iCloud Mail / Calendar / Reminders. The only programmatic paths are the
internet standards Apple deliberately supports:

- Mail → **IMAP** (`imap.mail.me.com:993`, TLS)
- Mail sending → **SMTP** (`smtp.mail.me.com:587`, mandatory STARTTLS)
- Calendar → **CalDAV** (`caldav.icloud.com`, PROPFIND principal
  discovery)
- Reminders → **CalDAV** (VTODO collections under the same principal)

Auth = **Apple ID + an app-specific password** generated at
<https://appleid.apple.com> (2FA must be on). "Sign in with Apple" is
identity-only and cannot grant Mail / Calendar access.

This package wraps [`imapflow`](https://imapflow.com), [`nodemailer`](https://nodemailer.com),
[`tsdav`](https://github.com/natelindev/tsdav), and
[`ical.js`](https://github.com/mozilla-comm/ical.js) behind LangChain
tool definitions, with a pluggable auth resolver so embedders can
supply credentials from their own vault.

## Install

```bash
npm i @circuitwall/icloud-langchain @langchain/core zod
```

`@langchain/core` and `zod` are peer dependencies — bring whichever
versions your agent already uses (core ≥ 0.3, zod ≥ 3.23). `imapflow`,
`nodemailer`, `tsdav`, and `ical.js` are runtime dependencies and install
automatically.

## Quick start

```ts
import {
  setAuthResolver,
  icloudTools,
} from "@circuitwall/icloud-langchain";

// Option A — env vars (default). No setup needed if these are set:
//   ICLOUD_APPLE_ID=johnappleseed@icloud.com
//   ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

// Option B — supply your own resolver (e.g. read from a secrets store):
setAuthResolver(async () => ({
  appleId: "johnappleseed@icloud.com",
  appPassword: await vault.read("icloud/app-password"),
}));

// Hand the tools to your agent:
import { createReactAgent } from "@langchain/langgraph/prebuilt";
const agent = createReactAgent({
  llm: yourModel,
  tools: icloudTools,
});
```

Each tool resolves auth lazily on every call, so it's safe to import
the tools at module load and configure the resolver later.

## Mail indexing adapter

`scanICloudMail(auth, options, onMessage)` reads mail without invoking an agent
tool. It accepts an explicit `ICloudAuth`, `scope` (`inbox`, `folder`, or `all`),
an optional folder path and subject/body text query, and optional positive
`maxResults`. Without a limit it visits all matches. Whole-mailbox scans include
all selectable folders, including spam and trash. Each scan opens one IMAP
connection, locks folders read-only, and awaits `onMessage` for each message.
It downloads up to 40,000 bytes of the preferred inline text/plain or text/html
body, never attachments, and throws on scan or callback failure. Callback
identities use Message-ID where available, with mailbox/UIDVALIDITY/UID as a
fallback. A UID fallback cannot deduplicate a message moved to another folder.
HTML is marked for the host to convert to plain text before indexing.

The capability exports follow the same rules as Jarela's Gmail/Outlook tools:
reads are `read`; drafts, moves, flags, trash, and calendar deletion are `write`.
`icloudExecuteTools` contains `icloud_mail_send_email`. Trash and
calendar deletion previously belonged to `execute`; hosts using capability
approvals should review this alignment before upgrading.

## Generating the app-specific password

1. Sign in at <https://appleid.apple.com>.
2. Make sure **two-factor authentication is enabled** — the
   "App-Specific Passwords" section only appears when 2FA is on.
3. Open **Sign-In and Security → App-Specific Passwords →
   Generate a password**.
4. Name it (e.g. `Jarela`) and copy the 16-character value. It's
   shown only once — store it in your vault before closing the page.
5. Either set `ICLOUD_APP_PASSWORD` to that value, or pass it
   through your custom `setAuthResolver()`.

You can revoke the password at any time from the same page — it
immediately invalidates this package's access without affecting any
other client.

## SMTP sending

`icloud_mail_send_email` sends immediately and belongs to the `execute`
capability bucket. In Jarela, explicitly enable the tool for the agent; it is
not a Basic-default tool. Like Gmail/Outlook sending, it must only be used when
the user asks to send now; use `icloud_mail_create_draft` for review instead.
Capability classification and tool permissions do not add a per-send
confirmation dialog. Standalone package hosts must enforce their own approvals.

Reuse the existing Apple ID/app-specific password resolver. SMTP authenticates
with a **full iCloud Mail address**, not the IMAP short username. When the Apple
ID is not the mail address, set optional `ICloudAuth.mailAddress` (Jarela:
Credentials → iCloud → iCloud Mail address) or `ICLOUD_MAIL_ADDRESS` alongside
the environment credentials. Otherwise `@icloud.com`, `@me.com`, or `@mac.com`
Apple IDs are used directly. Custom-domain mail addresses must be configured
explicitly and authorized on the account. The configured SMTP address is also
the sender; tool callers cannot override it.

Inputs: `to`, optional `cc`/`bcc`, `subject`, `body`, optional `content_type`
(`text` or `html`), and optional `in_reply_to` (the parent's RFC Message-ID,
including angle brackets). Bodies are limited to 100,000 characters.
Nodemailer handles MIME, Unicode headers, and BCC envelope delivery; no custom
SMTP or MIME encoder is added. Attachments, URL/file content loading, and
arbitrary transport settings are not exposed.

Output: `ok: true`, `status: accepted_by_smtp`, `message_id`, and
`accepted_count` mean SMTP acceptance, **not confirmed delivery**. Partial
acceptance returns an error plus accepted/rejected recipients so callers avoid
resending to accepted recipients. Network failures may occur after acceptance:
never automatically retry without checking delivery. Authentication failures
provide reconnect guidance without returning server responses or credentials.
The IMAP folder setup probe and CalDAV health probe do not verify SMTP access.
The tool does not append a separate Sent-folder copy; verify your account's
server-side Sent behavior if you need archival copies.

Provider/protocol references reviewed 2026-10-26:
[Apple server settings](https://support.apple.com/en-us/102525),
[app-specific passwords](https://support.apple.com/en-us/102654), and
[Nodemailer SMTP](https://nodemailer.com/smtp),
[message configuration](https://nodemailer.com/message), and
[send results](https://nodemailer.com/#response-object).

## What's included (18 tools)

### Mail (8)

- `icloud_mail_list_folders` — folder tree with message and unread
  counts, plus the IMAP SPECIAL-USE flag (`\Drafts`, `\Sent`,
  `\Trash`, `\Junk`, `\Archive`) for stable cross-locale lookup.
- `icloud_mail_list_messages` — IMAP `SEARCH` over a folder
  (`query`, `unseen_only`, `since`, `before`, `limit`), most-recent
  first.
- `icloud_mail_get_message` — full envelope, plain-text body
  (HTML opt-in via `include_html`), and an attachments index.
- `icloud_mail_create_draft` — IMAP `APPEND` into the Drafts
  folder. Open the draft in Apple Mail to review and send.
- `icloud_mail_send_email` — explicitly requested immediate SMTP sending
  (text/HTML, CC/BCC, and RFC reply threading).
- `icloud_mail_move_message`, `icloud_mail_flag_message`,
  `icloud_mail_delete_message` — standard mailbox operations.
  `delete_message` resolves the localised Trash folder via the
  `\Trash` SPECIAL-USE flag.

### Calendar (6)

- `icloud_calendar_list_calendars` — VEVENT calendar collections
  with URL, display name, and color.
- `icloud_calendar_list_events` — `time_min` / `time_max` window
  via CalDAV `REPORT calendar-query`.
- `icloud_calendar_get_event` — full event including raw
  iCalendar source.
- `icloud_calendar_create_event` — create an event (supports
  all-day with `all_day: true`, recurrence `rrule`, primary/secondary `alerts`, Apple `travel_time`, `url`, `status`, and `availability`).
- `icloud_calendar_update_event` — patch summary / time /
  location / description / recurrence (`rrule`) / `alerts` / `travel_time` / `url` / `status` / `availability` in place.
- `icloud_calendar_delete_event` — delete by UID.

### Reminders (3 + 1 lister)

- `icloud_reminders_list_lists` — VTODO calendar collections.
- `icloud_reminders_list` — items in a list, with
  `include_completed`.
- `icloud_reminders_create` — new VTODO with optional `due`.
- `icloud_reminders_complete` — mark VTODO as `COMPLETED`.

Use the convenience bundles `icloudMailTools`,
`icloudCalendarTools`, `icloudReminderTools`, or `icloudTools` (all
three combined) to hand the lot to an agent.

## Auth resolver

```ts
import {
  type ICloudAuth,
  type AuthResolver,
  setAuthResolver,
  resolveICloudAuthFromEnv,
} from "@circuitwall/icloud-langchain";

// The default resolver reads ICLOUD_APPLE_ID + ICLOUD_APP_PASSWORD.
// Replace it to plug in your own credential source:
const fromVault: AuthResolver = async () => {
  const row = await db.getICloudCredential(currentUserId);
  if (!row) return { error: "iCloud credential not configured for this user." };
  return { appleId: row.apple_id, appPassword: row.app_password };
};
setAuthResolver(fromVault);
```

The resolver may be sync or async. Whitespace, hyphens, and
zero-width characters are stripped from the returned `appPassword`
before use, so you can store the value either as Apple presents it
(`xxxx-xxxx-xxxx-xxxx`) or pre-stripped.

## Known limitations

- **No SMTP attachments or automatic Sent-folder append.** Use drafts for
  review; check account-side Sent behavior if you need a saved copy.
- **No push notifications.** iCloud does not advertise CalDAV
  WebPush or APNS for mail. Poll on whatever interval suits your
  agent (every 5–15 minutes is the standard pattern).
- **Recurring-event instance edits are not supported.** Updates
  and deletes apply to the entire series. Per-instance edits
  require `RECURRENCE-ID` + `EXDATE` plumbing that isn't in this
  release.
- **iCloud rate-limits aggressive IMAP IDLE.** Each tool call
  opens a fresh connection and logs out, so this package is safe
  by default; do not wrap it in a long-lived IDLE loop without
  reading the iCloud server policy first.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
