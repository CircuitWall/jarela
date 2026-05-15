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
  try { return JSON.parse(text); } catch { return text; }
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
  async ({ issue_key, expand }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const expandStr = expand?.length ? `?expand=${expand.join(",")}` : "";
    const data = await atlassianFetch(auth, `/rest/api/3/issue/${encodeURIComponent(issue_key)}${expandStr}`) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const f = (data.fields ?? {}) as Record<string, unknown>;
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
    });
  },
  {
    name: "jira_get_issue",
    description:
      "Fetch a single Jira issue by key (e.g. 'PROJ-123'). Returns full detail including description. " +
      "**PREFER THIS over shell-exec'ing the jira CLI.**",
    schema: z.object({
      issue_key: z.string().describe("Issue key like PROJ-123"),
      expand: z.array(z.string()).optional().describe("Fields to expand (e.g. ['changelog', 'transitions'])"),
    }),
  },
);

export const jiraCreateIssueTool = tool(
  async ({ project_key, summary, description, issue_type }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body = {
      fields: {
        project: { key: project_key },
        summary,
        ...(description ? { description: textToADF(description) } : {}),
        issuetype: { name: issue_type ?? "Task" },
      },
    };
    const data = await atlassianFetch(auth, `/rest/api/3/issue`, {
      method: "POST",
      body: JSON.stringify(body),
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
    description: "Create a new Jira issue. Defaults to issue_type='Task'. **PREFER THIS over shell-exec'ing the jira CLI.**",
    schema: z.object({
      project_key: z.string().describe("Project key (e.g. 'ENG')"),
      summary: z.string().describe("Issue title"),
      description: z.string().optional().describe("Plain-text description (auto-converted to ADF)"),
      issue_type: z.string().optional().describe("Issue type name (default: Task; valid: Task, Bug, Story, Epic, …)"),
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

// ── Confluence tools ────────────────────────────────────────────────────────

export const confluenceSearchTool = tool(
  async ({ cql, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 15, 50);
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
      `/wiki/rest/api/content/${encodeURIComponent(page_id)}?expand=body.view,version,space`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const body = ((data.body as Record<string, unknown>)?.view as Record<string, unknown>)?.value as string | undefined;
    return JSON.stringify({
      id: data.id,
      title: data.title,
      url: `${auth.url}/wiki${((data._links as Record<string, unknown>)?.webui) ?? ""}`,
      space: ((data.space as Record<string, unknown>)?.key) ?? null,
      version: ((data.version as Record<string, unknown>)?.number) ?? null,
      body_html: body ? body.slice(0, 20_000) : null,  // cap to avoid context blow-up
      truncated: body ? body.length > 20_000 : false,
    });
  },
  {
    name: "confluence_get_page",
    description: "Fetch a Confluence page by id, including rendered HTML body (capped at 20KB).",
    schema: z.object({
      page_id: z.string(),
    }),
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

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
