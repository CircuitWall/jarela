/**
 * Native Gmail tools — direct REST API calls to gmail.googleapis.com, no MCP.
 *
 * Why native: same reasoning as lib/tools/atlassian.ts. The MCP servers that
 * wrap Gmail OAuth bring an opaque token cache + extra subprocess; doing it
 * inline keeps a single source of credential truth (the Integrations panel)
 * and surfaces clean error messages to the agent.
 *
 * Auth resolution (in priority order):
 *   1. Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   2. Memory store: namespace="integrations", key="gmail",
 *        value={ client_id, client_secret, refresh_token }
 *
 * The user obtains a refresh token once via Google OAuth Playground
 * (https://developers.google.com/oauthplayground) — matches the Atlassian
 * paste-API-token UX. In-app OAuth flow is intentionally deferred.
 *
 * Scope-wise this integration supports drafts and direct sends via Gmail's
 * compose scope. Agents should still prefer drafts unless the user explicitly
 * asks to send now.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { stripHtml } from "@/lib/utils/html";
import { truncateBytes } from "@/lib/utils/text";
import { registerLangChainPackage } from "./langchain-package";
import {
  googleFetch,
  resolveGoogleAuth,
  type GoogleAuth,
} from "@/lib/integrations/gmail-oauth";
import { errorMessage } from "@/lib/utils/error";

// Re-export under the old name so existing imports (e.g. the integrations
// test endpoint) keep working unchanged.
export type GmailAuth = GoogleAuth;

// Exposed for the integrations test endpoint.
export function _resolveGmailAuth(): GmailAuth | { error: string } {
  return resolveGoogleAuth();
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const gmailFetch = (auth: GmailAuth, path: string, init?: RequestInit) =>
  googleFetch(auth, "Gmail", GMAIL_BASE, path, init);
const DRAFT_BODY_MAX_CHARS = 100_000;
const SEND_BODY_MAX_CHARS = 100_000;

function gmailAuthError(error: string): string {
  return JSON.stringify({
    error,
    error_code: "gmail_auth_required",
    recovery_hint: "Open Settings > Integrations > Gmail and reconnect or update the Gmail OAuth credentials before retrying.",
  });
}

function resolveGmailAuthForTool(): GmailAuth | { error: string } {
  try {
    return resolveGoogleAuth();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ── Decoders / helpers ──────────────────────────────────────────────────────

// Gmail uses base64url (no padding, +/ → -_). Node's Buffer handles it directly.
function decodeBase64Url(s: string): string {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

interface MessagePart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
}

// Walk the MIME tree, preferring text/plain. Fall back to a naive HTML strip
// when no plain part exists. Skips attachments (filename != "").
function extractBody(payload: MessagePart | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data), { preserveParagraphs: true });
  return "";
}

function findPart(part: MessagePart, mime: string): MessagePart | null {
  if (!part) return null;
  if (part.mimeType === mime && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime);
    if (hit) return hit;
  }
  return null;
}

const MAX_BODY_BYTES = 30_000;

interface Header { name?: string; value?: string }
function header(headers: Header[] | undefined, name: string): string | null {
  const h = (headers ?? []).find((x) => (x.name ?? "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

// Build an RFC 2822 message and base64url-encode it for the drafts API.
export function buildRawMessage(opts: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  content_type?: "text" | "html";
  in_reply_to?: string | null;   // value of Message-Id header from the parent
  references?: string | null;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${opts.to.join(", ")}`);
  if (opts.cc?.length) lines.push(`Cc: ${opts.cc.join(", ")}`);
  if (opts.bcc?.length) lines.push(`Bcc: ${opts.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeSubject(opts.subject)}`);
  if (opts.in_reply_to) lines.push(`In-Reply-To: ${opts.in_reply_to}`);
  if (opts.references) lines.push(`References: ${opts.references}`);
  lines.push(opts.content_type === "html"
    ? "Content-Type: text/html; charset=\"UTF-8\""
    : "Content-Type: text/plain; charset=\"UTF-8\"");
  lines.push("MIME-Version: 1.0");
  lines.push("");
  lines.push(opts.body);
  const raw = lines.join("\r\n");
  return Buffer.from(raw, "utf8").toString("base64url");
}

// RFC 2047 encoded-word for non-ASCII subjects.
function encodeSubject(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// ── Tools ───────────────────────────────────────────────────────────────────

export const gmailSearchTool = tool(
  async ({ query, max_results }) => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);
    const limit = Math.min(Math.max(max_results ?? 25, 1), 100);
    const list = await gmailFetch(
      auth,
      `/messages?q=${encodeURIComponent(query)}&maxResults=${limit}`,
    ) as { messages?: Array<{ id: string; threadId: string }>; resultSizeEstimate?: number; nextPageToken?: string; error?: string };
    if ("error" in list && list.error) return JSON.stringify(list);
    const ids = (list.messages ?? []).map((m) => m.id);
    if (ids.length === 0) {
      return JSON.stringify({
        query,
        result_size_estimate: list.resultSizeEstimate ?? 0,
        next_page_token: list.nextPageToken ?? null,
        messages: [],
      });
    }
    // Parallel metadata fetch; the API recommends batching but for ≤100 ids
    // parallel single calls are simpler and well within quota.
    const details = await Promise.all(ids.map(async (id) => {
      const m = await gmailFetch(
        auth,
        `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
      ) as { id?: string; threadId?: string; snippet?: string; labelIds?: string[]; payload?: { headers?: Header[] }; error?: string };
      if (m.error) return { id, error: m.error };
      return {
        id: m.id,
        thread_id: m.threadId,
        from: header(m.payload?.headers, "From"),
        to: header(m.payload?.headers, "To"),
        subject: header(m.payload?.headers, "Subject"),
        date: header(m.payload?.headers, "Date"),
        snippet: m.snippet ?? null,
        labels: m.labelIds ?? [],
      };
    }));
    return JSON.stringify({
      query,
      result_size_estimate: list.resultSizeEstimate ?? details.length,
      next_page_token: list.nextPageToken ?? null,
      messages: details,
    });
  },
  {
    name: "gmail_search",
    description:
      "Search the user's Gmail with Gmail query syntax. Returns message metadata (from, to, subject, " +
      "date, snippet, labels) plus Gmail's resultSizeEstimate and next page token so '1 result' " +
      "doesn't get mistaken for '1 unread email'. Examples: 'is:unread newer_than:1d', " +
      "'from:notifications@github.com', 'subject:invoice has:attachment', 'in:inbox -category:promotions'. " +
      "Use this before calling gmail_get_message — the snippet is often enough.",
    schema: z.object({
      query: z.string().describe("Gmail query string"),
      max_results: z.number().int().optional().describe("Max messages (default 25, max 100)"),
    }),
  },
);

export const gmailGetMessageTool = tool(
  async ({ id }) => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);
    const m = await gmailFetch(auth, `/messages/${encodeURIComponent(id)}?format=full`) as {
      id?: string;
      threadId?: string;
      snippet?: string;
      labelIds?: string[];
      payload?: MessagePart & { headers?: Header[] };
      error?: string;
    };
    if (m.error) return JSON.stringify(m);
    const body = extractBody(m.payload);
    const { text: capped, truncated } = truncateBytes(body, MAX_BODY_BYTES);
    return JSON.stringify({
      id: m.id,
      thread_id: m.threadId,
      labels: m.labelIds ?? [],
      from: header(m.payload?.headers, "From"),
      to: header(m.payload?.headers, "To"),
      cc: header(m.payload?.headers, "Cc"),
      subject: header(m.payload?.headers, "Subject"),
      date: header(m.payload?.headers, "Date"),
      message_id: header(m.payload?.headers, "Message-Id") ?? header(m.payload?.headers, "Message-ID"),
      snippet: m.snippet ?? null,
      body: capped,
      truncated,
    });
  },
  {
    name: "gmail_get_message",
    description:
      "Fetch one Gmail message by id, including full headers and the decoded text body (text/plain " +
      "preferred, HTML stripped if only HTML is available). Body capped at 30KB with `truncated:true` " +
      "when cut off.",
    schema: z.object({
      id: z.string().describe("Gmail message id (from gmail_search results)"),
    }),
  },
);

export const gmailListLabelsTool = tool(
  async () => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);
    const data = await gmailFetch(auth, `/labels`) as { labels?: Array<{ id: string; name: string; type: string }>; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      labels: (data.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
    });
  },
  {
    name: "gmail_list_labels",
    description:
      "List all Gmail labels (system + user). System label ids are uppercase (INBOX, UNREAD, " +
      "STARRED, IMPORTANT, SPAM, TRASH, SENT, DRAFT, CATEGORY_*). User labels have lowercase " +
      "alphanumeric ids like 'Label_42'. Use the id values with gmail_modify_message.",
    schema: z.object({}),
  },
);

export const gmailModifyMessageTool = tool(
  async ({ id, add_labels, remove_labels }) => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);
    if (!(add_labels?.length || remove_labels?.length)) {
      return JSON.stringify({ error: "Provide at least one of add_labels / remove_labels" });
    }
    const data = await gmailFetch(auth, `/messages/${encodeURIComponent(id)}/modify`, {
      method: "POST",
      body: JSON.stringify({
        addLabelIds: add_labels ?? [],
        removeLabelIds: remove_labels ?? [],
      }),
    }) as { id?: string; labelIds?: string[]; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, id: data.id, labels: data.labelIds ?? [] });
  },
  {
    name: "gmail_modify_message",
    description:
      "Add or remove labels on a Gmail message. Common patterns: " +
      "archive = remove_labels=['INBOX']; mark read = remove_labels=['UNREAD']; " +
      "star = add_labels=['STARRED']; mark important = add_labels=['IMPORTANT']. " +
      "Use gmail_list_labels first if you don't know a user label id.",
    schema: z.object({
      id: z.string().describe("Gmail message id"),
      add_labels: z.array(z.string()).optional().describe("Label ids to add"),
      remove_labels: z.array(z.string()).optional().describe("Label ids to remove"),
    }),
  },
);

export const gmailCreateDraftTool = tool(
  async ({ to, cc, bcc, subject, body, content_type, in_reply_to_id }) => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);

    let in_reply_to: string | null = null;
    let references: string | null = null;
    let threadId: string | null = null;
    if (in_reply_to_id) {
      // Pull the parent so the draft threads properly. Need the parent's
      // Message-Id header for In-Reply-To, and threadId for Gmail's
      // server-side threading.
      const parent = await gmailFetch(
        auth,
        `/messages/${encodeURIComponent(in_reply_to_id)}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=References`,
      ) as { threadId?: string; payload?: { headers?: Header[] }; error?: string };
      if (parent.error) {
        return JSON.stringify({ error: `Failed to load parent for threading: ${parent.error}` });
      }
      threadId = parent.threadId ?? null;
      in_reply_to = header(parent.payload?.headers, "Message-Id") ?? header(parent.payload?.headers, "Message-ID");
      const prevRefs = header(parent.payload?.headers, "References");
      references = prevRefs && in_reply_to ? `${prevRefs} ${in_reply_to}` : in_reply_to;
    }

    const raw = buildRawMessage({ to, cc, bcc, subject, body, content_type, in_reply_to, references });
    const data = await gmailFetch(auth, `/drafts`, {
      method: "POST",
      body: JSON.stringify({
        message: { raw, ...(threadId ? { threadId } : {}) },
      }),
    }) as { id?: string; message?: { id?: string; threadId?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      draft_id: data.id,
      message_id: data.message?.id,
      thread_id: data.message?.threadId,
    });
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a Gmail draft. Prefer drafts unless the user explicitly asks to send immediately. " +
      "`content_type` defaults to 'text'; pass 'html' if `body` contains HTML markup. " +
      "When replying to an existing message, pass `in_reply_to_id` (the parent " +
      "message id from gmail_search/gmail_get_message) — the tool will set Message-Id/References/" +
      "threadId so the draft appears inside the right Gmail thread.",
    schema: z.object({
      to: z.array(z.string()).describe("Recipient email addresses"),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string(),
      body: z.string().max(DRAFT_BODY_MAX_CHARS).describe("Email body (max 100,000 characters)"),
      content_type: z.enum(["text", "html"]).optional().describe("Body content type (default 'text')"),
      in_reply_to_id: z.string().optional().describe("Gmail message id to reply to (for threading)"),
    }),
  },
);

export const gmailSendEmailTool = tool(
  async ({ to, cc, bcc, subject, body, content_type, in_reply_to_id }) => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);

    let in_reply_to: string | null = null;
    let references: string | null = null;
    let threadId: string | null = null;
    if (in_reply_to_id) {
      const parent = await gmailFetch(
        auth,
        `/messages/${encodeURIComponent(in_reply_to_id)}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=References`,
      ) as { threadId?: string; payload?: { headers?: Header[] }; error?: string };
      if (parent.error) {
        return JSON.stringify({ error: `Failed to load parent for threading: ${parent.error}` });
      }
      threadId = parent.threadId ?? null;
      in_reply_to = header(parent.payload?.headers, "Message-Id") ?? header(parent.payload?.headers, "Message-ID");
      const prevRefs = header(parent.payload?.headers, "References");
      references = prevRefs && in_reply_to ? `${prevRefs} ${in_reply_to}` : in_reply_to;
    }

    const raw = buildRawMessage({ to, cc, bcc, subject, body, content_type, in_reply_to, references });
    const data = await gmailFetch(auth, `/messages/send`, {
      method: "POST",
      body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
    }) as { id?: string; threadId?: string; labelIds?: string[]; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, message_id: data.id, thread_id: data.threadId, labels: data.labelIds ?? [] });
  },
  {
    name: "gmail_send_email",
    description:
      "Send a Gmail email immediately. Only use when the user explicitly asks to send now; " +
      "otherwise create a draft with gmail_create_draft. Supports text or HTML bodies via `content_type`. " +
      "When replying, pass `in_reply_to_id` so Gmail threads the sent message correctly.",
    schema: z.object({
      to: z.array(z.string()).min(1).describe("Recipient email addresses"),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string(),
      body: z.string().max(SEND_BODY_MAX_CHARS).describe("Email body (max 100,000 characters)"),
      content_type: z.enum(["text", "html"]).optional().describe("Body content type (default 'text')"),
      in_reply_to_id: z.string().optional().describe("Gmail message id to reply to (for threading)"),
    }),
  },
);

export const gmailTrashMessageTool = tool(
  async ({ id }) => {
    const auth = resolveGmailAuthForTool();
    if ("error" in auth) return gmailAuthError(auth.error);
    const data = await gmailFetch(auth, `/messages/${encodeURIComponent(id)}/trash`, {
      method: "POST",
    }) as { id?: string; labelIds?: string[]; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, id: data.id, labels: data.labelIds ?? [] });
  },
  {
    name: "gmail_trash_message",
    description:
      "Move a Gmail message to Trash (reversible for 30 days, not permanent delete). Only call this " +
      "when the user has explicitly asked to trash/delete a message — never on your own initiative " +
      "as part of a triage flow. Prefer gmail_modify_message remove_labels=['INBOX'] to archive.",
    schema: z.object({
      id: z.string().describe("Gmail message id"),
    }),
  },
);

registerLangChainPackage({
  category: "Mail",
  integrationId: "gmail",
  tools: {
    read: [gmailSearchTool, gmailGetMessageTool, gmailListLabelsTool],
    write: [gmailModifyMessageTool, gmailCreateDraftTool, gmailTrashMessageTool],
    execute: [gmailSendEmailTool],
  },
});
