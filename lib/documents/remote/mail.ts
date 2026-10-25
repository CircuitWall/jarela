// Remote mail indexing for Gmail, Outlook, and iCloud.
//
// Scoped sources archive mail by default. Query-only legacy sources keep
// their original bounded mirror semantics.

import { stripHtml } from "@/lib/utils/html";
import { truncateBytes } from "@/lib/utils/text";
import { googleFetch, resolveGoogleAuth } from "@/lib/integrations/gmail-oauth";
import { graphFetch, resolveMicrosoftAuth } from "@/lib/integrations/microsoft-oauth";
import { parseSourceConfig, type DocumentSourceRow } from "@/lib/stores/document-sources";
import { parseMailSourceConfig } from "@/lib/documents/mail-source-config";
import { indexICloudMail } from "./icloud";
import { evictMissing, upsertRemoteDocument } from "./upsert";

import type { RemoteIndexStats } from "./index";

const BODY_CAP = 40_000;

interface Header {
  name?: string;
  value?: string;
}

interface GmailMessageList {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
  error?: string;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: {
    headers?: Header[];
    mimeType?: string;
    filename?: string;
    body?: { data?: string };
    parts?: GmailMessage["payload"][];
  };
  error?: string;
}

interface GraphEmailAddress {
  name?: string;
  address?: string;
}

interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: "html" | "text"; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  lastModifiedDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  parentFolderId?: string;
  webLink?: string;
}

