/**
 * Native iCloud tools — IMAP for Mail, CalDAV for Calendar and Reminders.
 * No MCP. No Apple-specific SDK (none exists for end-user data).
 *
 * Why this exists: Apple does not publish an OAuth-protected REST API for
 * a user's own iCloud Mail / Calendar / Reminders. The only programmatic
 * paths are the standards Apple deliberately supports:
 *   - Mail        → IMAP   (imap.mail.me.com:993, TLS)
 *   - Calendar    → CalDAV (caldav.icloud.com, PROPFIND discovery)
 *   - Reminders   → CalDAV (VTODO collections under the same principal)
 * Auth = Apple ID + an app-specific password generated at appleid.apple.com
 * (2FA must be enabled on the Apple ID).
 *
 * Embedders should call `setAuthResolver()` with a function that returns
 * the credentials they manage (e.g. read from a vault, decrypt from disk,
 * etc.). The resolver is async-capable and invoked lazily on every tool
 * call, so it is safe to import the tools before configuring auth.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import {
  createDAVClient,
  type DAVCalendar,
  type DAVObject,
} from "tsdav";
import ICAL from "ical.js";

// ── Auth ────────────────────────────────────────────────────────────────

export interface ICloudAuth {
  /** Full Apple ID email, e.g. `johnappleseed@icloud.com`. */
  appleId: string;
  /** App-specific password generated at appleid.apple.com — 16 chars,
   *  optionally hyphenated as `xxxx-xxxx-xxxx-xxxx`. Hyphens are
   *  stripped before use. */
  appPassword: string;
}

export type AuthResolver = () =>
  | ICloudAuth
  | { error: string }
  | Promise<ICloudAuth | { error: string }>;

let _resolver: AuthResolver = resolveICloudAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void {
  _resolver = fn;
}

export function resolveICloudAuthFromEnv(): ICloudAuth | { error: string } {
  const appleId = process.env.ICLOUD_APPLE_ID?.trim();
  const appPassword = process.env.ICLOUD_APP_PASSWORD?.trim();
  if (appleId && appPassword) {
    return { appleId, appPassword: stripDashesAndZeroWidth(appPassword) };
  }
  return {
    error:
      "iCloud not configured. Set ICLOUD_APPLE_ID and ICLOUD_APP_PASSWORD " +
      "env vars (the app password is generated at appleid.apple.com — " +
      "requires 2FA), or call setAuthResolver() with your own credential " +
      "provider.",
  };
}

async function resolveAuth(): Promise<ICloudAuth | { error: string }> {
  const out = await _resolver();
  if ("error" in out) return out;
  return {
    appleId: out.appleId.trim(),
    appPassword: stripDashesAndZeroWidth(out.appPassword),
  };
}

function stripDashesAndZeroWidth(s: string): string {
  return s.replace(/[\u200B-\u200D\uFEFF\s-]/g, "");
}

function imapUsername(appleId: string): string {
  // iCloud IMAP accepts either the short name or the full address. The
  // short name (left of `@`) is what Apple's docs prescribe, and avoids
  // a rare server quirk where the full-address form returns AUTH NO on
  // first connect.
  const at = appleId.indexOf("@");
  return at > 0 ? appleId.slice(0, at) : appleId;
}

// ── Shared shapes ──────────────────────────────────────────────────────

function err(message: unknown): string {
  return JSON.stringify({
    error: typeof message === "string" ? message : "Unknown iCloud error",
  });
}

function ok<T>(value: T): string {
  return JSON.stringify(value);
}

// ── IMAP client factory ────────────────────────────────────────────────

const IMAP_HOST = "imap.mail.me.com";
const IMAP_PORT = 993;

interface RunImapOpts {
  mailbox?: string;
  readOnly?: boolean;
}

/** Connect, run `fn` inside an opened mailbox (or none), and always log out.
 *  Each tool call opens a fresh connection — this is heavier than connection
 *  pooling but keeps the package stateless and safe under concurrent
 *  invocations from the same agent loop. */
async function runImap<T>(
  fn: (client: ImapFlow) => Promise<T>,
  opts: RunImapOpts = {},
): Promise<T | { error: string }> {
  const auth = await resolveAuth();
  if ("error" in auth) return auth;
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: imapUsername(auth.appleId), pass: auth.appPassword },
    logger: false,
  });
  try {
    await client.connect();
    if (opts.mailbox) {
      const lock = await client.getMailboxLock(opts.mailbox, {
        readOnly: opts.readOnly ?? false,
      });
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    }
    return await fn(client);
  } catch (e) {
    return { error: imapErrorMessage(e) };
  } finally {
    try {
      await client.logout();
    } catch {
      /* connection may already be dead */
    }
  }
}

function imapErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (/AUTHENTICATIONFAILED|Invalid credentials|AUTH/i.test(e.message)) {
      return (
        "iCloud IMAP authentication failed. Check that the Apple ID is correct " +
        "and that the app-specific password has not been revoked at appleid.apple.com."
      );
    }
    return `iCloud IMAP error: ${e.message}`;
  }
  return "iCloud IMAP error (unknown)";
}

// ── Mailbox resolution by SPECIAL-USE flag ─────────────────────────────

/** Resolve a SPECIAL-USE label (`\Drafts`, `\Sent`, `\Trash`, `\Junk`,
 *  `\Archive`) to its server path. iCloud localises folder names, so
 *  the SPECIAL-USE flag is the only stable way to find them. */
async function findSpecialUseMailbox(
  client: ImapFlow,
  specialUse: "\\Drafts" | "\\Sent" | "\\Trash" | "\\Junk" | "\\Archive",
): Promise<string | null> {
  const list = await client.list({ statusQuery: { messages: false } });
  for (const m of list) {
    if (m.specialUse === specialUse) return m.path;
  }
  return null;
}

// ── Mail tools ─────────────────────────────────────────────────────────

