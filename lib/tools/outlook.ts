/**
 * Native Outlook / Microsoft Graph mail tools. Mirrors lib/tools/gmail.ts
 * one-for-one (search/get/list_folders/modify/create_draft/trash) but
 * targets graph.microsoft.com/v1.0/me/messages and uses the shared
 * Microsoft auth helpers from lib/integrations/microsoft-oauth.ts.
 *
 * Design parity with Gmail:
 *   - drafts for review by default, direct send only when the user asks.
 *   - same mail-management surface so the agent's mental model carries over.
 *   - JSON outputs slimmed to fields the agent actually uses; full
 *     bodies are capped at 30KB to keep context manageable.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { stripHtml } from "@/lib/utils/html";
import { truncateBytes } from "@/lib/utils/text";
import { registerLangChainPackage } from "./langchain-package";
import {
  graphFetch,
  resolveMicrosoftAuth,
  type MicrosoftAuth,
} from "@/lib/integrations/microsoft-oauth";

// Exposed for the integrations test endpoint.
export function _resolveOutlookAuth(): MicrosoftAuth | { error: string } {
  return resolveMicrosoftAuth();
}

// ── Type shapes (minimal subset of Graph's Message resource) ───────────────

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
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  parentFolderId?: string;
  webLink?: string;
}
interface GraphFolder {
  id?: string;
  displayName?: string;
  parentFolderId?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
  wellKnownName?: string;
}

function recipientToStr(r?: GraphRecipient): string | null {
  const addr = r?.emailAddress?.address;
  if (!addr) return null;
  const name = r?.emailAddress?.name;
  return name && name !== addr ? `${name} <${addr}>` : addr;
}

function summarizeMessage(m: GraphMessage): Record<string, unknown> {
  return {
    id: m.id,
    conversation_id: m.conversationId,
    from: recipientToStr(m.from),
    to: (m.toRecipients ?? []).map(recipientToStr).filter(Boolean),
    cc: (m.ccRecipients ?? []).map(recipientToStr).filter(Boolean),
    subject: m.subject ?? null,
    received: m.receivedDateTime ?? null,
    is_read: m.isRead === true,
    is_draft: m.isDraft === true,
    has_attachments: m.hasAttachments === true,
    categories: m.categories ?? [],
    folder_id: m.parentFolderId ?? null,
    snippet: m.bodyPreview ?? null,
    web_link: m.webLink ?? null,
  };
}

const BODY_CAP = 30_000;
const DRAFT_BODY_MAX_CHARS = 100_000;
const SEND_BODY_MAX_CHARS = 100_000;

// ── Tools ───────────────────────────────────────────────────────────────────

export const outlookSearchTool = tool(
  async ({ query, max_results }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const top = Math.min(Math.max(max_results ?? 25, 1), 100);
    // Use $search (KQL); Graph requires the ConsistencyLevel:eventual header
    // when $search is present on /messages.
    const params = new URLSearchParams({
      $top: String(top),
      $select: "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,isDraft,hasAttachments,categories,parentFolderId,webLink",
    });
    // $search wants a quoted KQL query; pass through whatever the agent supplied.
    params.set("$search", `"${query.replace(/"/g, '\\"')}"`);
    const data = await graphFetch(
      auth,
      `/me/messages?${params.toString()}`,
      { headers: { ConsistencyLevel: "eventual" } },
    ) as { value?: GraphMessage[]; "@odata.count"?: number; "@odata.nextLink"?: string; error?: string };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      query,
      total_count: data["@odata.count"] ?? null,
      next_link: data["@odata.nextLink"] ?? null,
      messages: (data.value ?? []).map(summarizeMessage),
    });
  },
  {
    name: "outlook_search",
    description:
      "Search the user's Outlook mailbox using KQL (Microsoft's keyword query language). " +
      "Returns message metadata (from, to, subject, received, snippet, labels) plus @odata.count " +
      "and next_link when available. Examples: " +
      "'from:notifications@github.com', 'subject:invoice hasAttachment:true', " +
      "'isRead:false received>=2026-05-17'. **Use this before calling outlook_get_message** — " +
      "the snippet is often enough.",
    schema: z.object({
      query: z.string().describe("KQL query string"),
      max_results: z.number().int().optional().describe("Max messages (default 25, max 100)"),
    }),
  },
);

export const outlookGetMessageTool = tool(
  async ({ id }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const m = await graphFetch(
      auth,
      `/me/messages/${encodeURIComponent(id)}`,
    ) as GraphMessage & { error?: string };
    if (m.error) return JSON.stringify(m);
    const summary = summarizeMessage(m);
    const rawBody = m.body?.content ?? "";
    const plain = m.body?.contentType === "html"
      ? stripHtml(rawBody, { preserveParagraphs: true })
      : rawBody;
    const { text: body, truncated } = truncateBytes(plain, BODY_CAP);
    return JSON.stringify({ ...summary, body, truncated });
  },
  {
    name: "outlook_get_message",
    description:
      "Fetch one Outlook message by id, including full headers and the decoded text body " +
      "(HTML stripped to plain text when needed). Body capped at 30KB with `truncated:true` " +
      "when cut off.",
    schema: z.object({
      id: z.string().describe("Outlook message id (from outlook_search results)"),
    }),
  },
);

export const outlookListFoldersTool = tool(
  async () => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await graphFetch(
      auth,
      "/me/mailFolders?$top=100&$select=id,displayName,parentFolderId,totalItemCount,unreadItemCount,wellKnownName",
    ) as { value?: GraphFolder[]; error?: string };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      folders: (data.value ?? []).map((f) => ({
        id: f.id,
        name: f.displayName ?? null,
        parent_id: f.parentFolderId ?? null,
        total: f.totalItemCount ?? 0,
        unread: f.unreadItemCount ?? 0,
        // Well-known shortcuts like 'inbox', 'drafts', 'sentitems',
        // 'deleteditems', 'junkemail', 'archive', 'outbox'. Useful as
        // stable ids when you need to move messages.
        well_known: f.wellKnownName ?? null,
      })),
    });
  },
  {
    name: "outlook_list_folders",
    description:
      "List all Outlook mail folders. Use the `id` (or `well_known` name like 'inbox', " +
      "'drafts', 'sentitems', 'deleteditems', 'archive') with outlook_modify_message to move " +
      "a message between folders.",
    schema: z.object({}),
  },
);

export const outlookModifyMessageTool = tool(
  async ({ id, mark_read, move_to_folder }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (mark_read === undefined && !move_to_folder) {
      return JSON.stringify({ error: "Provide mark_read and/or move_to_folder" });
    }

    let lastResult: unknown = null;
    if (mark_read !== undefined) {
      const r = await graphFetch(
        auth,
        `/me/messages/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify({ isRead: mark_read }) },
      ) as GraphMessage & { error?: string };
      if (r.error) return JSON.stringify({ error: r.error });
      lastResult = summarizeMessage(r);
    }
    if (move_to_folder) {
      // The /move action returns the **new** message resource (id changes
      // because Graph clones the item into the target folder).
      const r = await graphFetch(
        auth,
        `/me/messages/${encodeURIComponent(id)}/move`,
        { method: "POST", body: JSON.stringify({ destinationId: move_to_folder }) },
      ) as GraphMessage & { error?: string };
      if (r.error) return JSON.stringify({ error: r.error });
      lastResult = summarizeMessage(r);
    }
    return JSON.stringify(lastResult);
  },
  {
    name: "outlook_modify_message",
    description:
      "Modify an Outlook message: mark read/unread and/or move to another folder. Use " +
      "`mark_read: true` to mark read, `mark_read: false` to mark unread. `move_to_folder` " +
      "accepts a folder id from outlook_list_folders or a well-known name (e.g. 'archive', " +
      "'deleteditems'). Note that moving returns a NEW message id because Graph clones the " +
      "item into the destination folder.",
    schema: z.object({
      id: z.string().describe("Outlook message id"),
      mark_read: z.boolean().optional().describe("Mark read (true) or unread (false)"),
      move_to_folder: z.string().optional().describe("Destination folder id or well-known name"),
    }),
  },
);

export const outlookCreateDraftTool = tool(
  async ({ to, cc, subject, body, content_type }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const draft = {
      subject: subject ?? "",
      body: {
        contentType: content_type === "html" ? "html" : "text",
        content: body ?? "",
      },
      toRecipients: to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (cc ?? []).map((address) => ({ emailAddress: { address } })),
    };
    const r = await graphFetch(
      auth,
      "/me/messages",
      { method: "POST", body: JSON.stringify(draft) },
    ) as GraphMessage & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({
      ...summarizeMessage(r),
      note: "Saved to Drafts. The user must open Outlook to review and send.",
    });
  },
  {
    name: "outlook_create_draft",
    description:
      "Create an Outlook draft email (saved to the Drafts folder, NOT sent). The user opens " +
      "Outlook to review and click Send. `to` and `cc` are arrays of plain email addresses. " +
      "`content_type` defaults to 'text'; pass 'html' if `body` contains HTML markup.",
    schema: z.object({
      to: z.array(z.string().email()).min(1).describe("Primary recipient emails"),
      cc: z.array(z.string().email()).optional().describe("CC recipient emails"),
      subject: z.string().optional().describe("Subject line"),
      body: z.string().max(DRAFT_BODY_MAX_CHARS).optional().describe("Email body (max 100,000 characters)"),
      content_type: z.enum(["text", "html"]).optional().describe("Body content type (default 'text')"),
    }),
  },
);

export const outlookTrashMessageTool = tool(
  async ({ id }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Move to the user's Deleted Items folder (well-known shortcut). This
    // matches Gmail's "trash, don't hard-delete" behavior.
    const r = await graphFetch(
      auth,
      `/me/messages/${encodeURIComponent(id)}/move`,
      { method: "POST", body: JSON.stringify({ destinationId: "deleteditems" }) },
    ) as GraphMessage & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({ ok: true, new_id: r.id });
  },
  {
    name: "outlook_trash_message",
    description:
      "Move an Outlook message to Deleted Items (recoverable from the trash for 30 days). " +
      "Does NOT permanently delete. Returns the new message id assigned after the move.",
    schema: z.object({
      id: z.string().describe("Outlook message id to trash"),
    }),
  },
);

export const outlookSendEmailTool = tool(
  async ({ to, cc, bcc, subject, body, content_type, save_to_sent_items }) => {
    const auth = resolveMicrosoftAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const message = {
      subject: subject ?? "",
      body: {
        contentType: content_type === "html" ? "html" : "text",
        content: body ?? "",
      },
      toRecipients: to.map((address) => ({ emailAddress: { address } })),
      ccRecipients: (cc ?? []).map((address) => ({ emailAddress: { address } })),
      bccRecipients: (bcc ?? []).map((address) => ({ emailAddress: { address } })),
    };
    const r = await graphFetch(
      auth,
      "/me/sendMail",
      {
        method: "POST",
        body: JSON.stringify({
          message,
          saveToSentItems: save_to_sent_items ?? true,
        }),
      },
    ) as { ok?: boolean; error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({ ok: true, sent: true, save_to_sent_items: save_to_sent_items ?? true });
  },
  {
    name: "outlook_send_email",
    description:
      "Send an Outlook email immediately via Microsoft Graph. Only use when the user explicitly asks " +
      "to send now; otherwise create a draft with outlook_create_draft. Supports text or HTML bodies " +
      "via `content_type`. If this returns a 403 scope error, ask the user to reconnect Outlook so " +
      "Mail.Send is granted.",
    schema: z.object({
      to: z.array(z.string().email()).min(1).describe("Primary recipient emails"),
      cc: z.array(z.string().email()).optional().describe("CC recipient emails"),
      bcc: z.array(z.string().email()).optional().describe("BCC recipient emails"),
      subject: z.string().optional().describe("Subject line"),
      body: z.string().max(SEND_BODY_MAX_CHARS).optional().describe("Email body (max 100,000 characters)"),
      content_type: z.enum(["text", "html"]).optional().describe("Body content type (default 'text')"),
      save_to_sent_items: z.boolean().optional().describe("Whether Graph should save the message to Sent Items (default true)"),
    }),
  },
);

registerLangChainPackage({
  category: "Mail",
  tools: {
    read: [outlookSearchTool, outlookGetMessageTool, outlookListFoldersTool],
    write: [outlookModifyMessageTool, outlookCreateDraftTool, outlookTrashMessageTool],
    execute: [outlookSendEmailTool],
  },
});
