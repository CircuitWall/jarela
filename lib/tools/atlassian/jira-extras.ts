// Jira issue extras — comments CRUD, worklogs, attachments, changelog. Split
// out of the monolithic lib/tools/atlassian.ts in the bloat-audit refactor.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveAuth, atlassianFetch, authHeader } from "./_auth";
import { textToADF, simplifyADF } from "./_helpers";

// These fill specific gaps left by the issue-CRUD tools above:
//   - jira_get_issue caps embedded comments at ~50; jira_get_comments paginates.
//   - jira_update_issue can't touch existing comments — that needs the per-comment endpoint.
//   - jira_upload_attachment uploads but doesn't read or delete; the get/delete pair completes it.
//   - jira_get_issue's changelog field is opt-in via expand and capped; the dedicated endpoint paginates.
// See ADR-0035.

export const jiraGetCommentsTool = tool(
  async ({ issue_key, start_at, max_results, order_by }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (start_at !== undefined) params.set("startAt", String(start_at));
    params.set("maxResults", String(Math.min(max_results ?? 50, 100)));
    if (order_by) params.set("orderBy", order_by);
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}/comment?${params}`,
    ) as {
      comments?: Array<Record<string, unknown>>;
      startAt?: number; maxResults?: number; total?: number;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      issue_key,
      start_at: data.startAt ?? 0,
      max_results: data.maxResults ?? 0,
      total: data.total ?? 0,
      comments: (data.comments ?? []).map((c) => ({
        id: c.id,
        author: (c.author as Record<string, unknown>)?.displayName ?? null,
        created: c.created,
        updated: c.updated,
        body: simplifyADF(c.body),
      })),
    });
  },
  {
    name: "jira_get_comments",
    description:
      "Paginated comment list for a Jira issue. Use this when an issue has more comments than the " +
      "embedded list returned by jira_get_issue (Jira caps that at ~50). order_by accepts 'created' " +
      "or '-created' for ascending/descending. ADF bodies auto-flattened.",
    schema: z.object({
      issue_key: z.string(),
      start_at: z.number().optional().describe("Offset for pagination (default 0)"),
      max_results: z.number().optional().describe("Default 50, max 100"),
      order_by: z.enum(["created", "-created"]).optional(),
    }),
  },
);

export const jiraUpdateCommentTool = tool(
  async ({ issue_key, comment_id, body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}/comment/${encodeURIComponent(comment_id)}`,
      { method: "PUT", body: JSON.stringify({ body: textToADF(body) }) },
    ) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, comment_id: data.id ?? comment_id });
  },
  {
    name: "jira_update_comment",
    description:
      "Edit an existing comment on a Jira issue. Plain-text body is auto-converted to ADF (same as " +
      "jira_add_comment). The author and created timestamp are preserved; updated reflects this edit.",
    schema: z.object({
      issue_key: z.string(),
      comment_id: z.string().describe("Comment id from jira_get_issue.comments[].id or jira_get_comments"),
      body: z.string(),
    }),
  },
);

export const jiraDeleteCommentTool = tool(
  async ({ issue_key, comment_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}/comment/${encodeURIComponent(comment_id)}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_comment_id: comment_id, issue_key });
  },
  {
    name: "jira_delete_comment",
    description:
      "Permanently delete a comment from a Jira issue. **Destructive — no undo.** Look up the id via " +
      "jira_get_issue (include_comments: true) or jira_get_comments. Disable to make the agent unable " +
      "to delete comments.",
    schema: z.object({ issue_key: z.string(), comment_id: z.string() }),
  },
);