export const icloudMailListFoldersTool = tool(
  async () => {
    const result = await runImap(async (client) => {
      const list = await client.list({ statusQuery: { messages: true, unseen: true } });
      return list.map((m) => ({
        path: m.path,
        name: m.name,
        delimiter: m.delimiter,
        special_use: m.specialUse ?? null,
        subscribed: m.subscribed,
        messages: m.status?.messages ?? null,
        unseen: m.status?.unseen ?? null,
      }));
    });
    if ("error" in result) return err(result.error);
    return ok({ folders: result });
  },
  {
    name: "icloud_mail_list_folders",
    description:
      "List iCloud Mail folders (mailboxes) with message + unread counts. " +
      "Use the SPECIAL-USE flag (`\\Drafts`, `\\Sent`, `\\Trash`, `\\Junk`, " +
      "`\\Archive`) to identify well-known folders — iCloud localises the " +
      "display names but the flags are stable.",
    schema: z.object({}),
  },
);

export const icloudMailListMessagesTool = tool(
  async ({ mailbox, query, unseen_only, since, before, limit }) => {
    const max = Math.min(limit ?? 25, 100);
    const result = await runImap(
      async (client) => {
        const search: Record<string, unknown> = {};
        if (unseen_only) search.seen = false;
        if (query) search.body = query;
        if (since) search.since = new Date(since);
        if (before) search.before = new Date(before);
        // IMAP SEARCH requires at least one criterion; iCloud rejects an
        // empty body with "Command failed". Fall back to ALL when the
        // caller passed no filters.
        if (Object.keys(search).length === 0) search.all = true;
        const uids = (await client.search(search, { uid: true })) || [];
        const recent = uids.slice(-max).reverse();
        const messages: Array<{
          uid: number;
          subject: string | null;
          from: string | null;
          date: string | null;
          flags: string[];
          size: number;
        }> = [];
        if (recent.length === 0) return messages;
        for await (const msg of client.fetch(recent, {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
        })) {
          messages.push({
            uid: msg.uid,
            subject: msg.envelope?.subject ?? null,
            from:
              msg.envelope?.from
                ?.map((a) => `${a.name ? `${a.name} ` : ""}<${a.address}>`)
                .join(", ") ?? null,
            date: msg.envelope?.date?.toISOString() ?? null,
            flags: Array.from(msg.flags ?? []),
            size: msg.size ?? 0,
          });
        }
        return messages;
      },
      { mailbox: mailbox ?? "INBOX", readOnly: true },
    );
    if ("error" in result) return err(result.error);
    return ok({ messages: result });
  },
  {
    name: "icloud_mail_list_messages",
    description:
      "Search messages in an iCloud Mail folder. Returns the most recent " +
      "results first. `query` does a body+subject substring search (IMAP " +
      "SEARCH BODY semantics — iCloud does not implement Gmail-style " +
      "operators). Date bounds are ISO strings (e.g. `2026-06-01`).",
    schema: z.object({
      mailbox: z.string().optional().describe("Folder path, default INBOX"),
      query: z.string().optional().describe("Body/subject substring"),
      unseen_only: z.boolean().optional(),
      since: z.string().optional(),
      before: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    }),
  },
);

export const icloudMailGetMessageTool = tool(
  async ({ mailbox, uid, include_html }) => {
    const result = await runImap(
      async (client) => {
        const msg = (await client.fetchOne(
          String(uid),
          {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
            source: true,
          },
          { uid: true },
        )) as FetchMessageObject | false;
        if (!msg) return { error: `Message uid=${uid} not found in ${mailbox}` };
        const text = await client.download(String(uid), undefined, {
          uid: true,
        });
        // Pull text/plain and (optionally) text/html parts in one parse.
        const parts = collectBodyParts(msg.bodyStructure);
        const fetchedParts: Record<string, string> = {};
        for (const p of parts) {
          if (p.type === "text/plain" || (include_html && p.type === "text/html")) {
            try {
              const dl = await client.download(String(uid), p.part, {
                uid: true,
              });
              fetchedParts[p.type] = await streamToString(dl.content);
            } catch {
              /* ignore */
            }
          }
        }
        try {
          // Always close the bare source stream to avoid leaks even if the
          // imapflow caller didn't.
          if (text?.content && typeof text.content.destroy === "function") {
            text.content.destroy();
          }
        } catch {
          /* ignore */
        }
        return {
          uid: msg.uid,
          subject: msg.envelope?.subject ?? null,
          from:
            msg.envelope?.from
              ?.map((a) => `${a.name ? `${a.name} ` : ""}<${a.address}>`)
              .join(", ") ?? null,
          to:
            msg.envelope?.to
              ?.map((a) => `${a.name ? `${a.name} ` : ""}<${a.address}>`)
              .join(", ") ?? null,
          cc:
            msg.envelope?.cc
              ?.map((a) => `${a.name ? `${a.name} ` : ""}<${a.address}>`)
              .join(", ") ?? null,
          date: msg.envelope?.date?.toISOString() ?? null,
          flags: Array.from(msg.flags ?? []),
          text: fetchedParts["text/plain"] ?? null,
          html: include_html ? fetchedParts["text/html"] ?? null : null,
          attachments: parts
            .filter((p) => p.disposition === "attachment")
            .map((p) => ({ part: p.part, type: p.type, size: p.size, filename: p.filename })),
        };
      },
      { mailbox: mailbox ?? "INBOX", readOnly: true },
    );
    if ("error" in result) return err(result.error);
    return ok(result);
  },
  {
    name: "icloud_mail_get_message",
    description:
      "Fetch a single message by UID. Returns headers, plain-text body, " +
      "and an attachments index. Set include_html=true to also pull the " +
      "HTML alternative (skipped by default to keep responses small).",
    schema: z.object({
      mailbox: z.string().optional().describe("Folder path, default INBOX"),
      uid: z.number().int().positive(),
      include_html: z.boolean().optional(),
    }),
  },
);

interface BodyPart {
  part: string;
  type: string;
  size: number;
  filename: string | null;
  disposition: string | null;
}