function header(headers: Header[] | undefined, name: string): string | null {
  const hit = (headers ?? []).find((h) => (h.name ?? "").toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

function decodeBase64Url(s: string): string {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function findPart(part: { mimeType?: string; filename?: string; body?: { data?: string }; parts?: Array<unknown> } | undefined, mime: string): { mimeType?: string; filename?: string; body?: { data?: string }; parts?: Array<unknown> } | null {
  if (!part) return null;
  if (part.mimeType === mime && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child as Parameters<typeof findPart>[0], mime);
    if (hit) return hit;
  }
  return null;
}

function extractGmailBody(payload: GmailMessage["payload"] | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain") as { body?: { data?: string } } | null;
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);
  const html = findPart(payload, "text/html") as { body?: { data?: string } } | null;
  if (html?.body?.data) {
    return stripHtml(decodeBase64Url(html.body.data), { preserveParagraphs: true });
  }
  return "";
}

function recipientToStr(r?: GraphRecipient): string | null {
  const addr = r?.emailAddress?.address;
  if (!addr) return null;
  const name = r?.emailAddress?.name;
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

function summarizeGraphMessage(m: GraphMessage): { title: string; text: string; updatedAt: string } {
  const from = recipientToStr(m.from) ?? "";
  const to = (m.toRecipients ?? []).map(recipientToStr).filter(Boolean).join(", ");
  const cc = (m.ccRecipients ?? []).map(recipientToStr).filter(Boolean).join(", ");
  const body = m.body?.content ?? m.bodyPreview ?? "";
  const plain = m.body?.contentType === "html"
    ? stripHtml(body, { preserveParagraphs: true })
    : body;
  const { text: capped } = truncateBytes(plain, BODY_CAP);
  const text = [
    `From: ${from}`,
    to ? `To: ${to}` : null,
    cc ? `Cc: ${cc}` : null,
    m.subject ? `Subject: ${m.subject}` : null,
    m.receivedDateTime ? `Date: ${m.receivedDateTime}` : null,
    "",
    capped,
  ].filter((line): line is string => line !== null).join("\n");
  return {
    title: m.subject?.trim() || m.id || "(no subject)",
    text,
    updatedAt: m.lastModifiedDateTime ?? m.receivedDateTime ?? new Date().toISOString(),
  };
}

async function indexGmailMail(row: DocumentSourceRow): Promise<RemoteIndexStats> {
  const auth = resolveGoogleAuth();
  if ("error" in auth) throw new Error(auth.error);
  const { query, max_results, page_size, scope, folder, retention } = parseMailSourceConfig(parseSourceConfig(row));
  let labelId = scope === "inbox" ? "INBOX" : undefined;
  if (scope === "folder") {
    const labels = await googleFetch(auth, "Gmail", "https://gmail.googleapis.com/gmail/v1/users/me", "/labels") as {
      labels?: Array<{ id: string; name: string }>; error?: string;
    };
    if (labels.error) throw new Error(labels.error);
    labelId = labels.labels?.find((label) => label.id === folder || label.name === folder)?.id;
    if (!labelId) throw new Error("Gmail label not found. Use an exact label name or ID.");
  }

  const stats: RemoteIndexStats = { scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0 };
  const keep = new Set<string>();
  let pageToken: string | undefined;
  let messageErrors = 0;

  while (stats.scanned < max_results) {
    const limit = Math.min(page_size, max_results - stats.scanned);
    const qs = new URLSearchParams({ maxResults: String(limit) });
    if (query) qs.set("q", query);
    if (labelId) qs.set("labelIds", labelId);
    if (scope === "all" || scope === "folder") qs.set("includeSpamTrash", "true");
    if (pageToken) qs.set("pageToken", pageToken);
    const list = await googleFetch(
      auth,
      "Gmail",
      "https://gmail.googleapis.com/gmail/v1/users/me",
      `/messages?${qs.toString()}`,
    ) as GmailMessageList;
    if (list.error) throw new Error(list.error);

    const batch = list.messages ?? [];
    if (batch.length === 0) break;

    // Use allSettled so a single 404/transient 5xx on one message
    // doesn't bin the whole page (and stall the cursor on the next
    // run). Failures get counted into stats.errors instead.
    const settled = await Promise.allSettled(batch.slice(0, limit).map(async (entry) => {
      const msg = await googleFetch(
        auth,
        "Gmail",
        "https://gmail.googleapis.com/gmail/v1/users/me",
        `/messages/${encodeURIComponent(entry.id)}?format=full`,
      ) as GmailMessage;
      if (msg.error) throw new Error(msg.error);
      const title = msg.payload ? header(msg.payload.headers, "Subject") ?? entry.id : entry.id;
      const body = extractGmailBody(msg.payload);
      const text = [
        `From: ${header(msg.payload?.headers, "From") ?? ""}`,
        `To: ${header(msg.payload?.headers, "To") ?? ""}`,
        `Subject: ${title}`,
        `Date: ${header(msg.payload?.headers, "Date") ?? ""}`,
        msg.snippet ? `Snippet: ${msg.snippet}` : null,
        "",
        body,
      ].filter((line): line is string => line !== null).join("\n");
      const updatedAt = msg.internalDate
        ? new Date(Number(msg.internalDate)).toISOString()
        : header(msg.payload?.headers, "Date") ?? new Date().toISOString();
      return upsertRemoteDocument(row.id, {
        path: `gmail://${entry.id}`,
        title,
        externalUpdatedAt: updatedAt,
        text,
      });
    }));

    for (const [index, outcome] of settled.entries()) {
      const id = batch[index]?.id ?? "";
      if (id) keep.add(`gmail://${id}`);
      stats.scanned++;
      if (outcome.status === "rejected") {
        messageErrors++;
        stats.errors++;
        console.warn(`[mail-indexer] message ${id} failed:`, outcome.reason);
        continue;
      }
      const item = outcome.value;
      stats.added += item.status === "added" ? 1 : 0;
      stats.updated += item.status === "updated" ? 1 : 0;
      stats.unchanged += item.status === "unchanged" ? 1 : 0;
      stats.errors += item.embedError ? 1 : 0;
      stats.embedFailed = (stats.embedFailed ?? 0) + Math.max(item.chunks - item.embedded, 0);
      if (item.embedError && !stats.embedError) stats.embedError = item.embedError;
    }

    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }

  if (scope && messageErrors > 0) {
    throw new Error(`${messageErrors} Gmail messages could not be indexed. Successfully indexed emails were kept; retry the source.`);
  }
  stats.removed = retention === "mirror" ? evictMissing(row.id, keep) : 0;
  return stats;
}

async function indexOutlookMail(row: DocumentSourceRow): Promise<RemoteIndexStats> {
  const auth = resolveMicrosoftAuth();
  if ("error" in auth) throw new Error(auth.error);
  const { query, max_results, page_size, scope, folder, retention } = parseMailSourceConfig(parseSourceConfig(row));
  const endpoint = scope === "inbox" ? "/me/mailFolders/inbox/messages"
    : scope === "folder" ? `/me/mailFolders/${encodeURIComponent(folder!)}/messages`
      : "/me/messages";
  const headers: Record<string, string> = { ConsistencyLevel: "eventual" };
  if (scope) headers.Prefer = 'IdType="ImmutableId"';

  const stats: RemoteIndexStats = { scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0 };
  const keep = new Set<string>();
  let nextLink: string | null = null;

  while (stats.scanned < max_results) {
    const limit = Math.min(page_size, max_results - stats.scanned);
    const qs = new URLSearchParams({
      "$top": String(limit),
      "$select": "id",
    });
    if (query) qs.set("$search", `"${query.replace(/"/g, '\\"')}"`);
    else qs.set("$orderby", "receivedDateTime desc");
    const data = await graphFetch(auth, nextLink ?? `${endpoint}?${qs}`, { headers });
    const payload = data as { value?: GraphMessage[]; "@odata.nextLink"?: string; error?: string };
    if (payload.error) throw new Error(payload.error);

    const batch = payload.value ?? [];
    if (batch.length === 0) break;

    const results = await Promise.all(batch.slice(0, limit).map(async (entry) => {
      if (!entry.id) throw new Error("Outlook returned a message without an ID.");
      const msg = await graphFetch(auth, `/me/messages/${encodeURIComponent(entry.id)}`, { headers }) as GraphMessage & { error?: string };
      if (msg.error) throw new Error(msg.error);
      const summary = summarizeGraphMessage(msg);
      return upsertRemoteDocument(row.id, {
        path: `outlook://${msg.id ?? entry.id}`,
        title: summary.title,
        externalUpdatedAt: summary.updatedAt,
        text: summary.text,
      });
    }));

    for (const [index, item] of results.entries()) {
      const id = batch[index]?.id ?? "";
      if (id) keep.add(`outlook://${id}`);
      stats.scanned++;
      stats.added += item.status === "added" ? 1 : 0;
      stats.updated += item.status === "updated" ? 1 : 0;
      stats.unchanged += item.status === "unchanged" ? 1 : 0;
      stats.errors += item.embedError ? 1 : 0;
      stats.embedFailed = (stats.embedFailed ?? 0) + Math.max(item.chunks - item.embedded, 0);
      if (item.embedError && !stats.embedError) stats.embedError = item.embedError;
    }

    nextLink = payload["@odata.nextLink"] ?? null;
    if (scope && query && stats.scanned >= 1_000 && max_results > 1_000) {
      throw new Error("Outlook search reached Microsoft's 1,000-result ceiling. Narrow or remove the optional search for complete coverage. Indexed emails were kept.");
    }
    if (!nextLink) break;
  }

  stats.removed = retention === "mirror" ? evictMissing(row.id, keep) : 0;
  return stats;
}

export async function runMailIndexer(source: DocumentSourceRow): Promise<RemoteIndexStats> {
  switch (source.kind) {
    case "gmail_mail":
      return indexGmailMail(source);
    case "outlook_mail":
      return indexOutlookMail(source);
    case "icloud_mail":
      return indexICloudMail(source);
    default:
      throw new Error(`unsupported mail source kind: ${source.kind}`);
  }
}
