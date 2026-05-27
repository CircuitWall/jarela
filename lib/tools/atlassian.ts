/**
 * Native Atlassian tools (Jira + Confluence) — direct REST API calls, no MCP.
 *
 * Why this exists: corporate networks often block public PyPI/npm, which makes
 * the `mcp-atlassian` install path fragile. These tools just hit the Atlassian
 * REST API over HTTPS, which goes through the same proxy (EnvHttpProxyAgent)
 * the rest of the server uses — so they work anywhere a browser can reach
 * `*.atlassian.net`.
 *
 * Auth resolution (in priority order):
 *   1. Env: ATLASSIAN_URL, ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN
 *   2. Memory store: namespace="integrations", key="atlassian", value=
 *        { url, email, api_token }
 *
 * The agent can populate option 2 via memory_write if the user shares the
 * credentials in chat — but most users will set env vars at server boot.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { parseJsonSafe } from "@/lib/utils/json";
import { registerTools } from "./registry";

export interface AtlassianAuth {
  url: string;        // e.g. "https://your-team.atlassian.net"
  email: string;
  apiToken: string;
}

// Exposed so the integrations test endpoint can probe the live API after save.
export function _resolveAtlassianAuth(): AtlassianAuth | { error: string } {
  return resolveAuth();
}

function resolveAuth(): AtlassianAuth | { error: string } {
  // Env first (deployment-level config, wins over per-user secrets stored in DB)
  const envUrl = process.env.ATLASSIAN_URL;
  const envEmail = process.env.ATLASSIAN_EMAIL;
  const envToken = process.env.ATLASSIAN_API_TOKEN;
  if (envUrl && envEmail && envToken) {
    return { url: stripTrailingSlash(envUrl), email: envEmail, apiToken: envToken };
  }
  // Saved integration creds (from the Integrations panel in the UI).
  const saved = getIntegrationRaw("atlassian");
  if (saved?.url && saved.email && saved.api_token) {
    return { url: stripTrailingSlash(saved.url), email: saved.email, apiToken: saved.api_token };
  }
  return {
    error:
      "Atlassian not configured. Open the gear menu → Integrations tab and add your Atlassian site URL, " +
      "email, and API token. (Or set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars.)",
  };
}

function stripTrailingSlash(s: string): string { return s.replace(/\/+$/, ""); }

function authHeader(a: AtlassianAuth): string {
  return "Basic " + Buffer.from(`${a.email}:${a.apiToken}`).toString("base64");
}

// Sibling-module accessor: the remote document-RAG indexers (lib/documents/
// remote/{jira,confluence}.ts, ADR-0026) reuse the same proxy-aware fetch
// wrapper + auth header so they don't duplicate the Atlassian REST plumbing.
// Underscore prefix marks it as "internal API, but reachable across modules".
export async function _atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  return atlassianFetch(auth, path, init);
}

async function atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${auth.url}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(auth),
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: `Atlassian ${res.status}: ${text.slice(0, 500)}`, url };
  }
  return parseJsonSafe<unknown>(text, text);
}

// ── Jira tools ──────────────────────────────────────────────────────────────

export const jiraSearchTool = tool(
  async ({ jql, max_results, fields }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 25, 100);
    const fieldList = fields ?? ["summary", "status", "assignee", "priority", "created", "updated"];
    // Atlassian removed /rest/api/3/search in 2025 (returns 410). The replacement
    // is /rest/api/3/search/jql — same JQL semantics, slightly different shape:
    //   - POST body: { jql, fields: string[] | "*all", maxResults?, nextPageToken? }
    //   - Response uses cursor-based `nextPageToken` instead of legacy offset.
    const data = await atlassianFetch(auth, `/rest/api/3/search/jql`, {
      method: "POST",
      body: JSON.stringify({ jql, maxResults: limit, fields: fieldList }),
    }) as { issues?: Array<Record<string, unknown>>; nextPageToken?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      issues: (data.issues ?? []).map((i: Record<string, unknown>) => ({
        key: i.key,
        url: `${auth.url}/browse/${i.key}`,
        summary: (i.fields as Record<string, unknown>)?.summary,
        status: ((i.fields as Record<string, unknown>)?.status as Record<string, unknown>)?.name,
        assignee: ((i.fields as Record<string, unknown>)?.assignee as Record<string, unknown>)?.displayName ?? null,
        priority: ((i.fields as Record<string, unknown>)?.priority as Record<string, unknown>)?.name ?? null,
      })),
      next_page_token: data.nextPageToken ?? null,
    });
  },
  {
    name: "jira_search",
    description:
      "Search Jira issues using JQL. **PREFER THIS over shell-exec'ing the jira CLI** — this tool uses " +
      "the configured Atlassian credentials directly via REST. Returns key, summary, status, assignee. " +
      "JQL examples: 'assignee = currentUser() AND resolution = Unresolved', " +
      "'project = ABC AND status = \"In Progress\"', 'updated >= -7d ORDER BY updated DESC'.",
    schema: z.object({
      jql: z.string().describe("JQL query string"),
      max_results: z.number().optional().describe("Max issues (default 25, max 100)"),
      fields: z.array(z.string()).optional().describe("Field names to fetch; defaults to common ones"),
    }),
  },
);

export const jiraGetIssueTool = tool(
  async ({ issue_key, expand, custom_fields, include_comments }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    let resolvedCustom: Array<{ input: string; id: string; name: string }> = [];
    if (custom_fields?.length) {
      const fieldList = await loadJiraFields(auth);
      if (!Array.isArray(fieldList)) return JSON.stringify(fieldList);
      const r = resolveCustomFieldNames(custom_fields, fieldList);
      if (r.unresolved.length) {
        const candidates = fieldList
          .filter((f) => f.custom)
          .slice(0, 25)
          .map((f) => `${f.name} (${f.id})`)
          .join("; ");
        return JSON.stringify({
          error: `unresolved custom_fields: ${r.unresolved.join(", ")}. Pass either the customfield_NNNNN id or the exact display name.`,
          hint_first_25_custom_fields: candidates,
        });
      }
      resolvedCustom = r.resolved;
    }

    const expandSet = new Set(expand ?? []);
    if (resolvedCustom.length) {
      expandSet.add("names");
      expandSet.add("renderedFields");
    }
    const params: string[] = [];
    if (expandSet.size) params.push(`expand=${[...expandSet].join(",")}`);
    // Always pull issuelinks/subtasks/attachment/parent so callers see what's
    // attached to the issue without a follow-up call. Custom fields are
    // additive — when the caller asked for any, we explicitly enumerate the
    // base set + customs to keep the response shape stable.
    const baseFields = [
      "summary", "description", "status", "issuetype", "priority",
      "assignee", "reporter", "created", "updated", "labels", "components", "comment",
      "issuelinks", "subtasks", "attachment", "parent",
    ];
    if (resolvedCustom.length) {
      params.push(`fields=${[...baseFields, ...resolvedCustom.map((c) => c.id)].join(",")}`);
    } else {
      params.push(`fields=${baseFields.join(",")}`);
    }
    const qs = params.length ? `?${params.join("&")}` : "";

    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}${qs}`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);

    const f = (data.fields ?? {}) as Record<string, unknown>;
    const rendered = (data.renderedFields ?? {}) as Record<string, unknown>;

    const customOut: Record<string, unknown> = {};
    for (const c of resolvedCustom) {
      customOut[c.name] = extractFieldValue(f[c.id], rendered[c.id]);
    }

    // Issue links: each entry has an `id` (needed by jira_delete_link),
    // a type, and one of inwardIssue / outwardIssue depending on direction.
    const issueLinks = ((f.issuelinks as Array<Record<string, unknown>>) ?? []).map((l) => {
      const t = l.type as Record<string, unknown> | undefined;
      const inward = l.inwardIssue as Record<string, unknown> | undefined;
      const outward = l.outwardIssue as Record<string, unknown> | undefined;
      return {
        id: l.id,
        type: t?.name,
        direction: inward ? "inward" : "outward",
        verb: inward ? t?.inward : t?.outward,
        other_issue: inward
          ? { key: inward.key, summary: (inward.fields as Record<string, unknown>)?.summary }
          : outward
          ? { key: outward.key, summary: (outward.fields as Record<string, unknown>)?.summary }
          : null,
      };
    });

    // Remote/web links live under a separate endpoint — fetch in parallel
    // when requested (and if the issue actually has any) so we don't waste a
    // call on every get. Cheap heuristic: only fetch when the caller passed
    // include_remote_links, or always if expand contains "remoteLinks".
    let remoteLinks: Array<Record<string, unknown>> | undefined;
    if (expandSet.has("remoteLinks")) {
      const rl = await atlassianFetch(
        auth,
        `/rest/api/3/issue/${encodeURIComponent(issue_key)}/remotelink`,
      ) as Array<Record<string, unknown>> | { error?: string };
      if (Array.isArray(rl)) {
        remoteLinks = rl.map((entry) => {
          const obj = entry.object as Record<string, unknown> | undefined;
          return { id: entry.id, url: obj?.url, title: obj?.title, summary: obj?.summary };
        });
      }
    }

    return JSON.stringify({
      key: data.key,
      url: `${auth.url}/browse/${data.key}`,
      summary: f.summary,
      description: simplifyADF(f.description),
      status: (f.status as Record<string, unknown>)?.name,
      type: (f.issuetype as Record<string, unknown>)?.name,
      priority: (f.priority as Record<string, unknown>)?.name,
      assignee: (f.assignee as Record<string, unknown>)?.displayName ?? null,
      reporter: (f.reporter as Record<string, unknown>)?.displayName ?? null,
      created: f.created,
      updated: f.updated,
      labels: f.labels,
      components: ((f.components as Array<Record<string, unknown>>) ?? []).map((c) => c.name),
      comments_count: ((f.comment as Record<string, unknown>)?.total) ?? 0,
      ...(include_comments ? {
        comments: (((f.comment as Record<string, unknown>)?.comments as Array<Record<string, unknown>>) ?? []).map((c) => ({
          id: c.id,
          author: (c.author as Record<string, unknown>)?.displayName ?? null,
          created: c.created,
          updated: c.updated,
          body: simplifyADF(c.body),
        })),
      } : {}),
      parent: f.parent ? {
        key: (f.parent as Record<string, unknown>).key,
        summary: ((f.parent as Record<string, unknown>).fields as Record<string, unknown>)?.summary,
      } : null,
      subtasks: ((f.subtasks as Array<Record<string, unknown>>) ?? []).map((s) => ({
        key: s.key,
        summary: (s.fields as Record<string, unknown>)?.summary,
        status: ((s.fields as Record<string, unknown>)?.status as Record<string, unknown>)?.name,
      })),
      issue_links: issueLinks,
      attachments: ((f.attachment as Array<Record<string, unknown>>) ?? []).map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mime_type: a.mimeType,
        created: a.created,
        author: (a.author as Record<string, unknown>)?.displayName,
        content_url: a.content,
      })),
      ...(remoteLinks !== undefined ? { remote_links: remoteLinks } : {}),
      ...(resolvedCustom.length ? { custom_fields: customOut } : {}),
    });
  },
  {
    name: "jira_get_issue",
    description:
      "Fetch a single Jira issue by key (e.g. 'PROJ-123'). Returns full detail including description, " +
      "parent, sub-tasks, issue_links (with link ids for jira_delete_link), and attachment metadata. " +
      "Pass `expand: ['remoteLinks']` to also fetch web/Confluence/GitHub links. " +
      "Pass `custom_fields` (display names like 'Vulnerability Description', or `customfield_NNNNN` ids) " +
      "to include them in the response under a `custom_fields` map. " +
      "Pass `include_comments: true` to include flattened comment bodies (author, timestamps, text). " +
      "ADF/rich-text is auto-flattened. " +
      "**PREFER THIS over shell-exec'ing the jira CLI.**",
    schema: z.object({
      issue_key: z.string().describe("Issue key like PROJ-123"),
      expand: z.array(z.string()).optional().describe("Fields to expand (e.g. ['changelog', 'transitions'])"),
      custom_fields: z.array(z.string()).optional().describe(
        "Custom field display names ('Vulnerability Description') or ids ('customfield_10473') to include",
      ),
      include_comments: z.boolean().optional().describe(
        "If true, include a `comments` array with author/created/updated/body for each comment. " +
        "Comments come from the same call (no extra API round-trip) but Jira caps the embedded list at ~50 — " +
        "use a follow-up call for issues with more.",
      ),
    }),
  },
);

export const jiraCreateIssueTool = tool(
  async ({ project_key, summary, description, issue_type, parent_key, labels, assignee_account_id, custom_fields }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const fields: Record<string, unknown> = {
      project: { key: project_key },
      summary,
      issuetype: { name: issue_type ?? "Task" },
    };
    if (description) fields.description = textToADF(description);
    if (parent_key) fields.parent = { key: parent_key };
    if (Array.isArray(labels)) fields.labels = labels;
    if (assignee_account_id) fields.assignee = { accountId: assignee_account_id };
    if (custom_fields && typeof custom_fields === "object" && Object.keys(custom_fields).length > 0) {
      const fieldList = await loadJiraFields(auth);
      if (!Array.isArray(fieldList)) return JSON.stringify(fieldList);
      const r = resolveCustomFieldNames(Object.keys(custom_fields), fieldList);
      if (r.unresolved.length) {
        return JSON.stringify({
          error: `unresolved custom_fields: ${r.unresolved.join(", ")}`,
          hint_first_25_custom_fields: fieldList
            .filter((f) => f.custom).slice(0, 25)
            .map((f) => `${f.name} (${f.id})`).join("; "),
        });
      }
      for (const c of r.resolved) {
        fields[c.id] = (custom_fields as Record<string, unknown>)[c.input];
      }
    }
    const data = await atlassianFetch(auth, `/rest/api/3/issue`, {
      method: "POST",
      body: JSON.stringify({ fields }),
    }) as { key?: string; id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      key: data.key,
      url: data.key ? `${auth.url}/browse/${data.key}` : null,
    });
  },
  {
    name: "jira_create_issue",
    description:
      "Create a new Jira issue. Defaults to issue_type='Task'. Pass parent_key to create a sub-task " +
      "or attach a Story to an Epic. Custom fields accept display names or customfield_NNNNN ids. " +
      "**PREFER THIS over shell-exec'ing the jira CLI.**",
    schema: z.object({
      project_key: z.string().describe("Project key (e.g. 'ENG')"),
      summary: z.string().describe("Issue title"),
      description: z.string().optional().describe("Plain-text description (auto-converted to ADF)"),
      issue_type: z.string().optional().describe("Issue type name (default: Task; valid: Task, Bug, Story, Epic, Sub-task, …)"),
      parent_key: z.string().optional().describe(
        "Parent issue key. Required for Sub-task issue types; also used to attach a Story/Task to an Epic.",
      ),
      labels: z.array(z.string()).optional().describe("Labels to set on the new issue"),
      assignee_account_id: z.string().optional().describe(
        "Jira Cloud accountId to assign on creation (use jira_find_user to resolve)",
      ),
      custom_fields: z.record(z.string(), z.unknown()).optional().describe(
        "Map of custom field display names or customfield_NNNNN ids → values (e.g. { 'Due Date': '2026-06-15' })",
      ),
    }),
  },
);

export const jiraAddCommentTool = tool(
  async ({ issue_key, body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(auth, `/rest/api/3/issue/${encodeURIComponent(issue_key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body: textToADF(body) }),
    }) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, comment_id: data.id });
  },
  {
    name: "jira_add_comment",
    description:
      "Add a comment to a Jira issue. Plain text is auto-converted to ADF (Atlassian Document Format). " +
      "**PREFER THIS over shell-exec'ing the jira CLI.**",
    schema: z.object({
      issue_key: z.string(),
      body: z.string().describe("Comment text (plain text, line breaks preserved)"),
    }),
  },
);

export const jiraFindUserTool = tool(
  async ({ query }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/user/search?query=${encodeURIComponent(query)}`,
    ) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      users: data.map((u) => ({
        account_id: u.accountId,
        display_name: u.displayName,
        email: u.emailAddress ?? null,
        active: u.active,
      })),
    });
  },
  {
    name: "jira_find_user",
    description:
      "Look up Jira Cloud users by email or display-name fragment. Returns accountId values " +
      "you can pass to jira_update_issue's assignee_account_id. Use when you only have an email.",
    schema: z.object({
      query: z.string().describe("Email address or partial display name"),
    }),
  },
);

export const jiraUpdateIssueTool = tool(
  async ({
    issue_key, summary, description, priority, assignee_account_id, assignee_email,
    fix_versions, labels, labels_add, labels_remove, custom_fields, parent_key,
  }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const fields: Record<string, unknown> = {};
    const update: Record<string, Array<Record<string, unknown>>> = {};

    if (typeof summary === "string") fields.summary = summary;
    if (typeof description === "string") fields.description = textToADF(description);
    if (typeof priority === "string") fields.priority = { name: priority };
    if (typeof parent_key === "string") {
      // Empty string clears the parent (detach from epic / promote sub-task to standalone).
      fields.parent = parent_key.length > 0 ? { key: parent_key } : null;
    }
    if (Array.isArray(fix_versions)) fields.fixVersions = fix_versions.map((name) => ({ name }));
    if (Array.isArray(labels)) fields.labels = labels;

    // Custom fields: caller passes display names ("Due Date") or ids
    // (customfield_10015) → values. We resolve names → ids via the same
    // /rest/api/3/field cache jira_get_issue uses. Values are passed through
    // verbatim — Jira accepts strings, numbers, arrays, or full ADF docs
    // depending on the field's underlying type, and forcing one shape here
    // would break the others. The model already knows the field type from a
    // prior get_issue call (or an error message will steer it).
    if (custom_fields && typeof custom_fields === "object" && Object.keys(custom_fields).length > 0) {
      const inputs = Object.keys(custom_fields);
      const fieldList = await loadJiraFields(auth);
      if (!Array.isArray(fieldList)) return JSON.stringify(fieldList);
      const r = resolveCustomFieldNames(inputs, fieldList);
      if (r.unresolved.length) {
        return JSON.stringify({
          error: `unresolved custom_fields: ${r.unresolved.join(", ")}. Pass either the customfield_NNNNN id or the exact display name.`,
          hint_first_25_custom_fields: fieldList
            .filter((f) => f.custom)
            .slice(0, 25)
            .map((f) => `${f.name} (${f.id})`)
            .join("; "),
        });
      }
      for (const c of r.resolved) {
        fields[c.id] = (custom_fields as Record<string, unknown>)[c.input];
      }
    }

    if (Array.isArray(labels_add) || Array.isArray(labels_remove)) {
      const ops: Array<Record<string, string>> = [];
      for (const l of labels_add ?? []) ops.push({ add: l });
      for (const l of labels_remove ?? []) ops.push({ remove: l });
      if (ops.length) update.labels = ops;
    }

    // Assignee: explicit accountId wins; otherwise resolve email; "unassigned" / null clears.
    if (assignee_account_id !== undefined) {
      const v = assignee_account_id;
      if (v === null || v === "" || v === "unassigned") {
        fields.assignee = { accountId: null };
      } else {
        fields.assignee = { accountId: v };
      }
    } else if (typeof assignee_email === "string" && assignee_email.length > 0) {
      if (assignee_email === "unassigned") {
        fields.assignee = { accountId: null };
      } else {
        const users = await atlassianFetch(
          auth,
          `/rest/api/3/user/search?query=${encodeURIComponent(assignee_email)}`,
        ) as Array<{ accountId?: string; emailAddress?: string }> | { error?: string };
        if (!Array.isArray(users)) return JSON.stringify(users);
        // Prefer exact email match (case-insensitive); fall back to single result.
        const exact = users.find(
          (u) => (u.emailAddress ?? "").toLowerCase() === assignee_email.toLowerCase(),
        );
        const picked = exact ?? (users.length === 1 ? users[0] : undefined);
        if (!picked?.accountId) {
          return JSON.stringify({
            error: `could not resolve assignee_email "${assignee_email}" — got ${users.length} matches; ` +
              `pass assignee_account_id explicitly`,
            candidates: users.map((u) => ({ email: u.emailAddress, account_id: u.accountId })),
          });
        }
        fields.assignee = { accountId: picked.accountId };
      }
    }

    if (Object.keys(fields).length === 0 && Object.keys(update).length === 0) {
      return JSON.stringify({ error: "no fields to update — pass at least one of summary, description, priority, assignee_*, fix_versions, labels, labels_add, labels_remove, parent_key, custom_fields" });
    }

    const body: Record<string, unknown> = {};
    if (Object.keys(fields).length) body.fields = fields;
    if (Object.keys(update).length) body.update = update;

    const data = await atlassianFetch(auth, `/rest/api/3/issue/${encodeURIComponent(issue_key)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }) as { error?: string } | string;
    // Successful PUT returns 204 No Content → atlassianFetch returns "" (parsed as string).
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      key: issue_key,
      url: `${auth.url}/browse/${issue_key}`,
      updated_fields: [...Object.keys(fields), ...Object.keys(update).map((k) => `${k}(±)`)],
    });
  },
  {
    name: "jira_update_issue",
    description:
      "Edit fields on an existing Jira issue: summary, description, priority, assignee, fix versions, " +
      "labels, and arbitrary custom fields (including 'Due Date' and 'Story Points' on sites where " +
      "those are custom). Pass only the fields you want to change. Description is auto-converted from " +
      "plain text to ADF. Labels support either full replace (`labels`) or incremental " +
      "`labels_add`/`labels_remove`. Assignee can be set by `assignee_account_id` or by " +
      "`assignee_email` (auto-resolved); pass null/\"unassigned\" to clear. Custom fields accept " +
      "display names ('Due Date') or ids ('customfield_10015'); values are passed through verbatim " +
      "(string for date/text, number for numeric, full ADF object for rich-text custom fields). " +
      "**PREFER THIS over shell-exec'ing the jira CLI.** Disable to make the agent read-only.",
    schema: z.object({
      issue_key: z.string().describe("Issue key like PROJ-123"),
      summary: z.string().optional().describe("New issue title"),
      description: z.string().optional().describe(
        "Plain-text description (auto-converted to ADF). Replaces existing description.",
      ),
      priority: z.string().optional().describe("Priority name (e.g. 'High', 'Medium', 'Low')"),
      assignee_account_id: z.string().nullable().optional().describe(
        "Jira Cloud accountId; null or 'unassigned' clears assignee",
      ),
      assignee_email: z.string().optional().describe(
        "Email to resolve via /user/search; alternative to assignee_account_id",
      ),
      fix_versions: z.array(z.string()).optional().describe(
        "Replace fix versions with these names (empty array clears all)",
      ),
      labels: z.array(z.string()).optional().describe(
        "Replace labels entirely with this set (empty array clears all)",
      ),
      labels_add: z.array(z.string()).optional().describe("Labels to add (incremental)"),
      labels_remove: z.array(z.string()).optional().describe("Labels to remove (incremental)"),
      parent_key: z.string().optional().describe(
        "Reparent: pass a parent issue key to attach this issue to (Epic key for Stories, Story/Task key for Sub-tasks). Pass an empty string to detach from the current parent.",
      ),
      custom_fields: z.record(z.string(), z.unknown()).optional().describe(
        "Map of custom field display names or customfield_NNNNN ids → values. " +
        "Examples: { \"Due Date\": \"2026-06-15\", \"Story Points\": 8 }. " +
        "For rich-text custom fields, pass a full ADF document as the value.",
      ),
    }),
  },
);

export const jiraTransitionsTool = tool(
  async ({ issue_key, transition_name }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Step 1: list available transitions for this issue.
    const list = await atlassianFetch(auth, `/rest/api/3/issue/${encodeURIComponent(issue_key)}/transitions`) as { transitions?: Array<{ id: string; name: string }>; error?: string };
    if (list.error) return JSON.stringify(list);
    if (!transition_name) {
      return JSON.stringify({ available_transitions: (list.transitions ?? []).map((t) => t.name) });
    }
    const match = (list.transitions ?? []).find((t) => t.name.toLowerCase() === transition_name.toLowerCase());
    if (!match) {
      return JSON.stringify({
        error: `transition "${transition_name}" not available for ${issue_key}`,
        available: (list.transitions ?? []).map((t) => t.name),
      });
    }
    const data = await atlassianFetch(auth, `/rest/api/3/issue/${encodeURIComponent(issue_key)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: match.id } }),
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, transitioned_to: match.name });
  },
  {
    name: "jira_transition_issue",
    description:
      "Transition a Jira issue's status (e.g. 'In Progress' → 'Done'). " +
      "Call without transition_name to list available transitions for the issue. " +
      "**PREFER THIS over shell-exec'ing the jira CLI.**",
    schema: z.object({
      issue_key: z.string(),
      transition_name: z.string().optional().describe("Name of the transition (case-insensitive). Omit to list."),
    }),
  },
);

export const jiraLinkIssuesTool = tool(
  async ({ from_issue, to_issue, link_type, comment }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    // Step 1: load global link types and resolve the requested name. Same
    // "omit to list" pattern as jira_transition_issue — agents can probe this
    // tool to discover what's available without a separate list endpoint.
    const list = await atlassianFetch(auth, `/rest/api/3/issueLinkType`) as
      | { issueLinkTypes?: Array<{ id: string; name: string; inward: string; outward: string }>; error?: string };
    if ("error" in list && list.error) return JSON.stringify(list);
    const types = list.issueLinkTypes ?? [];
    if (!link_type || !from_issue || !to_issue) {
      return JSON.stringify({
        available_link_types: types.map((t) => ({ name: t.name, outward: t.outward, inward: t.inward })),
        usage: "Pass from_issue, to_issue, and link_type (e.g. 'Blocks'). The link reads as: '<from_issue> <outward verb> <to_issue>'.",
      });
    }
    const wanted = link_type.toLowerCase();
    const match = types.find((t) => t.name.toLowerCase() === wanted);
    if (!match) {
      return JSON.stringify({
        error: `link_type "${link_type}" not configured for this site`,
        available: types.map((t) => t.name),
      });
    }

    // Jira's outwardIssue is the SOURCE (subject of the outward verb), inwardIssue
    // is the TARGET. So `{from: A, to: B, type: "Blocks"}` reads as "A blocks B".
    const body: Record<string, unknown> = {
      type: { name: match.name },
      outwardIssue: { key: from_issue },
      inwardIssue: { key: to_issue },
    };
    if (typeof comment === "string" && comment.length > 0) {
      body.comment = { body: textToADF(comment) };
    }

    const data = await atlassianFetch(auth, `/rest/api/3/issueLink`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as { error?: string } | string;
    // Successful POST returns 201 Created with empty body → "" (string).
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      reads_as: `${from_issue} ${match.outward} ${to_issue}`,
      from: { key: from_issue, url: `${auth.url}/browse/${from_issue}` },
      to: { key: to_issue, url: `${auth.url}/browse/${to_issue}` },
      link_type: match.name,
    });
  },
  {
    name: "jira_link_issues",
    description:
      "Create an issue link between two Jira issues (Blocks, Relates, Duplicates, Cloners, etc.). " +
      "The link reads left-to-right: 'from_issue <outward verb> to_issue'. For example, " +
      "{ from_issue: 'A-1', to_issue: 'B-2', link_type: 'Blocks' } means 'A-1 blocks B-2' " +
      "(and 'B-2 is blocked by A-1' shows on the other side automatically). " +
      "Call without arguments to list available link types for the site. " +
      "**PREFER THIS over shell-exec'ing the jira CLI or hitting REST directly.** Disable to make the agent read-only.",
    schema: z.object({
      from_issue: z.string().optional().describe("Source issue key (subject of the outward verb), e.g. 'PROJ-1'"),
      to_issue: z.string().optional().describe("Target issue key (object of the outward verb), e.g. 'PROJ-2'"),
      link_type: z.string().optional().describe(
        "Link type name, case-insensitive (e.g. 'Blocks', 'Relates', 'Duplicates'). Omit to list available types.",
      ),
      comment: z.string().optional().describe(
        "Optional plain-text comment posted to the from_issue alongside the link",
      ),
    }),
  },
);

// Shape for one issue inside a bulk-create payload. Mirrors the create tool's
// schema so callers building one off a loop don't have to re-learn fields.
const bulkIssueSchema = z.object({
  project_key: z.string(),
  summary: z.string(),
  description: z.string().optional(),
  issue_type: z.string().optional(),
  parent_key: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignee_account_id: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
});

export const jiraCreateIssuesBulkTool = tool(
  async ({ issues }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!issues?.length) return JSON.stringify({ error: "issues array is empty" });
    if (issues.length > 50) return JSON.stringify({ error: `bulk endpoint accepts up to 50 per call (got ${issues.length})` });

    // Custom fields: do ONE field-cache load if any issue uses them, then
    // resolve names → ids per-issue. Bulk creates that share custom fields
    // (the common case) thus only pay the cache cost once.
    let fieldList: JiraFieldDef[] | undefined;
    const anyCustom = issues.some((i) => i.custom_fields && Object.keys(i.custom_fields).length > 0);
    if (anyCustom) {
      const loaded = await loadJiraFields(auth);
      if (!Array.isArray(loaded)) return JSON.stringify(loaded);
      fieldList = loaded;
    }

    const issueUpdates: Array<{ fields: Record<string, unknown> }> = [];
    for (const i of issues) {
      const fields: Record<string, unknown> = {
        project: { key: i.project_key },
        summary: i.summary,
        issuetype: { name: i.issue_type ?? "Task" },
      };
      if (i.description) fields.description = textToADF(i.description);
      if (i.parent_key) fields.parent = { key: i.parent_key };
      if (Array.isArray(i.labels)) fields.labels = i.labels;
      if (i.assignee_account_id) fields.assignee = { accountId: i.assignee_account_id };
      if (i.custom_fields && fieldList) {
        const r = resolveCustomFieldNames(Object.keys(i.custom_fields), fieldList);
        if (r.unresolved.length) {
          return JSON.stringify({ error: `unresolved custom_fields on "${i.summary}": ${r.unresolved.join(", ")}` });
        }
        for (const c of r.resolved) {
          fields[c.id] = (i.custom_fields as Record<string, unknown>)[c.input];
        }
      }
      issueUpdates.push({ fields });
    }

    const data = await atlassianFetch(auth, `/rest/api/3/issue/bulk`, {
      method: "POST",
      body: JSON.stringify({ issueUpdates }),
    }) as {
      issues?: Array<{ key?: string; id?: string }>;
      errors?: Array<{ status: number; elementErrors: { errors?: Record<string, string> } }>;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      created: (data.issues ?? []).map((i) => ({
        key: i.key,
        url: i.key ? `${auth.url}/browse/${i.key}` : null,
      })),
      errors: data.errors ?? [],
    });
  },
  {
    name: "jira_create_issues_bulk",
    description:
      "Create up to 50 Jira issues in a single API call. Each entry takes the same shape as " +
      "jira_create_issue (project_key, summary, description, issue_type, parent_key, labels, " +
      "assignee_account_id, custom_fields). Returns per-issue keys plus any partial errors. " +
      "**PREFER THIS over many sequential jira_create_issue calls** when creating ≥3 tickets.",
    schema: z.object({
      issues: z.array(bulkIssueSchema).describe("Array of issues to create (1–50)"),
    }),
  },
);

export const jiraAddRemoteLinkTool = tool(
  async ({ issue_key, url, title, summary, icon_url, global_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = {
      object: {
        url,
        title,
        ...(summary ? { summary } : {}),
        ...(icon_url ? { icon: { url16x16: icon_url } } : {}),
      },
    };
    // globalId is what makes a remote link idempotent — repeat-posting with
    // the same globalId updates the existing link instead of creating a dup.
    if (global_id) body.globalId = global_id;

    const data = await atlassianFetch(auth, `/rest/api/3/issue/${encodeURIComponent(issue_key)}/remotelink`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as { id?: number; self?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      remote_link_id: data.id,
      issue: { key: issue_key, url: `${auth.url}/browse/${issue_key}` },
      target: { url, title },
    });
  },
  {
    name: "jira_add_remote_link",
    description:
      "Attach a web/external link to a Jira issue (Confluence pages, GitHub PRs, dashboards, Slack threads, " +
      "any URL). Distinct from jira_link_issues, which links one Jira issue to another. " +
      "Pass `global_id` to make the link idempotent — re-posting with the same global_id updates the " +
      "existing link rather than creating a duplicate. **PREFER THIS over pasting URLs into the description.**",
    schema: z.object({
      issue_key: z.string().describe("Issue to attach the link to"),
      url: z.string().describe("Target URL"),
      title: z.string().describe("Link title shown in Jira's 'web links' panel"),
      summary: z.string().optional().describe("Optional one-line description shown under the title"),
      icon_url: z.string().optional().describe("Optional 16×16 icon URL"),
      global_id: z.string().optional().describe(
        "Optional stable identifier for idempotent upserts (e.g. 'github-pr-1234'). Re-posting with the same value updates the existing link.",
      ),
    }),
  },
);

export const jiraDeleteLinkTool = tool(
  async ({ link_id, link_type, kind }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!link_id) return JSON.stringify({ error: "link_id is required (look up via jira_get_issue → issue_links[].id or remote_links[].id)" });

    // "issue" = link between two Jira issues (DELETE /issueLink/{id})
    // "remote" = link to an external URL (DELETE /issue/{key}/remotelink/{id})
    // Caller must specify because the same numeric id can exist in both spaces.
    if (kind === "remote") {
      if (!link_type) {
        return JSON.stringify({ error: "for kind='remote', pass link_type as the issue key (the link is scoped to an issue)" });
      }
      const data = await atlassianFetch(
        auth,
        `/rest/api/3/issue/${encodeURIComponent(link_type)}/remotelink/${encodeURIComponent(link_id)}`,
        { method: "DELETE" },
      ) as { error?: string } | string;
      if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
      return JSON.stringify({ ok: true, deleted: { kind: "remote", link_id, issue_key: link_type } });
    }

    const data = await atlassianFetch(auth, `/rest/api/3/issueLink/${encodeURIComponent(link_id)}`, {
      method: "DELETE",
    }) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted: { kind: "issue", link_id } });
  },
  {
    name: "jira_delete_link",
    description:
      "Delete an issue link (Jira-to-Jira, default) or a remote/web link. Look up the id first with " +
      "jira_get_issue (issue_links[].id or remote_links[].id — pass `expand: ['remoteLinks']` for the latter). " +
      "For remote links, also pass the issue key as `link_type` since the API is scoped per-issue.",
    schema: z.object({
      link_id: z.string().describe("Numeric link id from jira_get_issue"),
      kind: z.enum(["issue", "remote"]).optional().describe(
        "'issue' (default) for Jira-to-Jira links, 'remote' for web/external URL links",
      ),
      link_type: z.string().optional().describe(
        "When kind='remote', the issue key the remote link is attached to (required by Jira's per-issue endpoint)",
      ),
    }),
  },
);

export const jiraUploadAttachmentTool = tool(
  async ({ issue_key, filename, content_base64, content_text }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!content_base64 && !content_text) {
      return JSON.stringify({ error: "pass either content_base64 (binary) or content_text (UTF-8)" });
    }

    const buf = content_base64
      ? Buffer.from(content_base64, "base64")
      : Buffer.from(content_text!, "utf8");

    // Jira attachment uploads require X-Atlassian-Token: no-check (CSRF
    // bypass) and multipart/form-data. node's built-in FormData + Blob (Node
    // 22+) handle the body shape; fetch sets the multipart boundary.
    const form = new FormData();
    form.append("file", new Blob([buf]), filename);

    const url = `${auth.url}/rest/api/3/issue/${encodeURIComponent(issue_key)}/attachments`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader(auth),
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
        // Do NOT set Content-Type — fetch fills in the multipart boundary.
      },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) return JSON.stringify({ error: `Atlassian ${res.status}: ${text.slice(0, 500)}` });
    const parsed = parseJsonSafe<Array<{ id: string; filename: string; size: number; mimeType: string; content: string }>>(text, []);
    return JSON.stringify({
      ok: true,
      issue: { key: issue_key, url: `${auth.url}/browse/${issue_key}` },
      attachments: parsed.map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        mime_type: a.mimeType,
        content_url: a.content,
      })),
    });
  },
  {
    name: "jira_upload_attachment",
    description:
      "Upload a file as an attachment to a Jira issue. Pass content_base64 for binary files (PNG, PDF, " +
      "ZIP, etc.) or content_text for plain UTF-8 text (logs, CSVs, JSON). The agent itself reads/encodes " +
      "the source file — this tool only handles the upload. **PREFER THIS over pasting file contents into " +
      "a comment.** Disable to make the agent unable to add attachments.",
    schema: z.object({
      issue_key: z.string().describe("Issue to attach to"),
      filename: z.string().describe("Filename shown in Jira (include the extension)"),
      content_base64: z.string().optional().describe("Base64-encoded file contents (use for binary)"),
      content_text: z.string().optional().describe("Raw UTF-8 text contents (use for logs/CSVs/JSON)"),
    }),
  },
);

export const jiraDeleteIssueTool = tool(
  async ({ issue_key, delete_subtasks }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const qs = delete_subtasks ? `?deleteSubtasks=true` : "";
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}${qs}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    // Successful DELETE returns 204 No Content → atlassianFetch returns "" (parsed as string).
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted: issue_key });
  },
  {
    name: "jira_delete_issue",
    description:
      "Permanently delete a Jira issue. **DESTRUCTIVE — there is no undo from the API.** By default, " +
      "Jira refuses to delete an issue that has sub-tasks; pass delete_subtasks=true to delete them too. " +
      "Disable this tool entirely to make the agent unable to delete tickets.",
    schema: z.object({
      issue_key: z.string().describe("Issue to delete"),
      delete_subtasks: z.boolean().optional().describe(
        "If true, also delete all sub-tasks. Required when the issue has sub-tasks; otherwise Jira returns 400.",
      ),
    }),
  },
);

// ── Confluence tools ────────────────────────────────────────────────────────
//
// Most tools below use the Confluence v2 REST API (/wiki/api/v2/...). Three
// gaps still require v1 paths as of 2026 and are flagged inline:
//   - confluence_search: v2 has no CQL endpoint.
//   - confluence_upload_attachment: v2 Attachment group is read-only (CONFCLOUD-77196).
//   - confluence_add_label: v2 Label group is read-only (CONFCLOUD-76866).
// The remote document-RAG indexer in lib/documents/remote/confluence.ts (ADR-0026)
// stays on v1 — it has its own concerns and is intentionally untouched here.

export const confluenceSearchTool = tool(
  async ({ cql, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 15, 50);
    // v1: CQL search has no v2 equivalent.
    const data = await atlassianFetch(
      auth,
      `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}`,
    ) as { results?: Array<Record<string, unknown>>; size?: number; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      total: data.size,
      results: (data.results ?? []).map((r: Record<string, unknown>) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        url: `${auth.url}/wiki${((r._links as Record<string, unknown>)?.webui) ?? ""}`,
      })),
    });
  },
  {
    name: "confluence_search",
    description:
      "Search Confluence pages with CQL (Confluence Query Language). " +
      "Examples: 'type=page AND title~\"runbook\"', 'space=ENG AND lastmodified > now(\"-7d\")'.",
    schema: z.object({
      cql: z.string().describe("CQL query string"),
      max_results: z.number().optional().describe("Max results (default 15, max 50)"),
    }),
  },
);

export const confluenceGetPageTool = tool(
  async ({ page_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}?body-format=storage,view&include-version=true`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const body = data.body as Record<string, Record<string, unknown> | undefined> | undefined;
    const storageVal = body?.storage?.value as string | undefined;
    const viewVal = body?.view?.value as string | undefined;
    const links = data._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      id: data.id,
      title: data.title,
      url: webui ? `${auth.url}/wiki${webui}` : null,
      space_id: data.spaceId ?? null,
      parent_id: data.parentId ?? null,
      status: data.status,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? null,
      // body_storage round-trips into confluence_update_page; body_view is rendered HTML
      // for summarization. Each capped to 20KB to keep context lean.
      body_storage: storageVal ? storageVal.slice(0, 20_000) : null,
      body_storage_truncated: storageVal ? storageVal.length > 20_000 : false,
      body_view: viewVal ? viewVal.slice(0, 20_000) : null,
      body_view_truncated: viewVal ? viewVal.length > 20_000 : false,
    });
  },
  {
    name: "confluence_get_page",
    description:
      "Fetch a Confluence page by id (v2). Returns title, space_id, parent_id, version, and BOTH " +
      "body_storage (round-trippable into confluence_update_page) and body_view (rendered HTML, " +
      "easier to summarize). Each body capped at 20KB.",
    schema: z.object({
      page_id: z.string(),
    }),
  },
);

export const confluenceGetPageByTitleTool = tool(
  async ({ space_key, title, include_body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const sid = await resolveSpaceId(auth, space_key);
    if (typeof sid !== "string") return JSON.stringify(sid);
    const params = new URLSearchParams({ title, "space-id": sid, limit: "5" });
    if (include_body) params.set("body-format", "storage");
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages?${params}`) as
      | { results?: Array<Record<string, unknown>>; error?: string };
    if (!Array.isArray(data?.results)) return JSON.stringify(data);
    return JSON.stringify({
      matches: data.results.map((p) => {
        const links = p._links as Record<string, unknown> | undefined;
        const webui = links?.webui as string | undefined;
        const body = p.body as Record<string, Record<string, unknown> | undefined> | undefined;
        return {
          id: p.id,
          title: p.title,
          space_id: p.spaceId,
          parent_id: p.parentId ?? null,
          status: p.status,
          url: webui ? `${auth.url}/wiki${webui}` : null,
          ...(include_body
            ? { body_storage: ((body?.storage?.value as string | undefined) ?? "").slice(0, 20_000) }
            : {}),
        };
      }),
    });
  },
  {
    name: "confluence_get_page_by_title",
    description:
      "Find Confluence page(s) by exact title within a space. Auto-resolves `space_key` (e.g. 'ENG') " +
      "to the v2 space id. Returns up to 5 matches; pass `include_body: true` to also include storage XHTML.",
    schema: z.object({
      space_key: z.string().describe("Space key like 'ENG'"),
      title: z.string().describe("Exact page title (case-sensitive on Cloud)"),
      include_body: z.boolean().optional(),
    }),
  },
);

export const confluenceGetPageChildrenTool = tool(
  async ({ page_id, cursor, limit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 25, 250)) });
    if (cursor) params.set("cursor", cursor);
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/children?${params}`,
    ) as { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      children: (data.results ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        type: p.type,
        status: p.status,
        parent_id: p.parentId ?? null,
        position: p.position ?? null,
      })),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_get_page_children",
    description:
      "List direct children of a Confluence page (cursor-paginated). Pass `cursor` from a prior call's " +
      "`next_cursor` to fetch the next page. Default limit 25 (max 250).",
    schema: z.object({
      page_id: z.string(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
  },
);

export const confluenceGetPageAncestorsTool = tool(
  async ({ page_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/ancestors`,
    ) as { results?: Array<Record<string, unknown>>; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ancestors: (data.results ?? []).map((a) => ({ id: a.id, title: a.title, type: a.type })),
    });
  },
  {
    name: "confluence_get_page_ancestors",
    description:
      "Return the parent chain (root → leaf) for a Confluence page. Useful for breadcrumbs and " +
      "understanding where a page lives in the tree.",
    schema: z.object({ page_id: z.string() }),
  },
);

export const confluenceListSpacesTool = tool(
  async ({ cursor, limit, type, status }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 25, 250)) });
    if (cursor) params.set("cursor", cursor);
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    const data = await atlassianFetch(auth, `/wiki/api/v2/spaces?${params}`) as
      | { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      spaces: (data.results ?? []).map((s) => ({
        id: s.id,
        key: s.key,
        name: s.name,
        type: s.type,
        status: s.status,
        homepage_id: s.homepageId ?? null,
      })),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_list_spaces",
    description:
      "List Confluence spaces (cursor-paginated). Returns id, key, name, type, status, homepage_id. " +
      "Useful for discovering space keys to pass to confluence_create_page or confluence_get_page_by_title.",
    schema: z.object({
      cursor: z.string().optional(),
      limit: z.number().optional(),
      type: z.enum(["global", "personal", "collaboration", "knowledge_base"]).optional(),
      status: z.enum(["current", "archived"]).optional(),
    }),
  },
);

export const confluenceGetCommentsTool = tool(
  async ({ page_id, include_inline }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const footerData = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/footer-comments?body-format=storage&limit=100`,
    ) as { results?: Array<Record<string, unknown>>; error?: string };
    let inlineData: { results?: Array<Record<string, unknown>>; error?: string } | undefined;
    if (include_inline !== false) {
      // Known v2 bug: some sites 404 here even when comments exist. Tolerate
      // and surface as `inline_warning` so the caller still gets footer comments.
      inlineData = await atlassianFetch(
        auth,
        `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/inline-comments?body-format=storage&limit=100`,
      ) as { results?: Array<Record<string, unknown>>; error?: string };
    }
    if (footerData.error && !Array.isArray(footerData.results)) return JSON.stringify(footerData);
    const flatten = (c: Record<string, unknown>) => {
      const ver = c.version as Record<string, unknown> | undefined;
      const body = c.body as Record<string, Record<string, unknown> | undefined> | undefined;
      return {
        id: c.id,
        version: ver?.number ?? null,
        author_id: c.authorId ?? ver?.authorId ?? null,
        created_at: ver?.createdAt ?? null,
        body_storage: (body?.storage?.value as string | undefined) ?? null,
        parent_comment_id: c.parentCommentId ?? null,
      };
    };
    return JSON.stringify({
      footer_comments: (footerData.results ?? []).map(flatten),
      inline_comments: inlineData && Array.isArray(inlineData.results) ? inlineData.results.map(flatten) : [],
      ...(inlineData && inlineData.error ? { inline_warning: inlineData.error } : {}),
    });
  },
  {
    name: "confluence_get_comments",
    description:
      "List footer comments (and inline comments by default) on a Confluence page. Returns id, " +
      "version, author_id, created_at, body_storage, parent_comment_id (for threading). Tolerates " +
      "the known v2 inline-comments 404 bug — surfaces it as `inline_warning` rather than failing.",
    schema: z.object({
      page_id: z.string(),
      include_inline: z.boolean().optional().describe("Default true; pass false to skip inline-comments."),
    }),
  },
);

export const confluenceListAttachmentsTool = tool(
  async ({ page_id, cursor, limit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 50, 250)) });
    if (cursor) params.set("cursor", cursor);
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/attachments?${params}`,
    ) as { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      attachments: (data.results ?? []).map((a) => {
        const ver = a.version as Record<string, unknown> | undefined;
        const links = a._links as Record<string, unknown> | undefined;
        return {
          id: a.id,
          title: a.title,
          media_type: a.mediaType,
          file_size: a.fileSize ?? null,
          created_at: ver?.createdAt ?? null,
          download_link: a.downloadLink ?? null,
          webui_link: links?.webui ?? null,
        };
      }),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_list_attachments",
    description:
      "List attachments on a Confluence page (cursor-paginated). Returns id, title, media_type, " +
      "file_size, download_link. Use confluence_get_attachment_content with the download_link to " +
      "fetch bytes.",
    schema: z.object({
      page_id: z.string(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
  },
);

export const confluenceGetLabelsTool = tool(
  async ({ page_id, cursor, limit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams({ limit: String(Math.min(limit ?? 50, 250)) });
    if (cursor) params.set("cursor", cursor);
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/labels?${params}`,
    ) as { results?: Array<Record<string, unknown>>; _links?: { next?: string }; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      labels: (data.results ?? []).map((l) => ({ id: l.id, name: l.name, prefix: l.prefix })),
      next_cursor: parseV2NextCursor(data._links?.next),
    });
  },
  {
    name: "confluence_get_labels",
    description: "List labels on a Confluence page (cursor-paginated). Default limit 50 (max 250).",
    schema: z.object({
      page_id: z.string(),
      cursor: z.string().optional(),
      limit: z.number().optional(),
    }),
  },
);

export const confluenceGetAttachmentContentTool = tool(
  async ({ download_link, as_text }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // download_link from v2 is typically `/download/attachments/{pageId}/{filename}?...`
    // — under the /wiki app, NOT under the bare auth.url. Build the absolute URL
    // explicitly because atlassianFetch's plain `${auth.url}${path}` join would
    // miss the /wiki prefix.
    const fullUrl = download_link.startsWith("http")
      ? download_link
      : download_link.startsWith("/wiki")
        ? `${auth.url}${download_link}`
        : `${auth.url}/wiki${download_link.startsWith("/") ? "" : "/"}${download_link}`;
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
    name: "confluence_get_attachment_content",
    description:
      "Fetch an attachment's bytes by its download_link (from confluence_list_attachments). Returns " +
      "UTF-8 text (capped at 50KB) for text-like content types, or base64 for binary. Override the " +
      "auto-detection via `as_text`.",
    schema: z.object({
      download_link: z.string().describe("download_link from confluence_list_attachments"),
      as_text: z.boolean().optional().describe(
        "Force text decode (true) or binary base64 (false). Default: auto-detect by content-type.",
      ),
    }),
  },
);

export const confluenceCreatePageTool = tool(
  async ({ space_key, title, parent_id, body_text, body_storage }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const sid = await resolveSpaceId(auth, space_key);
    if (typeof sid !== "string") return JSON.stringify(sid);
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);
    const payload: Record<string, unknown> = {
      spaceId: sid,
      status: "current",
      title,
      body: { representation: body.representation, value: body.value },
    };
    if (parent_id) payload.parentId = parent_id;
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages`, {
      method: "POST",
      body: JSON.stringify(payload),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const links = data._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      ok: true,
      id: data.id,
      title: data.title,
      space_id: data.spaceId,
      parent_id: data.parentId ?? null,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? 1,
      url: webui ? `${auth.url}/wiki${webui}` : null,
    });
  },
  {
    name: "confluence_create_page",
    description:
      "Create a Confluence page (v2). Pass `space_key` (e.g. 'ENG') — auto-resolved to v2 spaceId. " +
      "Pass exactly one of `body_text` (plain text → storage XHTML automatically) or `body_storage` " +
      "(raw XHTML for advanced edits). `parent_id` makes it a child page. " +
      "Disable to make the agent unable to author Confluence pages.",
    schema: z.object({
      space_key: z.string(),
      title: z.string(),
      parent_id: z.string().optional().describe("Page id of the parent; omit for top-level."),
      body_text: z.string().optional().describe("Plain text; auto-converted to storage XHTML."),
      body_storage: z.string().optional().describe("Raw Confluence storage-format XHTML."),
    }),
  },
);

export const confluenceUpdatePageTool = tool(
  async ({ page_id, title, body_text, body_storage, version_number, version_message }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);

    let nextVersion = version_number;
    let resolvedTitle: string | undefined = title;
    if (nextVersion === undefined || resolvedTitle === undefined) {
      // PUT requires both title and version even when not changing them, so
      // fetch the current page when either is omitted. Cheaper than asking
      // every caller to do it.
      const current = await atlassianFetch(
        auth,
        `/wiki/api/v2/pages/${encodeURIComponent(page_id)}`,
      ) as { title?: string; version?: { number?: number }; error?: string };
      if (current.error) return JSON.stringify(current);
      if (nextVersion === undefined) {
        const cur = current.version?.number;
        if (typeof cur !== "number") return JSON.stringify({ error: "could not read current version from Confluence response" });
        nextVersion = cur + 1;
      }
      if (resolvedTitle === undefined) resolvedTitle = current.title;
    }

    const payload: Record<string, unknown> = {
      id: page_id,
      status: "current",
      title: resolvedTitle,
      body: { representation: body.representation, value: body.value },
      version: { number: nextVersion, ...(version_message ? { message: version_message } : {}) },
    };
    const data = await atlassianFetch(auth, `/wiki/api/v2/pages/${encodeURIComponent(page_id)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const links = data._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      ok: true,
      id: data.id,
      title: data.title,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? nextVersion,
      url: webui ? `${auth.url}/wiki${webui}` : null,
    });
  },
  {
    name: "confluence_update_page",
    description:
      "Update an existing Confluence page (v2). Pass exactly one of `body_text` or `body_storage`. " +
      "If `version_number` is omitted, the tool auto-fetches the current version and sends current+1 " +
      "(Confluence requires strict +1 increments; gaps cause 409). If `title` is omitted, the existing " +
      "title is preserved. Avoid back-to-back updates within ~1 second — Confluence may return 409 even " +
      "with the correct version. Disable to make the agent read-only on pages.",
    schema: z.object({
      page_id: z.string(),
      title: z.string().optional().describe("New title; omit to keep existing."),
      body_text: z.string().optional(),
      body_storage: z.string().optional(),
      version_number: z.number().optional().describe(
        "Explicit version (must equal currentVersion+1). Omit to auto-fetch and increment.",
      ),
      version_message: z.string().optional().describe("Optional change comment shown in version history."),
    }),
  },
);

export const confluenceAddCommentTool = tool(
  async ({ page_id, body_text, body_storage, parent_comment_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);
    const payload: Record<string, unknown> = {
      pageId: page_id,
      body: { representation: body.representation, value: body.value },
    };
    if (parent_comment_id) payload.parentCommentId = parent_comment_id;
    const data = await atlassianFetch(auth, `/wiki/api/v2/footer-comments`, {
      method: "POST",
      body: JSON.stringify(payload),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      comment_id: data.id,
      page_id,
      parent_comment_id: data.parentCommentId ?? null,
    });
  },
  {
    name: "confluence_add_comment",
    description:
      "Add a footer comment to a Confluence page (v2). Pass exactly one of `body_text` or " +
      "`body_storage`. Pass `parent_comment_id` (from confluence_get_comments) to reply in a thread.",
    schema: z.object({
      page_id: z.string(),
      body_text: z.string().optional(),
      body_storage: z.string().optional(),
      parent_comment_id: z.string().optional().describe("To reply to an existing comment."),
    }),
  },
);

export const confluenceMovePageTool = tool(
  async ({ page_id, position, target_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}/move/${encodeURIComponent(position)}/${encodeURIComponent(target_id)}`,
      { method: "PUT" },
    ) as { error?: string } | string | Record<string, unknown>;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, page_id, position, target_id });
  },
  {
    name: "confluence_move_page",
    description:
      "Reorder/reparent a Confluence page (v2). `position`: 'before' or 'after' to place as a sibling " +
      "of `target_id`; 'append' to make it a child of `target_id`. Non-destructive.",
    schema: z.object({
      page_id: z.string(),
      position: z.enum(["before", "after", "append"]),
      target_id: z.string().describe("Sibling (for before/after) or new parent (for append)."),
    }),
  },
);

export const confluenceUploadAttachmentTool = tool(
  async ({ page_id, filename, content_base64, content_text, comment, minor_edit }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!content_base64 && !content_text) {
      return JSON.stringify({ error: "pass either content_base64 (binary) or content_text (UTF-8)" });
    }
    const buf = content_base64
      ? Buffer.from(content_base64, "base64")
      : Buffer.from(content_text!, "utf8");

    // v1 fallback: v2 Attachment group is read-only as of 2026 (CONFCLOUD-77196).
    // Same multipart shape as jiraUploadAttachmentTool — X-Atlassian-Token: no-check
    // bypasses CSRF; do NOT set Content-Type (fetch fills in the multipart boundary).
    const form = new FormData();
    form.append("file", new Blob([buf]), filename);
    if (typeof comment === "string") form.append("comment", comment);
    if (minor_edit) form.append("minorEdit", "true");

    const url = `${auth.url}/wiki/rest/api/content/${encodeURIComponent(page_id)}/child/attachment`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader(auth),
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
      },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) return JSON.stringify({ error: `Atlassian ${res.status}: ${text.slice(0, 500)}` });
    const parsed = parseJsonSafe<{
      results?: Array<{ id: string; title: string; metadata?: { mediaType?: string }; extensions?: { fileSize?: number } }>;
    }>(text, {});
    return JSON.stringify({
      ok: true,
      page_id,
      attachments: (parsed.results ?? []).map((a) => ({
        id: a.id,
        title: a.title,
        media_type: a.metadata?.mediaType ?? null,
        file_size: a.extensions?.fileSize ?? null,
      })),
    });
  },
  {
    name: "confluence_upload_attachment",
    description:
      "Attach a file to a Confluence page. Pass content_base64 for binary or content_text for plain " +
      "UTF-8. Uses the v1 multipart endpoint (v2 has no attachment-create endpoint as of 2026). " +
      "Disable to make the agent unable to add attachments.",
    schema: z.object({
      page_id: z.string(),
      filename: z.string().describe("Filename shown in Confluence (include the extension)."),
      content_base64: z.string().optional().describe("Base64-encoded file contents (use for binary)."),
      content_text: z.string().optional().describe("Raw UTF-8 text contents (use for logs/CSVs/JSON)."),
      comment: z.string().optional().describe("Version comment shown in the attachment history."),
      minor_edit: z.boolean().optional().describe("If true, doesn't notify watchers."),
    }),
  },
);

export const confluenceAddLabelTool = tool(
  async ({ page_id, labels }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!labels.length) return JSON.stringify({ error: "labels is empty" });
    // v1 fallback: v2 Label group is read-only as of 2026 (CONFCLOUD-76866).
    const payload = labels.map((name) => ({ prefix: "global", name }));
    const data = await atlassianFetch(
      auth,
      `/wiki/rest/api/content/${encodeURIComponent(page_id)}/label`,
      { method: "POST", body: JSON.stringify(payload) },
    ) as { results?: Array<{ name?: string; prefix?: string }>; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      page_id,
      added: labels,
      total_labels: (data.results ?? []).map((r) => r.name).filter(Boolean),
    });
  },
  {
    name: "confluence_add_label",
    description:
      "Add one or more labels to a Confluence page (additive — does not replace existing labels). " +
      "Uses the v1 endpoint (v2 only reads labels as of 2026).",
    schema: z.object({
      page_id: z.string(),
      labels: z.array(z.string()).describe("Label names to add (e.g. ['runbook', 'on-call'])."),
    }),
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

// Convert plain text → Confluence storage-format XHTML. Splits on blank lines
// for paragraphs and uses <br/> for single newlines. Escapes &, <, > because
// Confluence storage rejects unescaped ampersands and stray angle brackets.
// Pure — exported for unit testing.
export function confluenceTextToStorage(text: string): string {
  if (text.length === 0) return "<p></p>";
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split("\n").map(escape).join("<br/>")}</p>`)
    .join("");
}

// Extract the opaque cursor query param from a Confluence v2 `_links.next` URL.
// v2 cursors are not safe to construct — Atlassian explicitly says "always parse
// the next link, never build it". Pure — exported for unit testing.
export function parseV2NextCursor(linksNext: string | undefined): string | null {
  if (!linksNext) return null;
  const m = linksNext.match(/[?&]cursor=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Body input dispatcher used by create_page / update_page / add_comment.
// Callers pass body_text XOR body_storage; this resolves to the wire format
// or a structured error for the LLM. body_storage is rejected if it contains
// <script>/<style> — Confluence storage rejects those with opaque 400s, so
// catch it here with a useful message.
function resolveBody(input: { body_text?: string; body_storage?: string }):
  | { value: string; representation: "storage" }
  | { error: string }
{
  const hasText = typeof input.body_text === "string";
  const hasStorage = typeof input.body_storage === "string";
  if (hasText && hasStorage) {
    return { error: "pass exactly one of body_text or body_storage, not both" };
  }
  if (!hasText && !hasStorage) {
    return { error: "pass exactly one of body_text or body_storage" };
  }
  if (hasStorage) {
    const s = input.body_storage!;
    if (/<\s*(script|style)[\s>]/i.test(s)) {
      return { error: "body_storage rejected: <script>/<style> tags are not allowed by Confluence storage format" };
    }
    return { value: s, representation: "storage" };
  }
  return { value: confluenceTextToStorage(input.body_text!), representation: "storage" };
}

// Per-site cache of space key → numeric space id. v2 page endpoints take
// spaceId, but humans (and the LLM) think in space keys. 1h TTL mirrors
// loadJiraFields below.
const SPACE_ID_CACHE_TTL_MS = 60 * 60 * 1000;
const spaceIdCache = new Map<string, { id: string; loaded: number }>();

async function resolveSpaceId(
  auth: AtlassianAuth,
  spaceKey: string,
): Promise<string | { error: string }> {
  const cacheKey = `${auth.url}|${spaceKey}`;
  const cached = spaceIdCache.get(cacheKey);
  if (cached && Date.now() - cached.loaded < SPACE_ID_CACHE_TTL_MS) return cached.id;
  const data = await atlassianFetch(
    auth,
    `/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`,
  ) as { results?: Array<{ id: string; key: string }>; error?: string };
  if ("error" in data && data.error) return { error: data.error };
  const hit = (data.results ?? []).find((s) => s.key === spaceKey) ?? data.results?.[0];
  if (!hit?.id) return { error: `space key "${spaceKey}" not found` };
  spaceIdCache.set(cacheKey, { id: hit.id, loaded: Date.now() });
  return hit.id;
}

// Per-site cache of /rest/api/3/field. Custom field IDs are stable per site,
// but display names can be edited; 1h TTL keeps us fresh without thrashing.
export interface JiraFieldDef { id: string; name: string; custom: boolean }
const FIELD_CACHE_TTL_MS = 60 * 60 * 1000;
const fieldCache = new Map<string, { fields: JiraFieldDef[]; loaded: number }>();

async function loadJiraFields(auth: AtlassianAuth): Promise<JiraFieldDef[] | { error: string }> {
  const cached = fieldCache.get(auth.url);
  if (cached && Date.now() - cached.loaded < FIELD_CACHE_TTL_MS) return cached.fields;
  const data = await atlassianFetch(auth, `/rest/api/3/field`) as
    | Array<{ id: string; name: string; custom: boolean }>
    | { error?: string };
  if (!Array.isArray(data)) return data as { error: string };
  const fields = data.map((f) => ({ id: f.id, name: f.name, custom: f.custom }));
  fieldCache.set(auth.url, { fields, loaded: Date.now() });
  return fields;
}

// Pure helper — exported for unit testing. Given a list of caller inputs and
// the site's field definitions, partition into resolved (matched by id or
// case-insensitive display name) and unresolved.
export function resolveCustomFieldNames(
  inputs: string[],
  fields: JiraFieldDef[],
): { resolved: Array<{ input: string; id: string; name: string }>; unresolved: string[] } {
  const byId = new Map<string, JiraFieldDef>();
  const byName = new Map<string, JiraFieldDef>();
  for (const f of fields) {
    byId.set(f.id, f);
    byName.set(f.name.toLowerCase(), f);
  }
  const resolved: Array<{ input: string; id: string; name: string }> = [];
  const unresolved: string[] = [];
  for (const input of inputs) {
    const trimmed = input.trim();
    const hit = byId.get(trimmed) ?? byName.get(trimmed.toLowerCase());
    if (hit) resolved.push({ input, id: hit.id, name: hit.name });
    else unresolved.push(input);
  }
  return { resolved, unresolved };
}

// Coerce a Jira field value (which can be string, number, ADF doc, option
// object, user object, array of those) into something an LLM can read. When
// Jira returns a renderedFields HTML version, prefer that — it's the author's
// formatting, flattened.
export function extractFieldValue(raw: unknown, renderedHTML: unknown): unknown {
  if (typeof renderedHTML === "string" && renderedHTML.length > 0) {
    return stripHtml(renderedHTML);
  }
  if (raw == null) return null;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.map(coerceItem);
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.type === "doc" && Array.isArray(obj.content)) return simplifyADF(obj);
    if (typeof obj.value === "string") return obj.value;
    if (typeof obj.displayName === "string") return obj.displayName;
    if (typeof obj.name === "string") return obj.name;
    return obj;
  }
  return raw;
}

function coerceItem(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const obj = item as Record<string, unknown>;
  if (typeof obj.value === "string") return obj.value;
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.displayName === "string") return obj.displayName;
  return obj;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Atlassian's REST API takes ADF (Atlassian Document Format), not plain text.
// This wraps a plain string so the agent doesn't have to know the schema.
function textToADF(text: string): unknown {
  type ADFNode = { type: string; text?: string };
  return {
    type: "doc",
    version: 1,
    content: text.split(/\n\n+/).map((para) => ({
      type: "paragraph",
      content: para.split("\n").flatMap<ADFNode>((line, i) =>
        i === 0
          ? [{ type: "text", text: line }]
          : [{ type: "hardBreak" }, { type: "text", text: line }],
      ),
    })),
  };
}

// Best-effort flatten of an ADF document back to plain text. Doesn't preserve
// formatting but gives the agent something readable to summarize.
function simplifyADF(adf: unknown): string {
  if (!adf || typeof adf !== "object") return typeof adf === "string" ? adf : "";
  const out: string[] = [];
  walk(adf);
  return out.join("").trim();

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "text" && typeof n.text === "string") out.push(n.text);
    if (n.type === "hardBreak") out.push("\n");
    if (n.type === "paragraph") { walkChildren(n.content); out.push("\n\n"); }
    else if (n.type === "bulletList" || n.type === "orderedList") walkChildren(n.content);
    else if (n.type === "listItem") { out.push("• "); walkChildren(n.content); }
    else walkChildren(n.content);
  }
  function walkChildren(children: unknown): void {
    if (Array.isArray(children)) for (const c of children) walk(c);
  }
}

registerTools("Atlassian", [
  jiraSearchTool, jiraGetIssueTool, jiraFindUserTool,
  jiraCreateIssueTool, jiraCreateIssuesBulkTool, jiraUpdateIssueTool,
  jiraAddCommentTool, jiraTransitionsTool,
  jiraLinkIssuesTool, jiraAddRemoteLinkTool, jiraDeleteLinkTool,
  jiraUploadAttachmentTool, jiraDeleteIssueTool,
  confluenceSearchTool, confluenceGetPageTool,
  confluenceGetPageByTitleTool, confluenceGetPageChildrenTool,
  confluenceGetPageAncestorsTool, confluenceListSpacesTool,
  confluenceGetCommentsTool, confluenceListAttachmentsTool,
  confluenceGetLabelsTool, confluenceGetAttachmentContentTool,
  confluenceCreatePageTool, confluenceUpdatePageTool,
  confluenceAddCommentTool, confluenceMovePageTool,
  confluenceUploadAttachmentTool, confluenceAddLabelTool,
]);