function collectBodyParts(structure: unknown, prefix = ""): BodyPart[] {
  if (!structure || typeof structure !== "object") return [];
  const s = structure as Record<string, unknown>;
  const out: BodyPart[] = [];
  const childNodes = (s.childNodes as unknown[]) ?? [];
  if (Array.isArray(childNodes) && childNodes.length > 0) {
    childNodes.forEach((child, idx) => {
      const partId = prefix ? `${prefix}.${idx + 1}` : String(idx + 1);
      out.push(...collectBodyParts(child, partId));
    });
    return out;
  }
  const type = String(s.type ?? "");
  const subtype = String(s.subtype ?? "");
  const fullType = type && subtype ? `${type}/${subtype}`.toLowerCase() : "application/octet-stream";
  const dispositionRaw = s.disposition;
  const disposition =
    typeof dispositionRaw === "string"
      ? dispositionRaw
      : dispositionRaw && typeof dispositionRaw === "object"
        ? String((dispositionRaw as Record<string, unknown>).type ?? "")
        : null;
  const params = (s.parameters as Record<string, unknown> | undefined) ?? {};
  const dispParams =
    (s.dispositionParameters as Record<string, unknown> | undefined) ?? {};
  const filename =
    (dispParams.filename as string | undefined) ?? (params.name as string | undefined) ?? null;
  out.push({
    part: prefix || "1",
    type: fullType,
    size: Number(s.size ?? 0),
    filename,
    disposition: disposition ? disposition.toLowerCase() : null,
  });
  return out;
}

async function streamToString(
  stream: NodeJS.ReadableStream | null | undefined,
): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer | string>) {
    chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export const icloudMailCreateDraftTool = tool(
  async ({ to, cc, bcc, subject, body_text, body_html, in_reply_to }) => {
    const result = await runImap(async (client) => {
      const drafts = await findSpecialUseMailbox(client, "\\Drafts");
      if (!drafts) {
        return { error: "Could not find the Drafts mailbox on this account." };
      }
      const auth = await resolveAuth();
      if ("error" in auth) return auth;
      const rfc822 = buildRfc822({
        from: auth.appleId,
        to,
        cc,
        bcc,
        subject,
        bodyText: body_text,
        bodyHtml: body_html,
        inReplyTo: in_reply_to,
      });
      const appendRes = await client.append(drafts, rfc822, ["\\Draft"]);
      return {
        mailbox: drafts,
        uid: appendRes && typeof appendRes === "object" ? appendRes.uid ?? null : null,
      };
    });
    if ("error" in result) return err(result.error);
    return ok({ ok: true, ...result });
  },
  {
    name: "icloud_mail_create_draft",
    description:
      "Save a new draft to the iCloud Drafts folder. This intentionally does " +
      "not send mail — iCloud SMTP is not wired in this release. The draft " +
      "can be reviewed and sent from Apple Mail on the user's device.",
    schema: z.object({
      to: z.array(z.string()).min(1),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string(),
      body_text: z.string(),
      body_html: z.string().optional(),
      in_reply_to: z.string().optional().describe("Message-Id of the email being replied to"),
    }),
  },
);

interface BuildRfc822Args {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
}

function buildRfc822(args: BuildRfc822Args): string {
  const boundary = `=_jarela_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const headers: string[] = [
    `From: ${args.from}`,
    `To: ${args.to.join(", ")}`,
  ];
  if (args.cc && args.cc.length > 0) headers.push(`Cc: ${args.cc.join(", ")}`);
  if (args.bcc && args.bcc.length > 0) headers.push(`Bcc: ${args.bcc.join(", ")}`);
  headers.push(`Subject: ${rfc2047Encode(args.subject)}`);
  headers.push(`Date: ${new Date().toUTCString()}`);
  headers.push("MIME-Version: 1.0");
  if (args.inReplyTo) {
    headers.push(`In-Reply-To: ${args.inReplyTo}`);
    headers.push(`References: ${args.inReplyTo}`);
  }
  if (args.bodyHtml) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body =
      `--${boundary}\r\n` +
      `Content-Type: text/plain; charset="utf-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      `${args.bodyText}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: text/html; charset="utf-8"\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n\r\n` +
      `${args.bodyHtml}\r\n` +
      `--${boundary}--\r\n`;
    return headers.join("\r\n") + "\r\n\r\n" + body;
  }
  headers.push('Content-Type: text/plain; charset="utf-8"');
  headers.push("Content-Transfer-Encoding: 8bit");
  return headers.join("\r\n") + "\r\n\r\n" + args.bodyText + "\r\n";
}

