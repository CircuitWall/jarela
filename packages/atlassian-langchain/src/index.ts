/**
 * Native Atlassian tools (Jira + Confluence) — direct REST API calls, no MCP.
 *
 * Why this exists: corporate networks often block public PyPI/npm, which makes
 * the `mcp-atlassian` install path fragile. These tools just hit the Atlassian
 * REST API over HTTPS via the standard `fetch` — works anywhere a browser can
 * reach `*.atlassian.net`, and inherits any HTTP_PROXY agent the runtime sets.
 *
 * Auth resolution defaults to env vars (ATLASSIAN_URL / ATLASSIAN_EMAIL /
 * ATLASSIAN_API_TOKEN). Call `setAuthResolver()` to plug in a custom
 * credential source (vault, secrets manager, UI form, etc.) — the resolver
 * is invoked lazily on every tool call, so it's safe to import the tools
 * before configuring auth.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// JSON.parse with a typed fallback for transient HTML responses from proxies.
function parseJsonSafe<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export interface AtlassianAuth {
  url: string;        // e.g. "https://your-team.atlassian.net"
  email: string;
  apiToken: string;
}

export type AuthResolver = () => AtlassianAuth | { error: string };

let _resolver: AuthResolver = resolveAtlassianAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void {
  _resolver = fn;
}

export function resolveAtlassianAuthFromEnv(): AtlassianAuth | { error: string } {
  const envUrl = process.env.ATLASSIAN_URL;
  const envEmail = process.env.ATLASSIAN_EMAIL;
  const envToken = process.env.ATLASSIAN_API_TOKEN;
  if (envUrl && envEmail && envToken) {
    return { url: stripTrailingSlash(envUrl), email: envEmail, apiToken: envToken };
  }
  return {
    error:
      "Atlassian not configured. Set ATLASSIAN_URL / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN env vars, " +
      "or call setAuthResolver() with your own credential provider.",
  };
}

function resolveAuth(): AtlassianAuth | { error: string } {
  return _resolver();
}

function stripTrailingSlash(s: string): string { return s.replace(/\/+$/, ""); }

function authHeader(a: AtlassianAuth): string {
  return "Basic " + Buffer.from(`${a.email}:${a.apiToken}`).toString("base64");
}

// Low-level escape hatch — callers that need to hit a Jira/Confluence endpoint
// not yet wrapped as a tool can call this directly. Returns the parsed JSON,
// or `{ error, url }` on non-2xx.
export async function atlassianFetch(
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

type ResolvedCustomField = { input: string; id: string; name: string };

// Resolves caller-supplied custom-field display names / ids into Jira field
// ids, builds the `expand` + `fields` query string for /rest/api/3/issue/...,
// and returns the prepared resolved set. Returns an error JSON string for the
// tool to forward verbatim if any input is unresolvable.
async function prepareJiraGetIssueQuery(
  auth: AtlassianAuth,
  customFields: string[] | undefined,
  expand: string[] | undefined,
): Promise<{ resolved: ResolvedCustomField[]; qs: string } | { error: string }> {
  let resolvedCustom: ResolvedCustomField[] = [];
  if (customFields?.length) {
    const fieldList = await loadJiraFields(auth);
    if (!Array.isArray(fieldList)) return { error: JSON.stringify(fieldList) };
    const r = resolveCustomFieldNames(customFields, fieldList);
    if (r.unresolved.length) {
      const candidates = fieldList
        .filter((f) => f.custom).slice(0, 25)
        .map((f) => `${f.name} (${f.id})`).join("; ");
      return {
        error: JSON.stringify({
          error: `unresolved custom_fields: ${r.unresolved.join(", ")}. Pass either the customfield_NNNNN id or the exact display name.`,
          hint_first_25_custom_fields: candidates,
        }),
      };
    }
    resolvedCustom = r.resolved;
  }
  const expandSet = new Set(expand ?? []);
  if (resolvedCustom.length) {
    expandSet.add("names");
    expandSet.add("renderedFields");
  }
  // Always pull issuelinks/subtasks/attachment/parent so callers see what's
  // attached to the issue without a follow-up call. Custom fields are
  // additive — when present we enumerate base + customs to keep the
  // response shape stable.
  const baseFields = [
    "summary", "description", "status", "issuetype", "priority",
    "assignee", "reporter", "created", "updated", "labels", "components", "comment",
    "issuelinks", "subtasks", "attachment", "parent",
  ];
  const fieldsParam = resolvedCustom.length
    ? `fields=${[...baseFields, ...resolvedCustom.map((c) => c.id)].join(",")}`
    : `fields=${baseFields.join(",")}`;
  const params: string[] = [];
  if (expandSet.size) params.push(`expand=${[...expandSet].join(",")}`);
  params.push(fieldsParam);
  return { resolved: resolvedCustom, qs: `?${params.join("&")}` };
}

// Issue links: each entry has an `id` (needed by jira_delete_link), a type,
// and one of inwardIssue / outwardIssue depending on direction.
function mapIssueLinks(raw: unknown): Array<Record<string, unknown>> {
  return ((raw as Array<Record<string, unknown>>) ?? []).map((l) => {
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
}

function mapIssueSubtasks(raw: unknown): Array<Record<string, unknown>> {
  return ((raw as Array<Record<string, unknown>>) ?? []).map((s) => ({
    key: s.key,
    summary: (s.fields as Record<string, unknown>)?.summary,
    status: ((s.fields as Record<string, unknown>)?.status as Record<string, unknown>)?.name,
  }));
}

function mapIssueAttachments(raw: unknown): Array<Record<string, unknown>> {
  return ((raw as Array<Record<string, unknown>>) ?? []).map((a) => ({
    id: a.id,
    filename: a.filename,
    size: a.size,
    mime_type: a.mimeType,
    created: a.created,
    author: (a.author as Record<string, unknown>)?.displayName,
    content_url: a.content,
  }));
}

function mapEmbeddedComments(rawComment: unknown): Array<Record<string, unknown>> {
  const comments = ((rawComment as Record<string, unknown>)?.comments as Array<Record<string, unknown>>) ?? [];
  return comments.map((c) => ({
    id: c.id,
    author: (c.author as Record<string, unknown>)?.displayName ?? null,
    created: c.created,
    updated: c.updated,
    body: simplifyADF(c.body),
  }));
}

// Remote/web links live under a separate endpoint — only fetched when the
// caller passes expand=remoteLinks so we don't waste a call on every get.
async function fetchIssueRemoteLinks(
  auth: AtlassianAuth,
  issueKey: string,
): Promise<Array<Record<string, unknown>> | undefined> {
  const rl = await atlassianFetch(
    auth,
    `/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`,
  ) as Array<Record<string, unknown>> | { error?: string };
  if (!Array.isArray(rl)) return undefined;
  return rl.map((entry) => {
    const obj = entry.object as Record<string, unknown> | undefined;
    return { id: entry.id, url: obj?.url, title: obj?.title, summary: obj?.summary };
  });
}

function formatJiraGetIssueResponse(
  data: Record<string, unknown>,
  auth: AtlassianAuth,
  opts: {
    includeComments: boolean | undefined;
    resolvedCustom: ResolvedCustomField[];
    remoteLinks: Array<Record<string, unknown>> | undefined;
  },
): Record<string, unknown> {
  const f = (data.fields ?? {}) as Record<string, unknown>;
  const rendered = (data.renderedFields ?? {}) as Record<string, unknown>;
  const customOut: Record<string, unknown> = {};
  for (const c of opts.resolvedCustom) {
    customOut[c.name] = extractFieldValue(f[c.id], rendered[c.id]);
  }
  const parentRaw = f.parent as Record<string, unknown> | undefined;
  return {
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
    ...(opts.includeComments ? { comments: mapEmbeddedComments(f.comment) } : {}),
    parent: parentRaw ? {
      key: parentRaw.key,
      summary: (parentRaw.fields as Record<string, unknown>)?.summary,
    } : null,
    subtasks: mapIssueSubtasks(f.subtasks),
    issue_links: mapIssueLinks(f.issuelinks),
    attachments: mapIssueAttachments(f.attachment),
    ...(opts.remoteLinks !== undefined ? { remote_links: opts.remoteLinks } : {}),
    ...(opts.resolvedCustom.length ? { custom_fields: customOut } : {}),
  };
}

export const jiraGetIssueTool = tool(
  async ({ issue_key, expand, custom_fields, include_comments }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const prepared = await prepareJiraGetIssueQuery(auth, custom_fields, expand);
    if ("error" in prepared) return prepared.error;

    const data = await atlassianFetch(
      auth,
      `/rest/api/3/issue/${encodeURIComponent(issue_key)}${prepared.qs}`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);

    const remoteLinks = (expand ?? []).includes("remoteLinks")
      ? await fetchIssueRemoteLinks(auth, issue_key)
      : undefined;

    return JSON.stringify(
      formatJiraGetIssueResponse(data, auth, {
        includeComments: include_comments,
        resolvedCustom: prepared.resolved,
        remoteLinks,
      }),
    );
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

// Resolves caller-supplied custom-field display names / ids into id→value
// pairs ready to merge into the PUT body. Empty/missing input is treated as
// "nothing to update" and returns {}.  An error result short-circuits the tool.
async function resolveJiraUpdateCustomFields(
  auth: AtlassianAuth,
  customFields: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | { error: string }> {
  if (!customFields || typeof customFields !== "object" || Object.keys(customFields).length === 0) {
    return {};
  }
  const inputs = Object.keys(customFields);
  const fieldList = await loadJiraFields(auth);
  if (!Array.isArray(fieldList)) return { error: JSON.stringify(fieldList) };
  const r = resolveCustomFieldNames(inputs, fieldList);
  if (r.unresolved.length) {
    return {
      error: JSON.stringify({
        error: `unresolved custom_fields: ${r.unresolved.join(", ")}. Pass either the customfield_NNNNN id or the exact display name.`,
        hint_first_25_custom_fields: fieldList
          .filter((f) => f.custom).slice(0, 25)
          .map((f) => `${f.name} (${f.id})`).join("; "),
      }),
    };
  }
  const out: Record<string, unknown> = {};
  for (const c of r.resolved) out[c.id] = (customFields as Record<string, unknown>)[c.input];
  return out;
}

function buildLabelOps(
  add: string[] | undefined,
  remove: string[] | undefined,
): Array<Record<string, string>> {
  const ops: Array<Record<string, string>> = [];
  for (const l of add ?? []) ops.push({ add: l });
  for (const l of remove ?? []) ops.push({ remove: l });
  return ops;
}

// Translates the two assignee inputs into the field value the PUT body
// expects. Returns undefined if neither input was supplied (leave field
// untouched), or an error string for an unresolvable email.
async function resolveAssigneeUpdate(
  auth: AtlassianAuth,
  accountId: string | null | undefined,
  email: string | undefined,
): Promise<{ accountId: string | null } | { error: string } | undefined> {
  if (accountId !== undefined) {
    if (accountId === null || accountId === "" || accountId === "unassigned") {
      return { accountId: null };
    }
    return { accountId };
  }
  if (typeof email !== "string" || email.length === 0) return undefined;
  if (email === "unassigned") return { accountId: null };
  const users = await atlassianFetch(
    auth,
    `/rest/api/3/user/search?query=${encodeURIComponent(email)}`,
  ) as Array<{ accountId?: string; emailAddress?: string }> | { error?: string };
  if (!Array.isArray(users)) return { error: JSON.stringify(users) };
  // Prefer exact email match (case-insensitive); fall back to single result.
  const exact = users.find(
    (u) => (u.emailAddress ?? "").toLowerCase() === email.toLowerCase(),
  );
  const picked = exact ?? (users.length === 1 ? users[0] : undefined);
  if (!picked?.accountId) {
    return {
      error: JSON.stringify({
        error: `could not resolve assignee_email "${email}" — got ${users.length} matches; ` +
          `pass assignee_account_id explicitly`,
        candidates: users.map((u) => ({ email: u.emailAddress, account_id: u.accountId })),
      }),
    };
  }
  return { accountId: picked.accountId };
}

// Translates the flat tool input into the `fields` map for the PUT body.
// Custom fields and assignee resolution are async / can fail with an error
// string, so they're handled in the caller and merged in afterwards.
function buildJiraUpdateFields(input: {
  summary?: string;
  description?: string;
  priority?: string;
  parent_key?: string;
  fix_versions?: string[];
  labels?: string[];
}): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof input.summary === "string") fields.summary = input.summary;
  if (typeof input.description === "string") fields.description = textToADF(input.description);
  if (typeof input.priority === "string") fields.priority = { name: input.priority };
  if (typeof input.parent_key === "string") {
    // Empty string clears the parent (detach from epic / promote sub-task to standalone).
    fields.parent = input.parent_key.length > 0 ? { key: input.parent_key } : null;
  }
  if (Array.isArray(input.fix_versions)) {
    fields.fixVersions = input.fix_versions.map((name) => ({ name }));
  }
  if (Array.isArray(input.labels)) fields.labels = input.labels;
  return fields;
}

export const jiraUpdateIssueTool = tool(
  async ({
    issue_key, summary, description, priority, assignee_account_id, assignee_email,
    fix_versions, labels, labels_add, labels_remove, custom_fields, parent_key,
  }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    const fields = buildJiraUpdateFields({
      summary, description, priority, parent_key, fix_versions, labels,
    });

    // Custom fields: caller passes display names ("Due Date") or ids
    // (customfield_10015) → values. Values are passed through verbatim —
    // Jira accepts strings, numbers, arrays, or full ADF docs depending on
    // the field's underlying type, and forcing one shape here would break
    // the others. The model already knows the field type from a prior
    // get_issue call (or an error message will steer it).
    const customResolved = await resolveJiraUpdateCustomFields(auth, custom_fields);
    if ("error" in customResolved) return customResolved.error;
    Object.assign(fields, customResolved);

    const assignee = await resolveAssigneeUpdate(auth, assignee_account_id, assignee_email);
    if (assignee && "error" in assignee) return assignee.error;
    if (assignee) fields.assignee = assignee;

    const update: Record<string, Array<Record<string, unknown>>> = {};
    const labelOps = buildLabelOps(labels_add, labels_remove);
    if (labelOps.length) update.labels = labelOps;

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

type IssueLinkType = { id: string; name: string; inward: string; outward: string };

// Loads the site's configured link types and returns either the requested
// match, an error JSON for the tool to forward, or the list itself when the
// caller probed without enough args.
async function resolveJiraLinkType(
  auth: AtlassianAuth,
  linkType: string | undefined,
  fromIssue: string | undefined,
  toIssue: string | undefined,
): Promise<{ match: IssueLinkType } | { listing: string }> {
  const list = await atlassianFetch(auth, `/rest/api/3/issueLinkType`) as
    | { issueLinkTypes?: IssueLinkType[]; error?: string };
  if ("error" in list && list.error) return { listing: JSON.stringify(list) };
  const types = list.issueLinkTypes ?? [];
  if (!linkType || !fromIssue || !toIssue) {
    return {
      listing: JSON.stringify({
        available_link_types: types.map((t) => ({ name: t.name, outward: t.outward, inward: t.inward })),
        usage: "Pass from_issue, to_issue, and link_type (e.g. 'Blocks'). The link reads as: '<from_issue> <outward verb> <to_issue>'.",
      }),
    };
  }
  const wanted = linkType.toLowerCase();
  const match = types.find((t) => t.name.toLowerCase() === wanted);
  if (!match) {
    return {
      listing: JSON.stringify({
        error: `link_type "${linkType}" not configured for this site`,
        available: types.map((t) => t.name),
      }),
    };
  }
  return { match };
}

export const jiraLinkIssuesTool = tool(
  async ({ from_issue, to_issue, link_type, comment }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    // Same "omit to list" pattern as jira_transition_issue — agents can probe
    // this tool to discover available link types without a separate endpoint.
    const resolved = await resolveJiraLinkType(auth, link_type, from_issue, to_issue);
    if ("listing" in resolved) return resolved.listing;
    const { match } = resolved;

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

type BulkIssueInput = {
  project_key: string;
  summary: string;
  description?: string;
  issue_type?: string;
  parent_key?: string;
  labels?: string[];
  assignee_account_id?: string;
  custom_fields?: Record<string, unknown>;
};

// Builds the `fields` map for one issue inside a bulk-create request.
// Returns either the prepared map or an error JSON string for the tool to
// short-circuit on (unresolvable custom field name/id).
function buildBulkCreateFields(
  i: BulkIssueInput,
  fieldList: JiraFieldDef[] | undefined,
): { fields: Record<string, unknown> } | { error: string } {
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
      return { error: JSON.stringify({ error: `unresolved custom_fields on "${i.summary}": ${r.unresolved.join(", ")}` }) };
    }
    for (const c of r.resolved) {
      fields[c.id] = (i.custom_fields as Record<string, unknown>)[c.input];
    }
  }
  return { fields };
}

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
      const built = buildBulkCreateFields(i as BulkIssueInput, fieldList);
      if ("error" in built) return built.error;
      issueUpdates.push({ fields: built.fields });
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

// ── Jira agile tools ────────────────────────────────────────────────────────
//
// Sprint/board/backlog/rank lives at `/rest/agile/1.0/...`, NOT `/rest/api/3/`.
// Same hostname + same Basic auth as the platform API, so atlassianFetch works
// unchanged — only the path family differs. See ADR-0035.
//
// Sprint state machine: future → active → closed (one-way). Atlassian rejects
// other transitions server-side, but we validate client-side too so the agent
// gets a clean error with the list of legal next states instead of a 400.

const SPRINT_STATES = ["future", "active", "closed"] as const;
type SprintState = (typeof SPRINT_STATES)[number];

// Pure — exported for tests. Returns the state argument shape Atlassian's
// `POST /sprint/{id}` accepts, or an error if the transition is illegal.
export function validateSprintTransition(
  current: string | undefined,
  target: SprintState,
): { ok: true } | { error: string } {
  if (target === "future") {
    return { error: "cannot transition a sprint back to 'future' once created" };
  }
  if (current === "closed") {
    return { error: "sprint is already closed; no further transitions allowed" };
  }
  if (target === "active" && current && current !== "future") {
    return { error: `cannot start a sprint in state '${current}' — only 'future' sprints can be started` };
  }
  if (target === "closed" && current && current !== "active") {
    return { error: `cannot complete a sprint in state '${current}' — only 'active' sprints can be completed` };
  }
  return { ok: true };
}

export const jiraListBoardsTool = tool(
  async ({ project, name, type, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (project) params.set("projectKeyOrId", project);
    if (name) params.set("name", name);
    if (type) params.set("type", type);
    params.set("maxResults", String(Math.min(max_results ?? 50, 100)));
    const data = await atlassianFetch(auth, `/rest/agile/1.0/board?${params}`) as
      | { values?: Array<Record<string, unknown>>; isLast?: boolean; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      boards: (data.values ?? []).map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        project_key: ((b.location as Record<string, unknown>)?.projectKey) ?? null,
      })),
      is_last: data.isLast ?? null,
    });
  },
  {
    name: "jira_list_boards",
    description:
      "List Jira agile boards (Scrum or Kanban). Filter by project key, name fragment, or board type. " +
      "Returns id, name, type, project_key. Use the id with jira_list_sprints / jira_get_backlog / etc.",
    schema: z.object({
      project: z.string().optional().describe("Project key or id to filter by"),
      name: z.string().optional().describe("Board name fragment (case-insensitive contains-match)"),
      type: z.enum(["scrum", "kanban", "simple"]).optional(),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);

export const jiraGetBoardTool = tool(
  async ({ board_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Two calls in parallel — board metadata + configuration. The configuration
    // endpoint is what reveals estimation field, sub-query, ranking field, etc.,
    // which the agent often needs alongside the basic board info.
    const [meta, config] = await Promise.all([
      atlassianFetch(auth, `/rest/agile/1.0/board/${encodeURIComponent(board_id)}`),
      atlassianFetch(auth, `/rest/agile/1.0/board/${encodeURIComponent(board_id)}/configuration`),
    ]) as [Record<string, unknown> & { error?: string }, Record<string, unknown> & { error?: string }];
    if (meta.error) return JSON.stringify(meta);
    return JSON.stringify({
      id: meta.id,
      name: meta.name,
      type: meta.type,
      project_key: ((meta.location as Record<string, unknown>)?.projectKey) ?? null,
      configuration: config.error ? null : {
        filter_id: ((config.filter as Record<string, unknown>)?.id) ?? null,
        sub_query: ((config.subQuery as Record<string, unknown>)?.query) ?? null,
        estimation_field: ((config.estimation as Record<string, unknown>)?.field as Record<string, unknown>)?.fieldId ?? null,
        ranking_field: ((config.ranking as Record<string, unknown>)?.rankCustomFieldId) ?? null,
      },
    });
  },
  {
    name: "jira_get_board",
    description:
      "Fetch board metadata and configuration in one call: id, name, type, project_key, plus filter id, " +
      "sub-query JQL, estimation field, and ranking custom field. Use this when you need to know how " +
      "issues are estimated or ranked on a specific board.",
    schema: z.object({
      board_id: z.union([z.string(), z.number()]).describe("Board id from jira_list_boards"),
    }),
  },
);

export const jiraListSprintsTool = tool(
  async ({ board_id, state, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (state) params.set("state", state);
    params.set("maxResults", String(Math.min(max_results ?? 50, 100)));
    const data = await atlassianFetch(
      auth,
      `/rest/agile/1.0/board/${encodeURIComponent(board_id)}/sprint?${params}`,
    ) as { values?: Array<Record<string, unknown>>; isLast?: boolean; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      sprints: (data.values ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        goal: s.goal ?? null,
        start_date: s.startDate ?? null,
        end_date: s.endDate ?? null,
        complete_date: s.completeDate ?? null,
        origin_board_id: s.originBoardId ?? null,
      })),
      is_last: data.isLast ?? null,
    });
  },
  {
    name: "jira_list_sprints",
    description:
      "List sprints on a board. Filter by state ('active', 'closed', 'future'). Returns sprint id, name, " +
      "state, goal, dates, origin_board_id. To list issues IN a sprint, use jira_search with " +
      "JQL `sprint = {id}` — that's faster and supports custom field selection.",
    schema: z.object({
      board_id: z.union([z.string(), z.number()]),
      state: z.enum(["active", "closed", "future"]).optional().describe("Comma in API but tool takes one state"),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);

export const jiraGetSprintTool = tool(
  async ({ sprint_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(auth, `/rest/agile/1.0/sprint/${encodeURIComponent(sprint_id)}`) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      id: data.id,
      name: data.name,
      state: data.state,
      goal: data.goal ?? null,
      start_date: data.startDate ?? null,
      end_date: data.endDate ?? null,
      complete_date: data.completeDate ?? null,
      origin_board_id: data.originBoardId ?? null,
    });
  },
  {
    name: "jira_get_sprint",
    description:
      "Fetch a single sprint by id. Returns name, state, goal, start/end/complete dates. Use jira_search " +
      "with `sprint = {id}` to list its issues.",
    schema: z.object({ sprint_id: z.union([z.string(), z.number()]) }),
  },
);

export const jiraCreateSprintTool = tool(
  async ({ board_id, name, goal, start_date, end_date }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = { originBoardId: Number(board_id), name };
    if (goal) body.goal = goal;
    if (start_date) body.startDate = start_date;
    if (end_date) body.endDate = end_date;
    const data = await atlassianFetch(auth, `/rest/agile/1.0/sprint`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as { id?: number; self?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, sprint_id: data.id, board_id });
  },
  {
    name: "jira_create_sprint",
    description:
      "Create a future sprint on a board. New sprints always start in 'future' state — use " +
      "jira_update_sprint with state='active' to start it. start_date/end_date are ISO 8601 strings; " +
      "they're optional but required by Atlassian before you can start the sprint.",
    schema: z.object({
      board_id: z.union([z.string(), z.number()]).describe("Origin board id"),
      name: z.string().describe("Sprint name"),
      goal: z.string().optional(),
      start_date: z.string().optional().describe("ISO 8601 timestamp"),
      end_date: z.string().optional().describe("ISO 8601 timestamp"),
    }),
  },
);

export const jiraUpdateSprintTool = tool(
  async ({ sprint_id, name, goal, start_date, end_date, state }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });

    if (state) {
      // Validate transition client-side. Fetch current state for a clean error.
      const current = await atlassianFetch(
        auth,
        `/rest/agile/1.0/sprint/${encodeURIComponent(sprint_id)}`,
      ) as { state?: string; error?: string };
      if (current.error) return JSON.stringify(current);
      const check = validateSprintTransition(current.state, state);
      if ("error" in check) {
        return JSON.stringify({
          error: check.error,
          current_state: current.state,
          legal_next_states: SPRINT_STATES.filter(
            (s) => !("error" in validateSprintTransition(current.state, s)),
          ),
        });
      }
    }

    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (goal !== undefined) body.goal = goal;
    if (start_date !== undefined) body.startDate = start_date;
    if (end_date !== undefined) body.endDate = end_date;
    if (state !== undefined) body.state = state;
    if (Object.keys(body).length === 0) {
      return JSON.stringify({ error: "no fields to update — pass at least one of name, goal, start_date, end_date, state" });
    }

    const data = await atlassianFetch(auth, `/rest/agile/1.0/sprint/${encodeURIComponent(sprint_id)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      sprint_id,
      state: data.state,
      updated_fields: Object.keys(body),
    });
  },
  {
    name: "jira_update_sprint",
    description:
      "Update a sprint's name, goal, dates, or state. State transitions: future→active (start) or " +
      "active→closed (complete). Other transitions are rejected client-side with the list of legal " +
      "next states. Pass only the fields you want to change. **Disable to make the agent unable to " +
      "start/complete sprints.**",
    schema: z.object({
      sprint_id: z.union([z.string(), z.number()]),
      name: z.string().optional(),
      goal: z.string().optional(),
      start_date: z.string().optional().describe("ISO 8601 timestamp"),
      end_date: z.string().optional().describe("ISO 8601 timestamp"),
      state: z.enum(["active", "closed"]).optional().describe(
        "Target state. 'active' starts a future sprint; 'closed' completes an active sprint.",
      ),
    }),
  },
);

export const jiraDeleteSprintTool = tool(
  async ({ sprint_id, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (String(confirm) !== String(sprint_id)) {
      return JSON.stringify({
        error:
          `Refusing to delete sprint ${sprint_id}: pass \`confirm\` set to the same id to proceed. ` +
          `Sprint deletion is irreversible — the issues are unassigned but historical sprint data is lost.`,
      });
    }
    const data = await atlassianFetch(auth, `/rest/agile/1.0/sprint/${encodeURIComponent(sprint_id)}`, {
      method: "DELETE",
    }) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_sprint_id: sprint_id });
  },
  {
    name: "jira_delete_sprint",
    description:
      "Permanently delete a sprint. **Irreversible** — issues are unassigned from the sprint but the " +
      "sprint's velocity/burndown data is lost. The agent must pass `confirm` set to the same `sprint_id` " +
      "to proceed (two-arg gate). **Leave this tool disabled unless the user explicitly wants delete capability.**",
    schema: z.object({
      sprint_id: z.union([z.string(), z.number()]),
      confirm: z.union([z.string(), z.number()]).describe("Must equal `sprint_id` for the delete to proceed"),
    }),
  },
);

export const jiraMoveIssuesToSprintTool = tool(
  async ({ sprint_id, issue_keys }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!issue_keys.length) return JSON.stringify({ error: "issue_keys is empty" });
    if (issue_keys.length > 50) {
      return JSON.stringify({ error: `agile API accepts up to 50 issues per call (got ${issue_keys.length})` });
    }
    const data = await atlassianFetch(
      auth,
      `/rest/agile/1.0/sprint/${encodeURIComponent(sprint_id)}/issue`,
      { method: "POST", body: JSON.stringify({ issues: issue_keys }) },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, sprint_id, moved: issue_keys });
  },
  {
    name: "jira_move_issues_to_sprint",
    description:
      "Move issues into a sprint. Up to 50 issues per call. Issues already in another sprint are " +
      "transparently moved (no separate remove step needed). Use jira_move_issues_to_backlog to remove " +
      "issues from sprints without putting them in a new one.",
    schema: z.object({
      sprint_id: z.union([z.string(), z.number()]),
      issue_keys: z.array(z.string()).describe("Issue keys to move (e.g. ['PROJ-1','PROJ-2'])"),
    }),
  },
);

export const jiraMoveIssuesToBacklogTool = tool(
  async ({ issue_keys, board_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!issue_keys.length) return JSON.stringify({ error: "issue_keys is empty" });
    if (issue_keys.length > 50) {
      return JSON.stringify({ error: `agile API accepts up to 50 issues per call (got ${issue_keys.length})` });
    }
    // The board-scoped endpoint /backlog/{boardId}/issue moves issues into THAT
    // board's backlog (preserving rank). The unscoped /backlog/issue endpoint
    // works for Scrum boards but not Kanban. Caller passes board_id when known.
    const path = board_id
      ? `/rest/agile/1.0/backlog/${encodeURIComponent(board_id)}/issue`
      : `/rest/agile/1.0/backlog/issue`;
    const data = await atlassianFetch(auth, path, {
      method: "POST",
      body: JSON.stringify({ issues: issue_keys }),
    }) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, moved_to_backlog: issue_keys, board_id: board_id ?? null });
  },
  {
    name: "jira_move_issues_to_backlog",
    description:
      "Remove issues from their current sprint and put them back on the backlog. Up to 50 issues per " +
      "call. Pass `board_id` for Kanban boards (the unscoped endpoint only works for Scrum). For Scrum, " +
      "board_id is optional but recommended for clarity.",
    schema: z.object({
      issue_keys: z.array(z.string()),
      board_id: z.union([z.string(), z.number()]).optional().describe(
        "Required for Kanban boards; optional but recommended for Scrum",
      ),
    }),
  },
);

export const jiraRankIssuesTool = tool(
  async ({ issues, rank_before_issue, rank_after_issue, rank_custom_field_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!issues.length) return JSON.stringify({ error: "issues is empty" });
    if (issues.length > 50) {
      return JSON.stringify({ error: `agile API accepts up to 50 issues per call (got ${issues.length})` });
    }
    if ((rank_before_issue && rank_after_issue) || (!rank_before_issue && !rank_after_issue)) {
      return JSON.stringify({
        error: "pass exactly one of rank_before_issue or rank_after_issue (not both, not neither)",
      });
    }
    const body: Record<string, unknown> = { issues };
    if (rank_before_issue) body.rankBeforeIssue = rank_before_issue;
    if (rank_after_issue) body.rankAfterIssue = rank_after_issue;
    if (rank_custom_field_id !== undefined) body.rankCustomFieldId = rank_custom_field_id;
    const data = await atlassianFetch(auth, `/rest/agile/1.0/issue/rank`, {
      method: "PUT",
      body: JSON.stringify(body),
    }) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      ranked: issues,
      relative_to: rank_before_issue ? { before: rank_before_issue } : { after: rank_after_issue },
    });
  },
  {
    name: "jira_rank_issues",
    description:
      "Rank up to 50 issues relative to a single anchor issue (before XOR after). Pass " +
      "rank_custom_field_id only on sites that have a non-default rank field — get it from " +
      "jira_get_board.configuration.ranking_field. Order within `issues[]` is preserved.",
    schema: z.object({
      issues: z.array(z.string()).describe("Issue keys in the order they should be placed"),
      rank_before_issue: z.string().optional().describe("Anchor: place `issues` immediately before this key"),
      rank_after_issue: z.string().optional().describe("Anchor: place `issues` immediately after this key"),
      rank_custom_field_id: z.number().optional().describe(
        "Custom rank field id (numeric). Default is the global rank field; rarely needed.",
      ),
    }),
  },
);

// ── Jira issue extras (comments CRUD, worklogs, attachments, changelog) ─────
//
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

// ── Jira project metadata (projects, versions, components, generic enums) ──
//
// These let the agent introspect a site without guessing — list projects,
// list versions on a project, read the canonical issue-type/priority/status
// names. Mostly thin wrappers around /rest/api/3/project*, /version, /component,
// and the four enum endpoints. See ADR-0035.

export const jiraListProjectsTool = tool(
  async ({ query, category_id, max_results, start_at }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (category_id !== undefined) params.set("categoryId", String(category_id));
    if (start_at !== undefined) params.set("startAt", String(start_at));
    params.set("maxResults", String(Math.min(max_results ?? 50, 100)));
    const data = await atlassianFetch(auth, `/rest/api/3/project/search?${params}`) as
      | { values?: Array<Record<string, unknown>>; total?: number; isLast?: boolean; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      total: data.total ?? 0,
      is_last: data.isLast ?? null,
      projects: (data.values ?? []).map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        type_key: p.projectTypeKey ?? null,
        style: p.style ?? null,
        lead: ((p.lead as Record<string, unknown>)?.displayName) ?? null,
      })),
    });
  },
  {
    name: "jira_list_projects",
    description:
      "List Jira projects (paginated). Filter by name fragment via `query` or by category. Returns " +
      "id, key, name, type, style ('classic'|'next-gen'), lead.",
    schema: z.object({
      query: z.string().optional().describe("Project name/key fragment"),
      category_id: z.number().optional(),
      start_at: z.number().optional(),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);

export const jiraGetProjectTool = tool(
  async ({ project_key, include_versions, include_components, include_issue_types }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const expand: string[] = [];
    if (include_versions) expand.push("versions");
    if (include_components) expand.push("components");
    if (include_issue_types) expand.push("issueTypes");
    const qs = expand.length ? `?expand=${expand.join(",")}` : "";
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/project/${encodeURIComponent(project_key)}${qs}`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      id: data.id,
      key: data.key,
      name: data.name,
      type_key: data.projectTypeKey ?? null,
      style: data.style ?? null,
      description: data.description ?? null,
      lead: ((data.lead as Record<string, unknown>)?.displayName) ?? null,
      url: `${auth.url}/browse/${data.key}`,
      ...(include_versions ? {
        versions: ((data.versions as Array<Record<string, unknown>>) ?? []).map((v) => ({
          id: v.id, name: v.name, released: v.released, archived: v.archived,
          start_date: v.startDate ?? null, release_date: v.releaseDate ?? null,
        })),
      } : {}),
      ...(include_components ? {
        components: ((data.components as Array<Record<string, unknown>>) ?? []).map((c) => ({
          id: c.id, name: c.name,
          lead: ((c.lead as Record<string, unknown>)?.displayName) ?? null,
        })),
      } : {}),
      ...(include_issue_types ? {
        issue_types: ((data.issueTypes as Array<Record<string, unknown>>) ?? []).map((t) => ({
          id: t.id, name: t.name, subtask: t.subtask, hierarchy_level: t.hierarchyLevel,
        })),
      } : {}),
    });
  },
  {
    name: "jira_get_project",
    description:
      "Fetch a single Jira project by key. Optionally include versions, components, and/or issue types " +
      "in the response — saves separate calls for the common 'tell me about this project' use case.",
    schema: z.object({
      project_key: z.string(),
      include_versions: z.boolean().optional(),
      include_components: z.boolean().optional(),
      include_issue_types: z.boolean().optional(),
    }),
  },
);

export const jiraListVersionsTool = tool(
  async ({ project_key, start_at, max_results, order_by }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (start_at !== undefined) params.set("startAt", String(start_at));
    params.set("maxResults", String(Math.min(max_results ?? 50, 100)));
    if (order_by) params.set("orderBy", order_by);
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/project/${encodeURIComponent(project_key)}/version?${params}`,
    ) as {
      values?: Array<Record<string, unknown>>;
      total?: number; isLast?: boolean; error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      total: data.total ?? 0,
      is_last: data.isLast ?? null,
      versions: (data.values ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        released: v.released,
        archived: v.archived,
        start_date: v.startDate ?? null,
        release_date: v.releaseDate ?? null,
        description: v.description ?? null,
      })),
    });
  },
  {
    name: "jira_list_versions",
    description:
      "List versions on a Jira project (paginated). Returns id, name, released/archived flags, dates. " +
      "Use jira_create_version to add a new one and jira_update_version to release/archive.",
    schema: z.object({
      project_key: z.string(),
      start_at: z.number().optional(),
      max_results: z.number().optional().describe("Default 50, max 100"),
      order_by: z.enum(["sequence", "name", "startDate", "releaseDate", "-sequence", "-name", "-startDate", "-releaseDate"]).optional(),
    }),
  },
);

export const jiraCreateVersionTool = tool(
  async ({ project_key, name, description, start_date, release_date, released }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Resolve project key → numeric project id (the version endpoint requires id, not key).
    const proj = await atlassianFetch(auth, `/rest/api/3/project/${encodeURIComponent(project_key)}`) as
      { id?: string; error?: string };
    if (proj.error) return JSON.stringify(proj);
    if (!proj.id) return JSON.stringify({ error: `could not resolve project_key "${project_key}" to a numeric id` });
    const body: Record<string, unknown> = { projectId: Number(proj.id), name };
    if (description !== undefined) body.description = description;
    if (start_date !== undefined) body.startDate = start_date;
    if (release_date !== undefined) body.releaseDate = release_date;
    if (released !== undefined) body.released = released;
    const data = await atlassianFetch(auth, `/rest/api/3/version`, {
      method: "POST", body: JSON.stringify(body),
    }) as { id?: string; name?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, version_id: data.id, name: data.name });
  },
  {
    name: "jira_create_version",
    description:
      "Create a new version on a Jira project. Pass the project key — we resolve it to the numeric id. " +
      "start_date / release_date are 'YYYY-MM-DD'. Set released=true to mark released on creation.",
    schema: z.object({
      project_key: z.string(),
      name: z.string(),
      description: z.string().optional(),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      release_date: z.string().optional().describe("YYYY-MM-DD"),
      released: z.boolean().optional(),
    }),
  },
);

export const jiraUpdateVersionTool = tool(
  async ({ version_id, name, description, start_date, release_date, released, archived }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (start_date !== undefined) body.startDate = start_date;
    if (release_date !== undefined) body.releaseDate = release_date;
    if (released !== undefined) body.released = released;
    if (archived !== undefined) body.archived = archived;
    if (Object.keys(body).length === 0) {
      return JSON.stringify({ error: "no fields to update — pass at least one of name, description, start_date, release_date, released, archived" });
    }
    const data = await atlassianFetch(auth, `/rest/api/3/version/${encodeURIComponent(version_id)}`, {
      method: "PUT", body: JSON.stringify(body),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      version_id,
      released: data.released ?? null,
      archived: data.archived ?? null,
      updated_fields: Object.keys(body),
    });
  },
  {
    name: "jira_update_version",
    description:
      "Edit a version: rename, change dates, mark released/unreleased, mark archived/unarchived. " +
      "Pass only the fields you want to change. To 'release' a version, pass released=true (and " +
      "release_date if not already set). To unrelease, pass released=false. **Disable to make the " +
      "agent unable to release versions.**",
    schema: z.object({
      version_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      start_date: z.string().optional(),
      release_date: z.string().optional(),
      released: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
  },
);

export const jiraListComponentsTool = tool(
  async ({ project_key }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await atlassianFetch(
      auth,
      `/rest/api/3/project/${encodeURIComponent(project_key)}/components`,
    ) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      components: data.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description ?? null,
        lead: ((c.lead as Record<string, unknown>)?.displayName) ?? null,
        assignee_type: c.assigneeType ?? null,
      })),
    });
  },
  {
    name: "jira_list_components",
    description:
      "List components on a Jira project. Returns id, name, description, lead, default assignee type. " +
      "Components are not paginated by Jira — the full list returns in one call.",
    schema: z.object({ project_key: z.string() }),
  },
);

export const jiraCreateComponentTool = tool(
  async ({ project_key, name, description, lead_account_id, assignee_type }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = { project: project_key, name };
    if (description !== undefined) body.description = description;
    if (lead_account_id !== undefined) body.leadAccountId = lead_account_id;
    if (assignee_type !== undefined) body.assigneeType = assignee_type;
    const data = await atlassianFetch(auth, `/rest/api/3/component`, {
      method: "POST", body: JSON.stringify(body),
    }) as { id?: string; name?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, component_id: data.id, name: data.name });
  },
  {
    name: "jira_create_component",
    description:
      "Create a component on a Jira project. assignee_type controls default assignee for issues with " +
      "this component: 'PROJECT_DEFAULT' | 'COMPONENT_LEAD' | 'PROJECT_LEAD' | 'UNASSIGNED'.",
    schema: z.object({
      project_key: z.string(),
      name: z.string(),
      description: z.string().optional(),
      lead_account_id: z.string().optional(),
      assignee_type: z.enum(["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"]).optional(),
    }),
  },
);

const META_KIND_TO_PATH: Record<string, string> = {
  issue_type: "/rest/api/3/issuetype",
  priority: "/rest/api/3/priority",
  status: "/rest/api/3/status",
  resolution: "/rest/api/3/resolution",
};
const META_KINDS = Object.keys(META_KIND_TO_PATH) as ReadonlyArray<keyof typeof META_KIND_TO_PATH>;

export const jiraListMetaTool = tool(
  async ({ kind }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!kind) {
      return JSON.stringify({
        available_kinds: META_KINDS,
        usage: "Pass kind='issue_type' | 'priority' | 'status' | 'resolution' to list that enum's values for the site.",
      });
    }
    const path = META_KIND_TO_PATH[kind];
    if (!path) {
      return JSON.stringify({ error: `unknown kind "${kind}". Expected one of: ${META_KINDS.join(", ")}.` });
    }
    const data = await atlassianFetch(auth, path) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      kind,
      values: data.map((v) => ({
        id: v.id,
        name: v.name,
        description: v.description ?? null,
        ...(kind === "issue_type" ? { subtask: v.subtask, hierarchy_level: v.hierarchyLevel } : {}),
        ...(kind === "status" ? {
          status_category: ((v.statusCategory as Record<string, unknown>)?.name) ?? null,
        } : {}),
      })),
    });
  },
  {
    name: "jira_list_meta",
    description:
      "List values for a Jira site-wide enum: issue types, priorities, statuses, or resolutions. " +
      "Pass `kind` = 'issue_type' | 'priority' | 'status' | 'resolution'. Omit `kind` to list available kinds. " +
      "Use this before jira_create_issue / jira_update_issue when you don't know the exact name on this site.",
    schema: z.object({
      kind: z.enum(META_KINDS as [string, ...string[]]).optional(),
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
    const encodedPageId = encodeURIComponent(page_id);
    const [storageData, viewData] = await Promise.all([
      atlassianFetch(
        auth,
        `/wiki/api/v2/pages/${encodedPageId}?body-format=storage&include-version=true`,
      ) as Promise<Record<string, unknown> & { error?: string }>,
      atlassianFetch(
        auth,
        `/wiki/api/v2/pages/${encodedPageId}?body-format=view&include-version=true`,
      ) as Promise<Record<string, unknown> & { error?: string }>,
    ]);
    if (storageData.error) return JSON.stringify(storageData);
    if (viewData.error) return JSON.stringify(viewData);
    const storageBody = storageData.body as Record<string, Record<string, unknown> | undefined> | undefined;
    const viewBody = viewData.body as Record<string, Record<string, unknown> | undefined> | undefined;
    const storageVal = storageBody?.storage?.value as string | undefined;
    const viewVal = viewBody?.view?.value as string | undefined;
    const links = storageData._links as Record<string, unknown> | undefined;
    const webui = links?.webui as string | undefined;
    return JSON.stringify({
      id: storageData.id,
      title: storageData.title,
      url: webui ? `${auth.url}/wiki${webui}` : null,
      space_id: storageData.spaceId ?? null,
      parent_id: storageData.parentId ?? null,
      status: storageData.status,
      version: (storageData.version as Record<string, unknown> | undefined)?.number ?? null,
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

// ── Confluence v2 gap-fillers (ADR-0035) ────────────────────────────────────
//
// v2 audit on 2026-05-28 confirmed:
//   - DELETE /pages/{id} exists (with optional purge=true).
//   - PUT/DELETE /footer-comments/{id} and /inline-comments/{id} exist.
//   - DELETE /attachments/{id} exists (with optional purge=true).
//   - Label group is STILL read-only (CONFCLOUD-76866); confluence_remove_label
//     uses the v1 fallback `DELETE /content/{id}/label?name=...`.

export const confluenceDeletePageTool = tool(
  async ({ page_id, purge, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (purge && confirm !== page_id) {
      return JSON.stringify({
        error:
          `Refusing to permanently delete page ${page_id}: purge=true requires confirm to equal page_id. ` +
          `A purged page cannot be restored from trash. Drop purge if you only want to soft-delete.`,
      });
    }
    const qs = purge ? `?purge=true` : "";
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/pages/${encodeURIComponent(page_id)}${qs}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_page_id: page_id, purged: !!purge });
  },
  {
    name: "confluence_delete_page",
    description:
      "Delete a Confluence page (v2). Default soft-deletes (page goes to trash, restorable). " +
      "Pass purge=true for permanent deletion, which **also requires `confirm` to equal page_id** " +
      "as a guardrail. Disable to make the agent unable to delete pages.",
    schema: z.object({
      page_id: z.string(),
      purge: z.boolean().optional().describe("If true, permanently delete (skip trash). Requires confirm=page_id."),
      confirm: z.string().optional().describe("Required when purge=true; must equal page_id."),
    }),
  },
);

const COMMENT_KIND_TO_PATH: Record<string, string> = {
  footer: "footer-comments",
  inline: "inline-comments",
};

export const confluenceUpdateCommentTool = tool(
  async ({ comment_id, kind, body_text, body_storage, version_number, version_message }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const segment = COMMENT_KIND_TO_PATH[kind];
    if (!segment) {
      return JSON.stringify({ error: `unknown kind "${kind}". Expected 'footer' or 'inline'.` });
    }
    const body = resolveBody({ body_text, body_storage });
    if ("error" in body) return JSON.stringify(body);

    let nextVersion = version_number;
    if (nextVersion === undefined) {
      // PUT requires version.number = current + 1; auto-fetch when not passed.
      const current = await atlassianFetch(
        auth,
        `/wiki/api/v2/${segment}/${encodeURIComponent(comment_id)}`,
      ) as { version?: { number?: number }; error?: string };
      if (current.error) return JSON.stringify(current);
      const cur = current.version?.number;
      if (typeof cur !== "number") return JSON.stringify({ error: "could not read current comment version" });
      nextVersion = cur + 1;
    }

    const payload: Record<string, unknown> = {
      version: { number: nextVersion, ...(version_message ? { message: version_message } : {}) },
      body: { representation: body.representation, value: body.value },
    };
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/${segment}/${encodeURIComponent(comment_id)}`,
      { method: "PUT", body: JSON.stringify(payload) },
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      comment_id,
      kind,
      version: (data.version as Record<string, unknown> | undefined)?.number ?? nextVersion,
    });
  },
  {
    name: "confluence_update_comment",
    description:
      "Edit an existing Confluence comment (v2). Pass `kind: 'footer' | 'inline'` to route to the " +
      "correct endpoint. Same `body_text` xor `body_storage` pattern as confluence_add_comment. If " +
      "version_number is omitted, the tool auto-fetches the current version and sends current+1 " +
      "(Confluence requires strict +1 increments).",
    schema: z.object({
      comment_id: z.string(),
      kind: z.enum(["footer", "inline"]),
      body_text: z.string().optional(),
      body_storage: z.string().optional(),
      version_number: z.number().optional().describe("Explicit version (must be current+1). Omit to auto-fetch."),
      version_message: z.string().optional(),
    }),
  },
);

export const confluenceDeleteCommentTool = tool(
  async ({ comment_id, kind }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const segment = COMMENT_KIND_TO_PATH[kind];
    if (!segment) {
      return JSON.stringify({ error: `unknown kind "${kind}". Expected 'footer' or 'inline'.` });
    }
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/${segment}/${encodeURIComponent(comment_id)}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_comment_id: comment_id, kind });
  },
  {
    name: "confluence_delete_comment",
    description:
      "Permanently delete a Confluence comment (v2). Pass `kind: 'footer' | 'inline'`. **Destructive — " +
      "no undo.** Disable to make the agent unable to delete comments.",
    schema: z.object({
      comment_id: z.string(),
      kind: z.enum(["footer", "inline"]),
    }),
  },
);

export const confluenceRemoveLabelTool = tool(
  async ({ page_id, label }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // v1 fallback — v2 Label group is read-only as of 2026-05-28 (CONFCLOUD-76866).
    // The v1 endpoint accepts the label name as a query param; the prefix
    // defaults to "global" which is what confluence_add_label uses.
    const data = await atlassianFetch(
      auth,
      `/wiki/rest/api/content/${encodeURIComponent(page_id)}/label?name=${encodeURIComponent(label)}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, page_id, removed_label: label });
  },
  {
    name: "confluence_remove_label",
    description:
      "Remove a single label from a Confluence page. Uses the v1 endpoint (v2 Label group is still " +
      "read-only as of 2026). Counterpart to confluence_add_label.",
    schema: z.object({
      page_id: z.string(),
      label: z.string().describe("Label name to remove (no prefix; we always use 'global')"),
    }),
  },
);

export const confluenceDeleteAttachmentTool = tool(
  async ({ attachment_id, purge, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (purge && confirm !== attachment_id) {
      return JSON.stringify({
        error:
          `Refusing to permanently delete attachment ${attachment_id}: purge=true requires confirm to equal attachment_id. ` +
          `A purged attachment cannot be restored.`,
      });
    }
    const qs = purge ? `?purge=true` : "";
    const data = await atlassianFetch(
      auth,
      `/wiki/api/v2/attachments/${encodeURIComponent(attachment_id)}${qs}`,
      { method: "DELETE" },
    ) as { error?: string } | string;
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_attachment_id: attachment_id, purged: !!purge });
  },
  {
    name: "confluence_delete_attachment",
    description:
      "Delete a Confluence attachment by id (v2). Default soft-deletes (trash, restorable). Pass " +
      "purge=true for permanent deletion, which **also requires `confirm` to equal attachment_id** " +
      "as a guardrail.",
    schema: z.object({
      attachment_id: z.string(),
      purge: z.boolean().optional(),
      confirm: z.string().optional().describe("Required when purge=true; must equal attachment_id."),
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

// ── Capability-grouped exports ──────────────────────────────────────────────
// Agents that gate by capability can use these arrays directly; agents that
// want fine-grained control can import each tool by name above.

export const atlassianReadTools = [
  jiraSearchTool, jiraGetIssueTool, jiraFindUserTool,
  jiraListBoardsTool, jiraGetBoardTool,
  jiraListSprintsTool, jiraGetSprintTool,
  jiraGetCommentsTool, jiraGetAttachmentContentTool,
  jiraListWorklogsTool, jiraGetChangelogTool,
  jiraListProjectsTool, jiraGetProjectTool,
  jiraListVersionsTool, jiraListComponentsTool, jiraListMetaTool,
  confluenceSearchTool, confluenceGetPageTool,
  confluenceGetPageByTitleTool, confluenceGetPageChildrenTool,
  confluenceGetPageAncestorsTool, confluenceListSpacesTool,
  confluenceGetCommentsTool, confluenceListAttachmentsTool,
  confluenceGetLabelsTool, confluenceGetAttachmentContentTool,
] as const;

export const atlassianWriteTools = [
  jiraCreateIssueTool, jiraCreateIssuesBulkTool, jiraUpdateIssueTool,
  jiraAddCommentTool,
  jiraLinkIssuesTool, jiraAddRemoteLinkTool, jiraDeleteLinkTool,
  jiraUploadAttachmentTool, jiraDeleteIssueTool,
  jiraCreateSprintTool, jiraUpdateSprintTool, jiraDeleteSprintTool,
  jiraMoveIssuesToSprintTool, jiraMoveIssuesToBacklogTool, jiraRankIssuesTool,
  jiraUpdateCommentTool, jiraDeleteCommentTool, jiraDeleteAttachmentTool,
  jiraAddWorklogTool,
  jiraCreateVersionTool, jiraUpdateVersionTool, jiraCreateComponentTool,
  confluenceCreatePageTool, confluenceUpdatePageTool,
  confluenceAddCommentTool, confluenceMovePageTool,
  confluenceUploadAttachmentTool, confluenceAddLabelTool,
  confluenceDeletePageTool, confluenceUpdateCommentTool, confluenceDeleteCommentTool,
  confluenceRemoveLabelTool, confluenceDeleteAttachmentTool,
] as const;

export const atlassianExecuteTools = [jiraTransitionsTool] as const;

// Convenience aggregate.
export const atlassianTools = [
  ...atlassianReadTools,
  ...atlassianWriteTools,
  ...atlassianExecuteTools,
] as const;
