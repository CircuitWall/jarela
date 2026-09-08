import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { atlassianFetch, authHeader, parseJsonSafe, resolveAuth, type AtlassianAuth } from "../shared";
import {
  extractFieldValue,
  loadJiraFields,
  resolveCustomFieldNames,
  simplifyADF,
  textToADF,
  type JiraFieldDef,
} from "./jira-formatters";

export const jiraSearchTool = tool(
  async ({ jql, max_results, fields }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 25, 100);
    const fieldList = fields ?? ["summary", "status", "assignee", "priority", "created", "updated"];
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
        "Custom field display names ('Vulnerability Description') or ids ('customfield_NNNNN') to include",
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

    const resolved = await resolveJiraLinkType(auth, link_type, from_issue, to_issue);
    if ("listing" in resolved) return resolved.listing;
    const { match } = resolved;

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

    const form = new FormData();
    form.append("file", new Blob([buf]), filename);

    const url = `${auth.url}/rest/api/3/issue/${encodeURIComponent(issue_key)}/attachments`;
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

const SPRINT_STATES = ["future", "active", "closed"] as const;
type SprintState = (typeof SPRINT_STATES)[number];

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

const normalizeIssueAnchor = (value: string | { issueKey: string } | undefined): { issueKey: string } | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "string") return { issueKey: value };
  if (value && typeof value === "object" && typeof value.issueKey === "string" && value.issueKey.trim()) {
    return { issueKey: value.issueKey };
  }
  throw new Error("rank anchor must be an issue key string or an object with issueKey");
};

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
    try {
      const body: Record<string, unknown> = { issues };
      const beforeAnchor = normalizeIssueAnchor(rank_before_issue);
      const afterAnchor = normalizeIssueAnchor(rank_after_issue);
      if (beforeAnchor) body.rankBeforeIssue = beforeAnchor;
      if (afterAnchor) body.rankAfterIssue = afterAnchor;
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
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
    }
  },
  {
    name: "jira_rank_issues",
    description:
      "Rank up to 50 issues relative to a single anchor issue (before XOR after). Pass " +
      "rank_custom_field_id only on sites that have a non-default rank field — get it from " +
      "jira_get_board.configuration.ranking_field. Order within `issues[]` is preserved.",
    schema: z.object({
      issues: z.array(z.string()).describe("Issue keys in the order they should be placed"),
      rank_before_issue: z.union([
        z.string(),
        z.object({ issueKey: z.string() }),
      ]).optional().describe("Anchor: place `issues` immediately before this key or {issueKey} object"),
      rank_after_issue: z.union([
        z.string(),
        z.object({ issueKey: z.string() }),
      ]).optional().describe("Anchor: place `issues` immediately after this key or {issueKey} object"),
      rank_custom_field_id: z.number().optional().describe(
        "Custom rank field id (numeric). Default is the global rank field; rarely needed.",
      ),
    }),
  },
);

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

export const jiraReadTools = [
  jiraSearchTool, jiraGetIssueTool, jiraFindUserTool,
  jiraListBoardsTool, jiraGetBoardTool,
  jiraListSprintsTool, jiraGetSprintTool,
  jiraGetCommentsTool, jiraGetAttachmentContentTool,
  jiraListWorklogsTool, jiraGetChangelogTool,
  jiraListProjectsTool, jiraGetProjectTool,
  jiraListVersionsTool, jiraListComponentsTool, jiraListMetaTool,
] as const;

export const jiraWriteTools = [
  jiraCreateIssueTool, jiraCreateIssuesBulkTool, jiraUpdateIssueTool,
  jiraAddCommentTool,
  jiraLinkIssuesTool, jiraAddRemoteLinkTool, jiraDeleteLinkTool,
  jiraUploadAttachmentTool, jiraDeleteIssueTool,
  jiraCreateSprintTool, jiraUpdateSprintTool, jiraDeleteSprintTool,
  jiraMoveIssuesToSprintTool, jiraMoveIssuesToBacklogTool, jiraRankIssuesTool,
  jiraUpdateCommentTool, jiraDeleteCommentTool, jiraDeleteAttachmentTool,
  jiraAddWorklogTool,
  jiraCreateVersionTool, jiraUpdateVersionTool, jiraCreateComponentTool,
] as const;

export const jiraExecuteTools = [jiraTransitionsTool] as const;

export const jiraTools = [
  ...jiraReadTools,
  ...jiraWriteTools,
  ...jiraExecuteTools,
] as const;