export const jiraGetAttachmentContentTool = tool(
  async ({ content_url, as_text }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Attachment content URLs from /rest/api/3/issue/{key} come pre-built as
    // absolute URLs under the auth.url host. We accept either absolute or
    // relative; build the request URL accordingly.
    const fullUrl = content_url.startsWith("http")
      ? content_url
      : `${auth.url}${content_url.startsWith("/") ? "" : "/"}${content_url}`;
    const res = await fetch(fullUrl, { headers: { Authorization: authHeader(auth) } });
    if (!res.ok) {
      const errText = await res.text();
      return JSON.stringify({ error: `Atlassian ${res.status}: ${errText.slice(0, 500)}` });
    }
    const ct = res.headers.get("content-type") ?? "";
    const looksText = as_text === true
      || (as_text !== false && /^(text\/|application\/(json|xml|yaml|x-yaml))/i.test(ct));
    if (looksText) {
      const text = await res.text();
      return JSON.stringify({
        content_type: ct,
        size: text.length,
        as: "text",
        content: text.slice(0, 50_000),
        truncated: text.length > 50_000,
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return JSON.stringify({
      content_type: ct,
      size: buf.length,
      as: "base64",
      content: buf.toString("base64"),
    });
  },
  {
    name: "jira_get_attachment_content",
    description:
      "Fetch a Jira issue attachment's bytes by content_url (from jira_get_issue.attachments[].content_url). " +
      "Returns UTF-8 text capped at 50KB for text-like content types, or base64 for binary. Override the " +
      "auto-detection via `as_text`. Mirrors confluence_get_attachment_content.",
    schema: z.object({
      content_url: z.string().describe("content_url from jira_get_issue.attachments[]"),
      as_text: z.boolean().optional().describe(
        "Force text decode (true) or binary base64 (false). Default: auto-detect by content-type.",
      ),
    }),
  },
);

export const jiraDeleteAttachmentTool = tool(
  async ({ attachment_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/attachment/${encodeURIComponent(attachment_id)}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_attachment_id: attachment_id });
  },
  {
    name: "jira_delete_attachment",
    description:
      "Permanently delete an attachment from a Jira issue by id. **Destructive — no undo.** Look up " +
      "the id via jira_get_issue.attachments[].id. Disable to make the agent unable to delete attachments.",
    schema: z.object({
      attachment_id: z.string().describe("Attachment id (from jira_get_issue.attachments[].id)"),
    }),
  },
);

export const jiraAddWorklogTool = tool(
  async ({ issue_key, time_spent, started, comment }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = { timeSpent: time_spent };
    if (started) body.started = started;
    if (comment) body.comment = textToADF(comment);
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}/worklog`,
      { method: "POST", body: JSON.stringify(body) },
    ) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, worklog_id: data.id, issue_key });
  },
  {
    name: "jira_add_worklog",
    description:
      "Log time spent on a Jira issue. time_spent uses Jira's duration syntax: '1h', '30m', '2d 4h', etc. " +
      "started is an ISO 8601 timestamp (defaults to now). comment is plain text auto-converted to ADF.",
    schema: z.object({
      issue_key: z.string(),
      time_spent: z.string().describe("Duration string ('1h', '30m', '2d 4h')"),
      started: z.string().optional().describe("ISO 8601 timestamp; defaults to now"),
      comment: z.string().optional(),
    }),
  },
);

export const jiraListWorklogsTool = tool(
  async ({ issue_key, start_at, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (start_at !== undefined) params.set("startAt", String(start_at));
    params.set("maxResults", String(Math.min(max_results ?? 50, 1000)));
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}/worklog?${params}`,
    ) as {
      worklogs?: Array<Record<string, unknown>>;
      startAt?: number; maxResults?: number; total?: number;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      issue_key,
      start_at: data.startAt ?? 0,
      max_results: data.maxResults ?? 0,
      total: data.total ?? 0,
      worklogs: (data.worklogs ?? []).map((w) => ({
        id: w.id,
        author: (w.author as Record<string, unknown>)?.displayName ?? null,
        time_spent: w.timeSpent,
        time_spent_seconds: w.timeSpentSeconds,
        started: w.started,
        created: w.created,
        updated: w.updated,
        comment: simplifyADF(w.comment),
      })),
    });
  },
  {
    name: "jira_list_worklogs",
    description:
      "List worklog entries on a Jira issue (paginated). Returns id, author, time_spent (display string + " +
      "seconds), started, comment. Use to compute totals or audit time tracking.",
    schema: z.object({
      issue_key: z.string(),
      start_at: z.number().optional(),
      max_results: z.number().optional().describe("Default 50, max 1000"),
    }),
  },
);

export const jiraGetChangelogTool = tool(
  async ({ issue_key, start_at, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (start_at !== undefined) params.set("startAt", String(start_at));
    params.set("maxResults", String(Math.min(max_results ?? 50, 100)));
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}/changelog?${params}`,
    ) as {
      values?: Array<Record<string, unknown>>;
      startAt?: number; maxResults?: number; total?: number;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      issue_key,
      start_at: data.startAt ?? 0,
      max_results: data.maxResults ?? 0,
      total: data.total ?? 0,
      changelog: (data.values ?? []).map((entry) => ({
        id: entry.id,
        author: (entry.author as Record<string, unknown>)?.displayName ?? null,
        created: entry.created,
        items: ((entry.items as Array<Record<string, unknown>>) ?? []).map((item) => ({
          field: item.field,
          field_type: item.fieldtype,
          // Atlassian returns both `from`/`to` (raw ids) and `fromString`/`toString`
          // (human-readable). Prefer the human form when present. NB: hasOwn check
          // is required because `toString` is inherited from Object.prototype.
          from: Object.hasOwn(item, "fromString") ? item.fromString : (item.from ?? null),
          to: Object.hasOwn(item, "toString") ? item.toString : (item.to ?? null),
        })),
      })),
    });
  },
  {
    name: "jira_get_changelog",
    description:
      "Fetch a Jira issue's history (paginated). Each entry has author, timestamp, and a list of " +
      "field-level changes (field name, from, to). Useful for 'what changed yesterday?' audits and " +
      "for surfacing the previous value of a field.",
    schema: z.object({
      issue_key: z.string(),
      start_at: z.number().optional(),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);