function rfc2047Encode(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

export const icloudMailMoveMessageTool = tool(
  async ({ from_mailbox, uid, to_mailbox }) => {
    const result = await runImap(
      async (client) => {
        await client.messageMove(String(uid), to_mailbox, { uid: true });
        return { moved: true };
      },
      { mailbox: from_mailbox },
    );
    if ("error" in result) return err(result.error);
    return ok(result);
  },
  {
    name: "icloud_mail_move_message",
    description:
      "Move a message to a different folder. To send a message to trash, " +
      "use `icloud_mail_delete_message` (it resolves the localised Trash " +
      "folder via SPECIAL-USE).",
    schema: z.object({
      from_mailbox: z.string(),
      uid: z.number().int().positive(),
      to_mailbox: z.string(),
    }),
  },
);

export const icloudMailFlagMessageTool = tool(
  async ({ mailbox, uid, seen, flagged }) => {
    const result = await runImap(
      async (client) => {
        const add: string[] = [];
        const remove: string[] = [];
        if (typeof seen === "boolean") (seen ? add : remove).push("\\Seen");
        if (typeof flagged === "boolean") (flagged ? add : remove).push("\\Flagged");
        if (add.length === 0 && remove.length === 0) {
          return { error: "Nothing to do — set at least one of seen/flagged." };
        }
        if (add.length > 0) {
          await client.messageFlagsAdd(String(uid), add, { uid: true });
        }
        if (remove.length > 0) {
          await client.messageFlagsRemove(String(uid), remove, { uid: true });
        }
        return { added: add, removed: remove };
      },
      { mailbox },
    );
    if ("error" in result) return err(result.error);
    return ok(result);
  },
  {
    name: "icloud_mail_flag_message",
    description:
      "Add or remove standard IMAP flags on a message — typically `\\Seen` " +
      "(read/unread) and `\\Flagged` (starred). Pass `seen=true` to mark " +
      "read, `seen=false` to mark unread; same for `flagged`.",
    schema: z.object({
      mailbox: z.string(),
      uid: z.number().int().positive(),
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
    }),
  },
);

export const icloudMailDeleteMessageTool = tool(
  async ({ mailbox, uid }) => {
    const result = await runImap(
      async (client) => {
        const trash = await findSpecialUseMailbox(client, "\\Trash");
        if (!trash) {
          return { error: "Could not find the Trash mailbox on this account." };
        }
        await client.messageMove(String(uid), trash, { uid: true });
        return { trashed_to: trash };
      },
      { mailbox },
    );
    if ("error" in result) return err(result.error);
    return ok(result);
  },
  {
    name: "icloud_mail_delete_message",
    description:
      "Move a message to the iCloud Trash (recoverable for ~30 days, " +
      "then auto-purged by Apple). Resolves the localised Trash folder " +
      "via the SPECIAL-USE `\\Trash` flag — works regardless of UI " +
      "language. To permanently delete, the user must empty Trash from " +
      "Mail.app or iCloud.com.",
    schema: z.object({
      mailbox: z.string(),
      uid: z.number().int().positive(),
    }),
  },
);

// ── CalDAV client + caching ────────────────────────────────────────────

const CALDAV_SERVER = "https://caldav.icloud.com/";

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;

interface CachedDav {
  client: DAVClient;
  /** Stable cache key derived from the credentials so a setAuthResolver()
   *  change invalidates the cache automatically. */
  key: string;
}

let _davCache: CachedDav | null = null;

async function getDavClient(): Promise<DAVClient | { error: string }> {
  const auth = await resolveAuth();
  if ("error" in auth) return auth;
  const key = `${auth.appleId}:${auth.appPassword.length}`;
  if (_davCache && _davCache.key === key) return _davCache.client;
  try {
    const client = await createDAVClient({
      serverUrl: CALDAV_SERVER,
      credentials: { username: auth.appleId, password: auth.appPassword },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
    _davCache = { client, key };
    return client;
  } catch (e) {
    return { error: caldavErrorMessage(e) };
  }
}

/** Test seam — reset the cached CalDAV client. */
export function _resetCalDAVCache(): void {
  _davCache = null;
}

function caldavErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    if (/401|403|unauthor/i.test(e.message)) {
      return (
        "iCloud CalDAV authentication failed. Check that the Apple ID is correct " +
        "and that the app-specific password has not been revoked at appleid.apple.com."
      );
    }
    return `iCloud CalDAV error: ${e.message}`;
  }
  return "iCloud CalDAV error (unknown)";
}

interface CalendarInfo {
  url: string;
  display_name: string;
  description: string | null;
  components: string[];
  color: string | null;
  ctag: string | null;
}

function summariseCalendar(c: DAVCalendar): CalendarInfo {
  const components = Array.isArray(c.components)
    ? (c.components as string[])
    : typeof c.components === "string"
      ? [c.components as string]
      : [];
  const displayName =
    typeof c.displayName === "string"
      ? c.displayName
      : c.displayName
        ? String(c.displayName)
        : c.url;
  return {
    url: c.url,
    display_name: displayName,
    description: typeof c.description === "string" ? c.description : null,
    components,
    color: typeof c.calendarColor === "string" ? c.calendarColor : null,
    ctag: typeof c.ctag === "string" ? c.ctag : null,
  };
}

async function listCalendars(filter: "VEVENT" | "VTODO" | null): Promise<
  CalendarInfo[] | { error: string }
> {
  const client = await getDavClient();
  if ("error" in client) return client;
  try {
    const calendars = await client.fetchCalendars();
    const summarised = calendars.map(summariseCalendar);
    if (!filter) return summarised;
    return summarised.filter((c) => c.components.length === 0 || c.components.includes(filter));
  } catch (e) {
    return { error: caldavErrorMessage(e) };
  }
}

// ── Calendar tools ─────────────────────────────────────────────────────

export const icloudCalendarListCalendarsTool = tool(
  async () => {
    const result = await listCalendars("VEVENT");
    if ("error" in result) return err(result.error);
    return ok({ calendars: result });
  },
  {
    name: "icloud_calendar_list_calendars",
    description:
      "List iCloud event calendars (VEVENT collections). Returns the URL " +
      "to pass to other calendar tools, plus a display name and color.",
    schema: z.object({}),
  },
);

export const icloudCalendarListEventsTool = tool(
  async ({ calendar_url, time_min, time_max }) => {
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    try {
      const objects = await client.fetchCalendarObjects({
        calendar: { url: calendar_url } as DAVCalendar,
        timeRange:
          time_min && time_max
            ? { start: time_min, end: time_max }
            : undefined,
      });
      return ok({ events: objects.map((o) => summariseEvent(o)) });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_calendar_list_events",
    description:
      "List events in a calendar between two ISO timestamps. The calendar " +
      "URL comes from `icloud_calendar_list_calendars`. Returns each event's " +
      "uid, summary, start, end, location, description, and href.",
    schema: z.object({
      calendar_url: z.string().url(),
      time_min: z.string().describe("ISO timestamp (inclusive lower bound)"),
      time_max: z.string().describe("ISO timestamp (exclusive upper bound)"),
    }),
  },
);

export const icloudCalendarGetEventTool = tool(
  async ({ calendar_url, uid }) => {
    const found = await findEvent(calendar_url, uid);
    if ("error" in found) return err(found.error);
    return ok({ event: summariseEvent(found.object), raw: found.object.data });
  },
  {
    name: "icloud_calendar_get_event",
    description: "Fetch a single event by UID, including the raw iCalendar source.",
    schema: z.object({
      calendar_url: z.string().url(),
      uid: z.string(),
    }),
  },
);

export const icloudCalendarCreateEventTool = tool(
  async ({
    calendar_url,
    summary,
    start,
    end,
    description,
    location,
    attendees,
    all_day,
    rrule,
    alerts,
    travel_time,
    url,
    status,
    availability,
  }) => {
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    const uid = newUid();
    const ics = buildVEvent({
      uid,
      summary,
      start,
      end,
      description,
      location,
      attendees,
      allDay: Boolean(all_day),
      rrule,
      alerts,
      travelTime: travel_time,
      url,
      status,
      availability,
    });
    try {
      await client.createCalendarObject({
        calendar: { url: calendar_url } as DAVCalendar,
        filename: `${uid}.ics`,
        iCalString: ics,
      });
      return ok({ uid, calendar_url });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_calendar_create_event",
    description:
      "Create an event on an iCloud calendar. `start` and `end` are ISO " +
      "timestamps; pass `all_day: true` and date-only strings (YYYY-MM-DD) " +
      "for all-day events. Optional `rrule` sets recurrence specs " +
      "(e.g. 'FREQ=WEEKLY;BYDAY=MO,FR'). Optional `alerts` sets primary & secondary " +
      "reminders (e.g. ['15m', '1h'] or ['-PT15M', '-PT1H']). Optional `travel_time` " +
      "sets Apple travel duration (e.g. '15m', '30m').",
    schema: z.object({
      calendar_url: z.string().url(),
      summary: z.string(),
      start: z.string(),
      end: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional().describe("Attendee email addresses"),
      all_day: z.boolean().optional(),
      rrule: z
        .string()
        .optional()
        .describe("iCalendar RRULE recurrence rule string (e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR' or 'FREQ=DAILY;COUNT=10')"),
      alerts: z
        .array(z.string())
        .optional()
        .describe("Alert / alarm triggers relative to event start, e.g. ['15m', '1h'] or ['-PT15M', '-PT1H'] for primary and secondary alerts"),
      travel_time: z
        .string()
        .optional()
        .describe("Travel duration before event start (e.g. '15m', '30m', '1h', 'PT15M'). Sets Apple X-APPLE-TRAVEL-DURATION."),
      url: z.string().url().optional().describe("URL associated with event (e.g. video call link)"),
      status: z.enum(["CONFIRMED", "TENTATIVE", "CANCELLED"]).optional(),
      availability: z
        .enum(["busy", "free"])
        .optional()
        .describe("Event availability / transparency ('busy' = OPAQUE, 'free' = TRANSPARENT)"),
    }),
  },
);

export const icloudCalendarUpdateEventTool = tool(
  async ({
    calendar_url,
    uid,
    summary,
    start,
    end,
    description,
    location,
    rrule,
    alerts,
    travel_time,
    url,
    status,
    availability,
  }) => {
    const found = await findEvent(calendar_url, uid);
    if ("error" in found) return err(found.error);
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    try {
      const updated = patchVEvent(found.object.data ?? "", {
        summary,
        start,
        end,
        description,
        location,
        rrule,
        alerts,
        travelTime: travel_time,
        url,
        status,
        availability,
      });
      await client.updateCalendarObject({
        calendarObject: { ...found.object, data: updated },
      });
      return ok({ updated: true, uid });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_calendar_update_event",
    description:
      "Patch fields on an existing event. Only the supplied fields are " +
      "overwritten — others are preserved. Pass `rrule` to update recurrence, " +
      "`alerts` for primary/secondary alerts, or `travel_time` for Apple travel time. " +
      "Pass 'NONE' / empty array to remove recurrence, alerts, or travel time.",
    schema: z.object({
      calendar_url: z.string().url(),
      uid: z.string(),
      summary: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      rrule: z
        .string()
        .optional()
        .describe("iCalendar RRULE recurrence rule string or 'NONE' to remove"),
      alerts: z
        .array(z.string())
        .optional()
        .describe("Update alert triggers (e.g. ['15m', '1h']). Pass [] or ['NONE'] to remove all alerts."),
      travel_time: z
        .string()
        .optional()
        .describe("Update travel duration (e.g. '15m', '30m') or 'NONE' to remove."),
      url: z.string().optional().describe("Update URL associated with event, or 'NONE' / '' to remove."),
      status: z.enum(["CONFIRMED", "TENTATIVE", "CANCELLED"]).optional(),
      availability: z.enum(["busy", "free"]).optional(),
    }),
  },
);

export const icloudCalendarDeleteEventTool = tool(
  async ({ calendar_url, uid }) => {
    const found = await findEvent(calendar_url, uid);
    if ("error" in found) return err(found.error);
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    try {
      await client.deleteCalendarObject({ calendarObject: found.object });
      return ok({ deleted: true, uid });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_calendar_delete_event",
    description:
      "Delete an event by UID. For a recurring series this removes every " +
      "occurrence; per-instance deletion (EXDATE) is not supported in this " +
      "release.",
    schema: z.object({
      calendar_url: z.string().url(),
      uid: z.string(),
    }),
  },
);

// ── Reminder tools (VTODO over CalDAV) ─────────────────────────────────

export const icloudRemindersListTool = tool(
  async ({ calendar_url, include_completed }) => {
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    try {
      const objects = await client.fetchCalendarObjects({
        calendar: { url: calendar_url } as DAVCalendar,
      });
      const todos = objects.map(summariseTodo).filter((t) => t !== null) as ReturnType<
        typeof summariseTodo
      >[];
      const filtered = include_completed
        ? todos
        : todos.filter((t) => t !== null && t.status !== "COMPLETED");
      return ok({ reminders: filtered });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_reminders_list",
    description:
      "List reminders (VTODO items) in a Reminders list. The calendar URL " +
      "comes from a CalDAV collection whose components include `VTODO` — " +
      "use `icloud_calendar_list_calendars` and filter on " +
      "`components.includes('VTODO')`, or call `icloud_reminders_list_lists`.",
    schema: z.object({
      calendar_url: z.string().url(),
      include_completed: z.boolean().optional(),
    }),
  },
);

export const icloudRemindersListListsTool = tool(
  async () => {
    const result = await listCalendars("VTODO");
    if ("error" in result) return err(result.error);
    return ok({ lists: result });
  },
  {
    name: "icloud_reminders_list_lists",
    description:
      "List iCloud Reminders lists (VTODO calendar collections). Returns " +
      "the URL to pass to the other reminders tools.",
    schema: z.object({}),
  },
);

export const icloudRemindersCreateTool = tool(
  async ({ calendar_url, summary, due, description }) => {
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    const uid = newUid();
    const ics = buildVTodo({ uid, summary, due, description });
    try {
      await client.createCalendarObject({
        calendar: { url: calendar_url } as DAVCalendar,
        filename: `${uid}.ics`,
        iCalString: ics,
      });
      return ok({ uid, calendar_url });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_reminders_create",
    description: "Create a reminder (VTODO) in an iCloud Reminders list.",
    schema: z.object({
      calendar_url: z.string().url(),
      summary: z.string(),
      due: z.string().optional().describe("ISO timestamp"),
      description: z.string().optional(),
    }),
  },
);

export const icloudRemindersCompleteTool = tool(
  async ({ calendar_url, uid }) => {
    const found = await findEvent(calendar_url, uid);
    if ("error" in found) return err(found.error);
    const client = await getDavClient();
    if ("error" in client) return err(client.error);
    try {
      const updated = markVTodoCompleted(found.object.data ?? "");
      await client.updateCalendarObject({
        calendarObject: { ...found.object, data: updated },
      });
      return ok({ completed: true, uid });
    } catch (e) {
      return err(caldavErrorMessage(e));
    }
  },
  {
    name: "icloud_reminders_complete",
    description: "Mark a reminder (VTODO) as completed.",
    schema: z.object({
      calendar_url: z.string().url(),
      uid: z.string(),
    }),
  },
);

// ── CalDAV helpers ─────────────────────────────────────────────────────

async function findEvent(
  calendarUrl: string,
  uid: string,
): Promise<{ object: DAVObject } | { error: string }> {
  const client = await getDavClient();
  if ("error" in client) return client;
  try {
    const objects = await client.fetchCalendarObjects({
      calendar: { url: calendarUrl } as DAVCalendar,
    });
    for (const obj of objects) {
      if (extractUid(obj.data ?? "") === uid) return { object: obj };
    }
    return { error: `Calendar object uid=${uid} not found in ${calendarUrl}` };
  } catch (e) {
    return { error: caldavErrorMessage(e) };
  }
}

function summariseEvent(obj: DAVObject): Record<string, unknown> {
  const parsed = safeParseIcal(obj.data ?? "");
  if (!parsed) return { href: obj.url, raw_parse_failed: true };
  const ev = parsed.getFirstSubcomponent("vevent");
  if (!ev) return { href: obj.url, no_vevent: true };
  const event = new ICAL.Event(ev);
  const rruleVal = ev.getFirstPropertyValue("rrule");
  const rruleStr = rruleVal ? rruleVal.toString() : null;

  const urlVal = ev.getFirstPropertyValue("url");
  const urlStr = urlVal ? urlVal.toString() : null;

  const statusVal = ev.getFirstPropertyValue("status");
  const statusStr = statusVal ? statusVal.toString() : null;

  const transpVal = ev.getFirstPropertyValue("transp");
  const availability = transpVal
    ? transpVal.toString().toUpperCase() === "TRANSPARENT"
      ? "free"
      : "busy"
    : null;

  const travelProp = ev.getFirstProperty("x-apple-travel-duration");
  const travelTime = travelProp ? travelProp.getFirstValue()?.toString() ?? null : null;

  const valarms = ev.getAllSubcomponents("valarm");
  const alerts: string[] = [];
  for (const alarm of valarms) {
    const trig = alarm.getFirstPropertyValue("trigger");
    if (trig) {
      alerts.push(trig.toString());
    }
  }

  return {
    href: obj.url,
    uid: event.uid ?? null,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.startDate ? event.startDate.toString() : null,
    end: event.endDate ? event.endDate.toString() : null,
    organizer: event.organizer ?? null,
    is_recurring: event.isRecurring(),
    rrule: rruleStr,
    url: urlStr,
    status: statusStr,
    availability,
    travel_time: travelTime,
    alerts,
    attendees: (event.attendees ?? []).map((a) => a.getFirstValue?.() ?? null),
  };
}

function summariseTodo(obj: DAVObject):
  | {
      href: string;
      uid: string | null;
      summary: string | null;
      description: string | null;
      due: string | null;
      status: string | null;
      completed: string | null;
    }
  | null {
  const parsed = safeParseIcal(obj.data ?? "");
  if (!parsed) return null;
  const todo = parsed.getFirstSubcomponent("vtodo");
  if (!todo) return null;
  return {
    href: obj.url,
    uid: stringOrNull(todo.getFirstPropertyValue("uid")),
    summary: stringOrNull(todo.getFirstPropertyValue("summary")),
    description: stringOrNull(todo.getFirstPropertyValue("description")),
    due: stringifyTime(todo.getFirstPropertyValue("due")),
    status: stringOrNull(todo.getFirstPropertyValue("status")),
    completed: stringifyTime(todo.getFirstPropertyValue("completed")),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringifyTime(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  const t = value as { toString?: () => string };
  return typeof t.toString === "function" ? t.toString() : null;
}

function safeParseIcal(data: string): ICAL.Component | null {
  try {
    const jcal = ICAL.parse(data);
    return new ICAL.Component(jcal);
  } catch {
    return null;
  }
}

function extractUid(data: string): string | null {
  const match = /^UID:(.+)$/m.exec(data);
  return match ? match[1].trim() : null;
}

function newUid(): string {
  const rand = Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${rand}@jarela.icloud`;
}

function formatIcalDate(input: string, allDay: boolean): string {
  if (allDay) {
    // YYYY-MM-DD → YYYYMMDD
    return input.replace(/-/g, "").slice(0, 8);
  }
  const d = new Date(input);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function escapeIcal(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function buildVEvent(args: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description?: string;
  location?: string;
  attendees?: string[];
  allDay: boolean;
  rrule?: string;
  alerts?: string[];
  travelTime?: string;
  url?: string;
  status?: string;
  availability?: "busy" | "free";
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Jarela//iCloud LangChain//EN",
    "BEGIN:VEVENT",
    `UID:${args.uid}`,
    `DTSTAMP:${formatIcalDate(new Date().toISOString(), false)}`,
    args.allDay
      ? `DTSTART;VALUE=DATE:${formatIcalDate(args.start, true)}`
      : `DTSTART:${formatIcalDate(args.start, false)}`,
    args.allDay
      ? `DTEND;VALUE=DATE:${formatIcalDate(args.end, true)}`
      : `DTEND:${formatIcalDate(args.end, false)}`,
    `SUMMARY:${escapeIcal(args.summary)}`,
  ];
  if (args.description) lines.push(`DESCRIPTION:${escapeIcal(args.description)}`);
  if (args.location) lines.push(`LOCATION:${escapeIcal(args.location)}`);
  if (args.url) lines.push(`URL:${escapeIcal(args.url)}`);
  if (args.status) lines.push(`STATUS:${args.status.toUpperCase()}`);
  if (args.availability) {
    lines.push(`TRANSP:${args.availability === "free" ? "TRANSPARENT" : "OPAQUE"}`);
  }
  if (args.rrule) {
    const cleanRrule = args.rrule.trim().replace(/^RRULE:/i, "");
    if (cleanRrule && cleanRrule.toUpperCase() !== "NONE") {
      lines.push(`RRULE:${cleanRrule}`);
    }
  }
  if (args.travelTime) {
    const dur = formatIcalDuration(args.travelTime);
    if (dur) {
      lines.push(`X-APPLE-TRAVEL-DURATION;VALUE=DURATION:${dur}`);
    }
  }
  for (const alarmTrigger of args.alerts ?? []) {
    const trigger = formatIcalTrigger(alarmTrigger);
    if (trigger) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push("DESCRIPTION:Reminder");
      lines.push(`TRIGGER:${trigger}`);
      lines.push("END:VALARM");
    }
  }
  for (const a of args.attendees ?? []) {
    lines.push(`ATTENDEE;CN=${escapeIcal(a)};RSVP=TRUE:mailto:${a}`);
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function buildVTodo(args: {
  uid: string;
  summary: string;
  due?: string;
  description?: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Jarela//iCloud LangChain//EN",
    "BEGIN:VTODO",
    `UID:${args.uid}`,
    `DTSTAMP:${formatIcalDate(new Date().toISOString(), false)}`,
    `SUMMARY:${escapeIcal(args.summary)}`,
    "STATUS:NEEDS-ACTION",
  ];
  if (args.due) lines.push(`DUE:${formatIcalDate(args.due, false)}`);
  if (args.description) lines.push(`DESCRIPTION:${escapeIcal(args.description)}`);
  lines.push("END:VTODO", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function patchVEvent(
  ics: string,
  patch: {
    summary?: string;
    start?: string;
    end?: string;
    description?: string;
    location?: string;
    rrule?: string;
    alerts?: string[];
    travelTime?: string;
    url?: string;
    status?: string;
    availability?: "busy" | "free";
  },
): string {
  const parsed = safeParseIcal(ics);
  if (!parsed) return ics;
  const ev = parsed.getFirstSubcomponent("vevent");
  if (!ev) return ics;
  if (patch.summary !== undefined) setProp(ev, "summary", patch.summary);
  if (patch.description !== undefined) setProp(ev, "description", patch.description);
  if (patch.location !== undefined) setProp(ev, "location", patch.location);
  if (patch.start !== undefined) setTimeProp(ev, "dtstart", patch.start);
  if (patch.end !== undefined) setTimeProp(ev, "dtend", patch.end);
  if (patch.rrule !== undefined) setRruleProp(ev, patch.rrule);
  if (patch.url !== undefined) {
    if (!patch.url || patch.url.toUpperCase() === "NONE") {
      removeProp(ev, "url");
    } else {
      setProp(ev, "url", patch.url);
    }
  }
  if (patch.status !== undefined) {
    if (!patch.status || patch.status.toUpperCase() === "NONE") {
      removeProp(ev, "status");
    } else {
      setProp(ev, "status", patch.status.toUpperCase());
    }
  }
  if (patch.availability !== undefined) {
    if (patch.availability === "free") {
      setProp(ev, "transp", "TRANSPARENT");
    } else if (patch.availability === "busy") {
      setProp(ev, "transp", "OPAQUE");
    } else {
      removeProp(ev, "transp");
    }
  }
  if (patch.travelTime !== undefined) {
    setTravelTimeProp(ev, patch.travelTime);
  }
  if (patch.alerts !== undefined) {
    setAlertsProps(ev, patch.alerts);
  }
  setTimeProp(ev, "last-modified", new Date().toISOString());
  return parsed.toString();
}

function markVTodoCompleted(ics: string): string {
  const parsed = safeParseIcal(ics);
  if (!parsed) return ics;
  const todo = parsed.getFirstSubcomponent("vtodo");
  if (!todo) return ics;
  setProp(todo, "status", "COMPLETED");
  setProp(todo, "percent-complete", "100");
  setTimeProp(todo, "completed", new Date().toISOString());
  return parsed.toString();
}

function removeProp(comp: ICAL.Component, name: string): void {
  const existing = comp.getFirstProperty(name);
  if (existing) comp.removeProperty(existing);
}

function setProp(comp: ICAL.Component, name: string, value: string): void {
  const existing = comp.getFirstProperty(name);
  if (existing) {
    existing.setValue(value);
  } else {
    const prop = new ICAL.Property(name, comp);
    prop.setValue(value);
    comp.addProperty(prop);
  }
}

function setRruleProp(comp: ICAL.Component, rruleInput: string): void {
  const clean = rruleInput.trim().replace(/^RRULE:/i, "");
  if (!clean || clean.toUpperCase() === "NONE") {
    comp.removeProperty("rrule");
    return;
  }
  const recur = ICAL.Recur.fromString(clean);
  const existing = comp.getFirstProperty("rrule");
  if (existing) {
    existing.setValue(recur);
  } else {
    const prop = new ICAL.Property("rrule", comp);
    prop.setValue(recur);
    comp.addProperty(prop);
  }
}

function setTravelTimeProp(comp: ICAL.Component, travelTime: string): void {
  const clean = travelTime.trim();
  if (!clean || clean.toUpperCase() === "NONE") {
    removeProp(comp, "x-apple-travel-duration");
    return;
  }
  const dur = formatIcalDuration(clean);
  if (!dur) return;
  const existing = comp.getFirstProperty("x-apple-travel-duration");
  if (existing) {
    existing.setValue(dur);
  } else {
    const prop = new ICAL.Property("x-apple-travel-duration", comp);
    prop.setParameter("value", "DURATION");
    prop.setValue(dur);
    comp.addProperty(prop);
  }
}

function setAlertsProps(comp: ICAL.Component, alerts: string[]): void {
  const existingAlarms = comp.getAllSubcomponents("valarm");
  for (const alarm of existingAlarms) {
    comp.removeSubcomponent(alarm);
  }
  if (alerts.length === 1 && (alerts[0].toUpperCase() === "NONE" || alerts[0] === "")) {
    return;
  }
  for (const alertInput of alerts) {
    const triggerStr = formatIcalTrigger(alertInput);
    if (!triggerStr) continue;
    const alarm = new ICAL.Component("valarm", comp);
    const actionProp = new ICAL.Property("action", alarm);
    actionProp.setValue("DISPLAY");
    alarm.addProperty(actionProp);

    const descProp = new ICAL.Property("description", alarm);
    descProp.setValue("Reminder");
    alarm.addProperty(descProp);

    const triggerProp = new ICAL.Property("trigger", alarm);
    try {
      triggerProp.setValue(ICAL.Duration.fromString(triggerStr));
    } catch {
      triggerProp.setValue(triggerStr);
    }
    alarm.addProperty(triggerProp);

    comp.addSubcomponent(alarm);
  }
}

function formatIcalDuration(input: string): string | null {
  if (!input) return null;
  const s = input.trim();
  if (!s || s.toUpperCase() === "NONE") return null;
  if (/^P/i.test(s)) return s.toUpperCase();

  const m = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i.exec(s);
  if (m) {
    const num = m[1];
    const unit = (m[2] || "m").toLowerCase();
    if (unit.startsWith("h")) return `PT${num}H`;
    if (unit.startsWith("d")) return `P${num}D`;
    return `PT${num}M`;
  }
  return s;
}

function formatIcalTrigger(input: string): string | null {
  if (!input) return null;
  const s = input.trim();
  if (!s || s.toUpperCase() === "NONE") return null;

  if (s.startsWith("-") || s.startsWith("+") || /^P/i.test(s)) {
    return s.startsWith("-") ? s.toUpperCase() : `-${s.toUpperCase()}`;
  }

  const dur = formatIcalDuration(s);
  if (!dur) return null;
  return `-${dur}`;
}

function setTimeProp(comp: ICAL.Component, name: string, isoValue: string): void {
  const t = ICAL.Time.fromJSDate(new Date(isoValue), true);
  const existing = comp.getFirstProperty(name);
  if (existing) {
    existing.setValue(t);
  } else {
    const prop = new ICAL.Property(name, comp);
    prop.setValue(t);
    comp.addProperty(prop);
  }
}

// ── Bundles ────────────────────────────────────────────────────────────

export const icloudMailTools = [
  icloudMailListFoldersTool,
  icloudMailListMessagesTool,
  icloudMailGetMessageTool,
  icloudMailCreateDraftTool,
  icloudMailMoveMessageTool,
  icloudMailFlagMessageTool,
  icloudMailDeleteMessageTool,
];

export const icloudCalendarTools = [
  icloudCalendarListCalendarsTool,
  icloudCalendarListEventsTool,
  icloudCalendarGetEventTool,
  icloudCalendarCreateEventTool,
  icloudCalendarUpdateEventTool,
  icloudCalendarDeleteEventTool,
];

export const icloudReminderTools = [
  icloudRemindersListListsTool,
  icloudRemindersListTool,
  icloudRemindersCreateTool,
  icloudRemindersCompleteTool,
];

export const icloudTools = [
  ...icloudMailTools,
  ...icloudCalendarTools,
  ...icloudReminderTools,
];

// Capability buckets, matching the convention used by the other
// CircuitWall LangChain packages (atlassian, github, jira-align) so the
// host app can register tools per capability tier:
//
//   read    - inspect-only, no state change on the iCloud side.
//   write   - create / mutate state, but reversible (drafts, moves,
//             flag toggles, event edits, reminder completion).
//   execute - destructive on the iCloud side. iCloud Mail moves
//             deleted messages to Trash (recoverable for ~30 days),
//             but CalDAV event delete is hard.
export const icloudReadTools = [
  icloudMailListFoldersTool,
  icloudMailListMessagesTool,
  icloudMailGetMessageTool,
  icloudCalendarListCalendarsTool,
  icloudCalendarListEventsTool,
  icloudCalendarGetEventTool,
  icloudRemindersListListsTool,
  icloudRemindersListTool,
];

export const icloudWriteTools = [
  icloudMailCreateDraftTool,
  icloudMailMoveMessageTool,
  icloudMailFlagMessageTool,
  icloudCalendarCreateEventTool,
  icloudCalendarUpdateEventTool,
  icloudRemindersCreateTool,
  icloudRemindersCompleteTool,
];

export const icloudExecuteTools = [
  icloudMailDeleteMessageTool,
  icloudCalendarDeleteEventTool,
];
