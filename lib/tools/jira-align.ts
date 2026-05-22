/**
 * Native Jira Align tools — direct REST API calls.
 *
 * Sibling to `atlassian.ts` (Jira/Confluence). Jira Align is a separate
 * Atlassian product with its own API surface, hostname, and auth model:
 *   - URL:  https://<instance>.jiraalign.com
 *   - Auth: Bearer token (NOT email + API token like Jira Cloud)
 *   - API:  /rest/align/api/2/...   (work items, teams, programs, …)
 *
 * Each CRUD operation is exported as its own tool so users can flip
 * read-only / write / delete permissions independently in the AgentEditor
 * — see ToolPolicy in lib/agents/base.ts. To revoke writes, uncheck the
 * `jira_align_create_*` / `jira_align_update_*` / `jira_align_delete_*`
 * tools while leaving the read tools enabled.
 *
 * Auth resolution (priority order):
 *   1. Env: JIRA_ALIGN_URL, JIRA_ALIGN_TOKEN
 *   2. Memory store: namespace="integrations", key="jira_align",
 *      value={ url, api_token }   (set via the Integrations panel UI)
 *
 * NOTE — endpoint shapes follow the JA REST API v2 conventions but JA
 * instances vary (custom fields, work-item-type IDs, hierarchy depth).
 * Verify the exact paths your instance exposes via its Swagger UI at
 * `<instance>.jiraalign.com/swagger` before relying on these in
 * production. This is the v1 draft surface (ADR-0019).
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIntegrationRaw } from "@/lib/stores/integrations";
import { parseJsonSafe } from "@/lib/utils/json";

export interface JiraAlignAuth {
  url: string;        // e.g. "https://acme.jiraalign.com"
  apiToken: string;
}

export function _resolveJiraAlignAuth(): JiraAlignAuth | { error: string } {
  return resolveAuth();
}

function resolveAuth(): JiraAlignAuth | { error: string } {
  const envUrl = process.env.JIRA_ALIGN_URL;
  const envToken = process.env.JIRA_ALIGN_TOKEN;
  if (envUrl && envToken) {
    return { url: stripTrailingSlash(envUrl), apiToken: envToken };
  }
  const saved = getIntegrationRaw("jira_align");
  if (saved?.url && saved.api_token) {
    return { url: stripTrailingSlash(saved.url), apiToken: saved.api_token };
  }
  return {
    error:
      "Jira Align not configured. Open the gear menu → Integrations tab and add your " +
      "Jira Align instance URL and API token. (Or set JIRA_ALIGN_URL / JIRA_ALIGN_TOKEN " +
      "env vars before starting Jarela.)",
  };
}

function stripTrailingSlash(s: string): string { return s.replace(/\/+$/, ""); }

async function jaFetch(
  auth: JiraAlignAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${auth.url}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: `Jira Align ${res.status}: ${text.slice(0, 500)}`, url };
  }
  return parseJsonSafe<unknown>(text, text);
}

// ── Read tools ──────────────────────────────────────────────────────────────

export const jiraAlignGetItemTool = tool(
  async ({ item_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await jaFetch(auth, `/rest/align/api/2/items/${encodeURIComponent(item_id)}`) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      id: data.id,
      url: `${auth.url}/Item/${data.id}`,
      type: data.type,
      title: data.title,
      state: data.state,
      description: data.description,
      parent_id: data.parentId ?? null,
      program_id: data.programId ?? null,
      team_id: data.teamId ?? null,
      release_id: data.releaseId ?? null,
      sprint_id: data.sprintId ?? null,
      owner: data.owner ?? null,
      created_at: data.createDate ?? null,
      updated_at: data.lastUpdated ?? null,
    });
  },
  {
    name: "jira_align_get_item",
    description:
      "Fetch a Jira Align work item by id (epic, capability, feature, story, …). " +
      "Returns title, state, hierarchy refs (parent/program/team/release/sprint), " +
      "owner, and timestamps. Use jira_align_get_item_children to walk the tree.",
    schema: z.object({
      item_id: z.string().describe("Numeric Jira Align item id (e.g. '12345')"),
    }),
  },
);

export const jiraAlignSearchItemsTool = tool(
  async ({ type, state, owner, program_id, team_id, updated_since, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (state) params.set("state", state);
    if (owner) params.set("owner", owner);
    if (program_id) params.set("programId", program_id);
    if (team_id) params.set("teamId", team_id);
    if (updated_since) params.set("lastUpdatedSince", updated_since);
    params.set("limit", String(Math.min(max_results ?? 25, 100)));
    const data = await jaFetch(auth, `/rest/align/api/2/items?${params.toString()}`) as { items?: Array<Record<string, unknown>>; nextPageToken?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      items: (data.items ?? []).map((i) => ({
        id: i.id,
        type: i.type,
        title: i.title,
        state: i.state,
        owner: i.owner ?? null,
        url: `${auth.url}/Item/${i.id}`,
      })),
      next_page_token: data.nextPageToken ?? null,
    });
  },
  {
    name: "jira_align_search_items",
    description:
      "Search Jira Align work items by type/state/owner/program/team/recent updates. " +
      "Returns a compact list (id, type, title, state, owner). Pass updated_since='-7d' " +
      "or an ISO date for recency. **Prefer this over jira_align_get_item when listing.**",
    schema: z.object({
      type: z.string().optional().describe("Item type: 'epic' | 'capability' | 'feature' | 'story' | 'theme' | 'objective' | …"),
      state: z.string().optional().describe("Workflow state name (e.g. 'In Progress', 'Done')"),
      owner: z.string().optional().describe("Owner email or username"),
      program_id: z.string().optional(),
      team_id: z.string().optional(),
      updated_since: z.string().optional().describe("ISO timestamp or relative (e.g. '-7d')"),
      max_results: z.number().optional().describe("Default 25, max 100"),
    }),
  },
);

export const jiraAlignGetItemChildrenTool = tool(
  async ({ item_id, depth }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const a: JiraAlignAuth = auth;  // narrowed for closure capture
    const maxDepth = Math.min(depth ?? 1, 4);

    interface Node { id: string; type?: string; title?: string; state?: string; children: Node[] }
    async function fetchChildren(id: string): Promise<Array<Record<string, unknown>>> {
      const data = await jaFetch(a, `/rest/align/api/2/items/${encodeURIComponent(id)}/children`) as { items?: Array<Record<string, unknown>>; error?: string };
      if (data.error) return [];
      return data.items ?? [];
    }
    async function walk(id: string, d: number): Promise<Node> {
      const kids = d < maxDepth ? await fetchChildren(id) : [];
      const children = await Promise.all(
        kids.map(async (k) => walk(String(k.id), d + 1)),
      );
      return { id, children };
    }
    const tree = await walk(item_id, 0);

    return JSON.stringify({
      root_id: item_id,
      depth: maxDepth,
      tree,
      note: "Each node carries `id` + `children`. Call jira_align_get_item for full details on any node.",
    });
  },
  {
    name: "jira_align_get_item_children",
    description:
      "Walk a Jira Align item's children to a given depth (default 1, max 4). Returns a " +
      "tree of `{id, children}` so the agent can summarize portfolio → epic → feature → story " +
      "structure without N round-trips. For full item details, follow up with jira_align_get_item.",
    schema: z.object({
      item_id: z.string().describe("Root item id to walk from"),
      depth: z.number().optional().describe("Levels to descend (default 1, max 4)"),
    }),
  },
);

// ── Write tools ─────────────────────────────────────────────────────────────

export const jiraAlignCreateItemTool = tool(
  async ({ type, title, description, parent_id, program_id, team_id, owner }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = { type, title };
    if (description) body.description = description;
    if (parent_id) body.parentId = parent_id;
    if (program_id) body.programId = program_id;
    if (team_id) body.teamId = team_id;
    if (owner) body.owner = owner;
    const data = await jaFetch(auth, `/rest/align/api/2/items`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      id: data.id,
      url: data.id ? `${auth.url}/Item/${data.id}` : null,
    });
  },
  {
    name: "jira_align_create_item",
    description:
      "Create a Jira Align work item. Set `type` to 'epic' | 'capability' | 'feature' | " +
      "'story' (or whatever your instance's workflow defines). Pass `parent_id` to attach " +
      "to an existing hierarchy. **Disable this tool to make the agent read-only.**",
    schema: z.object({
      type: z.string().describe("Work item type"),
      title: z.string().describe("Item title"),
      description: z.string().optional(),
      parent_id: z.string().optional().describe("Attach under this parent item"),
      program_id: z.string().optional(),
      team_id: z.string().optional(),
      owner: z.string().optional().describe("Owner email or username"),
    }),
  },
);

export const jiraAlignUpdateItemTool = tool(
  async ({ item_id, fields }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!fields || Object.keys(fields).length === 0) {
      return JSON.stringify({ error: "fields object must contain at least one field to update" });
    }
    const data = await jaFetch(auth, `/rest/align/api/2/items/${encodeURIComponent(item_id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      id: item_id,
      url: `${auth.url}/Item/${item_id}`,
      updated_fields: Object.keys(fields),
    });
  },
  {
    name: "jira_align_update_item",
    description:
      "Patch fields on a Jira Align item (title, description, owner, programId, teamId, " +
      "parentId, custom fields, …). Only the listed fields are touched. **Disable this " +
      "tool to make the agent read-only.**",
    schema: z.object({
      item_id: z.string(),
      fields: z.record(z.string(), z.unknown()).describe(
        "Map of field name → new value. Use the camelCase JA REST field names.",
      ),
    }),
  },
);

export const jiraAlignTransitionItemTool = tool(
  async ({ item_id, state }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!state) {
      // List available states for the item type if the agent didn't pass one.
      const item = await jaFetch(auth, `/rest/align/api/2/items/${encodeURIComponent(item_id)}`) as { type?: string; error?: string };
      if (item && typeof item === "object" && "error" in item) return JSON.stringify(item);
      const wf = await jaFetch(auth, `/rest/align/api/2/workflows?itemType=${encodeURIComponent(item.type ?? "")}`) as { states?: Array<{ name: string }>; error?: string };
      if (wf && typeof wf === "object" && "error" in wf) return JSON.stringify(wf);
      return JSON.stringify({
        item_id,
        item_type: item.type,
        available_states: (wf.states ?? []).map((s) => s.name),
      });
    }
    const data = await jaFetch(auth, `/rest/align/api/2/items/${encodeURIComponent(item_id)}`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, id: item_id, state });
  },
  {
    name: "jira_align_transition_item",
    description:
      "Move a Jira Align work item to a new workflow state (e.g. 'In Progress' → 'Done'). " +
      "Call without `state` to list valid transitions for the item's type.",
    schema: z.object({
      item_id: z.string(),
      state: z.string().optional().describe("Target state name. Omit to list available states."),
    }),
  },
);

export const jiraAlignDeleteItemTool = tool(
  async ({ item_id, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Refuse without explicit confirm — the agent has to opt in per call,
    // not just because the tool is enabled. Mirrors the pattern in
    // exec.ts where destructive shell calls are gated by an extra arg.
    if (confirm !== item_id) {
      return JSON.stringify({
        error:
          `Refusing to delete item ${item_id}: pass \`confirm\` set to the same id to proceed. ` +
          `Deletes are not undoable in Jira Align — verify with the user first.`,
      });
    }
    const data = await jaFetch(auth, `/rest/align/api/2/items/${encodeURIComponent(item_id)}`, {
      method: "DELETE",
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_id: item_id });
  },
  {
    name: "jira_align_delete_item",
    description:
      "Permanently delete a Jira Align work item. **Irreversible.** The agent must pass " +
      "`confirm` set to the same `item_id` — a deliberate two-arg gate so a mis-issued " +
      "tool call can't wipe an item. **Leave this tool disabled unless the user explicitly " +
      "wants delete capability.**",
    schema: z.object({
      item_id: z.string(),
      confirm: z.string().describe("Must equal `item_id` for the delete to proceed."),
    }),
  },
);

// ── Comments / discussion (read-write but lower blast-radius than item edits) ──

export const jiraAlignAddCommentTool = tool(
  async ({ item_id, body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await jaFetch(auth, `/rest/align/api/2/items/${encodeURIComponent(item_id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, comment_id: data.id });
  },
  {
    name: "jira_align_add_comment",
    description: "Post a comment on a Jira Align work item. Plain text body.",
    schema: z.object({
      item_id: z.string(),
      body: z.string().describe("Comment text"),
    }),
  },
);
