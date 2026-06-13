/**
 * Native Jira Align tools — direct REST API calls, no MCP.
 *
 * Jira Align is a separate Atlassian product from Jira/Confluence Cloud with
 * its own API surface, hostname, and auth model:
 *   - URL:  https://<instance>.jiraalign.com
 *   - Auth: Bearer token (NOT email + API token like Jira Cloud)
 *   - API:  /rest/align/api/2/<collection>   per-type collections, no /items
 *
 * IMPORTANT — v2 has no generic `/items` endpoint. Work items are split by
 * type, each at its own collection: /epics, /capabilities, /features,
 * /stories, /themes, /tasks, /defects. Every tool here therefore requires
 * a `type` argument so we can route to the right collection.
 *
 * Auth resolution defaults to env vars (JIRA_ALIGN_URL, JIRA_ALIGN_TOKEN).
 * Call `setAuthResolver()` to plug in a custom credential source (vault,
 * secrets manager, UI form, etc.) — the resolver is invoked lazily on every
 * tool call, so it's safe to import the tools before configuring auth.
 *
 * Field shapes still vary by instance (custom fields, workflow names,
 * type-specific attributes). Verify exact field names against your
 * instance's Swagger at `<instance>.jiraalign.com/rest/align/api/docs/`.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// JSON.parse with a typed fallback for transient HTML responses from proxies.
function parseJsonSafe<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export interface JiraAlignAuth {
  url: string;        // e.g. "https://acme.jiraalign.com"
  apiToken: string;
}

export type AuthResolver = () => JiraAlignAuth | { error: string };

let _resolver: AuthResolver = resolveJiraAlignAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void {
  _resolver = fn;
}

export function resolveJiraAlignAuthFromEnv(): JiraAlignAuth | { error: string } {
  const envUrl = process.env.JIRA_ALIGN_URL;
  const envToken = process.env.JIRA_ALIGN_TOKEN;
  if (envUrl && envToken) {
    return { url: stripTrailingSlash(envUrl), apiToken: envToken };
  }
  return {
    error:
      "Jira Align not configured. Set JIRA_ALIGN_URL / JIRA_ALIGN_TOKEN env vars, " +
      "or call setAuthResolver() with your own credential provider.",
  };
}

// Logical type → URL collection segment. JA pluralization isn't a regex —
// "capability" → "capabilities", "story" → "stories" — so map explicitly
// and reject unknown types up front rather than constructing dead URLs.
const TYPE_TO_COLLECTION: Record<string, string> = {
  epic: "epics",
  capability: "capabilities",
  feature: "features",
  story: "stories",
  theme: "themes",
  task: "tasks",
  defect: "defects",
  objective: "objectives",
};
const KNOWN_TYPES = Object.keys(TYPE_TO_COLLECTION) as ReadonlyArray<keyof typeof TYPE_TO_COLLECTION>;
const TYPE_ENUM = z.enum(KNOWN_TYPES as [string, ...string[]]);

function collectionFor(type: string): string | { error: string } {
  const seg = TYPE_TO_COLLECTION[type.toLowerCase()];
  if (!seg) {
    return {
      error: `unknown Jira Align work-item type "${type}". Expected one of: ${KNOWN_TYPES.join(", ")}.`,
    };
  }
  return seg;
}

export function _resolveJiraAlignAuth(): JiraAlignAuth | { error: string } {
  return resolveAuth();
}

function resolveAuth(): JiraAlignAuth | { error: string } {
  return _resolver();
}

function stripTrailingSlash(s: string): string { return s.replace(/\/+$/, ""); }

// Low-level escape hatch — callers that need to hit a Jira Align endpoint
// not yet wrapped as a tool can call this directly.
export async function jiraAlignFetch(
  auth: JiraAlignAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  return jaFetch(auth, path, init);
}

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

// Shape an item payload back into a stable, typeless summary so the agent
// gets the same fields regardless of which /<type>s endpoint we hit. Field
// casing varies across JA endpoints (parentId vs parentID etc.), so we
// fall back through the known variants.
function summarizeItem(
  type: string,
  data: Record<string, unknown>,
  baseUrl: string,
): Record<string, unknown> {
  return {
    id: data.id,
    type,
    url: `${baseUrl}/Item/${data.id}`,
    title: data.title ?? data.name ?? null,
    state: data.state ?? data.status ?? null,
    description: data.description ?? null,
    parent_id: data.parentId ?? data.parentID ?? null,
    program_id: data.programId ?? data.programID ?? null,
    team_id: data.teamId ?? data.teamID ?? null,
    release_id: data.releaseId ?? data.releaseID ?? null,
    sprint_id: data.sprintId ?? data.sprintID ?? null,
    owner: data.owner ?? data.ownerEmail ?? null,
    created_at: data.createDate ?? data.createdAt ?? null,
    updated_at: data.lastUpdated ?? data.updatedAt ?? null,
  };
}

// ── Read tools ──────────────────────────────────────────────────────────────

export const jiraAlignGetItemTool = tool(
  async ({ type, item_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);

    const data = await jaFetch(auth, `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}`) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify(summarizeItem(type, data, auth.url));
  },
  {
    name: "jira_align_get_item",
    description:
      "Fetch a Jira Align work item by id. **Must specify `type`** — Jira Align v2 has no " +
      "generic /items endpoint, so the type tells us which collection to hit (epic|capability|" +
      "feature|story|theme|task|defect|objective). Returns title, state, hierarchy refs " +
      "(parent/program/team/release/sprint), owner, and timestamps. Use jira_align_list_children " +
      "to walk the tree.",
    schema: z.object({
      type: TYPE_ENUM.describe("Work-item type — required to route to the right /<type>s collection"),
      item_id: z.string().describe("Numeric Jira Align item id (e.g. '12345')"),
    }),
  },
);

export const jiraAlignSearchItemsTool = tool(
  async ({ type, state, owner, program_id, team_id, updated_since, max_results, filter }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);

    const params = new URLSearchParams();
    // JA v2 uses OData-style $filter for predicates. Build a conjunction
    // from the structured args; let callers append via `filter` for things
    // we don't model (custom fields etc.).
    const clauses: string[] = [];
    if (state) clauses.push(`state eq '${escapeOData(state)}'`);
    if (owner) clauses.push(`owner eq '${escapeOData(owner)}'`);
    if (program_id) clauses.push(`programId eq ${Number.isFinite(Number(program_id)) ? program_id : `'${escapeOData(program_id)}'`}`);
    if (team_id) clauses.push(`teamId eq ${Number.isFinite(Number(team_id)) ? team_id : `'${escapeOData(team_id)}'`}`);
    if (updated_since) clauses.push(`lastUpdated ge ${normalizeDate(updated_since)}`);
    if (filter) clauses.push(`(${filter})`);
    if (clauses.length) params.set("$filter", clauses.join(" and "));
    params.set("limit", String(Math.min(max_results ?? 25, 100)));

    const data = await jaFetch(auth, `/rest/align/api/2/${collection}?${params.toString()}`) as { items?: Array<Record<string, unknown>>; nextPageToken?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      items: (data.items ?? []).map((i) => ({
        id: i.id,
        type,
        title: i.title ?? i.name ?? null,
        state: i.state ?? null,
        owner: i.owner ?? null,
        url: `${auth.url}/Item/${i.id}`,
      })),
      next_page_token: data.nextPageToken ?? null,
    });
  },
  {
    name: "jira_align_search_items",
    description:
      "Search Jira Align work items of a given type, with optional state/owner/program/team " +
      "filters. **`type` is required** — JA v2 has no cross-type item collection, so each " +
      "search hits one /<type>s endpoint. Use `filter` to pass an OData expression for fields " +
      "this tool doesn't model (e.g. custom fields). Returns a compact list (id, title, state, " +
      "owner). Pass updated_since='-7d' or an ISO date for recency.",
    schema: z.object({
      type: TYPE_ENUM.describe("Work-item type to search"),
      state: z.string().optional().describe("Workflow state name (e.g. 'In Progress', 'Done')"),
      owner: z.string().optional().describe("Owner email or username"),
      program_id: z.string().optional(),
      team_id: z.string().optional(),
      updated_since: z.string().optional().describe("ISO timestamp or relative (e.g. '-7d')"),
      filter: z.string().optional().describe("Raw OData $filter expression appended to the structured filters (advanced)"),
      max_results: z.number().optional().describe("Default 25, max 100"),
    }),
  },
);

export const jiraAlignListChildrenTool = tool(
  async ({ child_type, parent_id, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(child_type);
    if (typeof collection !== "string") return JSON.stringify(collection);

    // JA hierarchy is implicit: get children by querying the child collection
    // with $filter=parentId eq {id}. There is no /<type>/{id}/children sub-route.
    const params = new URLSearchParams();
    params.set("$filter", `parentId eq ${parent_id}`);
    params.set("limit", String(Math.min(max_results ?? 50, 100)));
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}?${params.toString()}`) as { items?: Array<Record<string, unknown>>; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      parent_id,
      child_type,
      items: (data.items ?? []).map((i) => ({
        id: i.id,
        type: child_type,
        title: i.title ?? i.name ?? null,
        state: i.state ?? null,
        url: `${auth.url}/Item/${i.id}`,
      })),
    });
  },
  {
    name: "jira_align_list_children",
    description:
      "List the direct children of a Jira Align work item. **Both `parent_id` and `child_type` " +
      "are required** — the API has no generic `/items/{id}/children` route, so we query the " +
      "child collection with a parentId filter. Use the standard hierarchy: theme → epic → " +
      "capability → feature → story (instances may differ; check your portfolio config). For " +
      "deeper trees, call this once per level.",
    schema: z.object({
      parent_id: z.string().describe("Numeric id of the parent item"),
      child_type: TYPE_ENUM.describe("Type of children to fetch — must match your hierarchy level"),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);

// ── Write tools ─────────────────────────────────────────────────────────────

export const jiraAlignCreateItemTool = tool(
  async ({ type, title, description, parent_id, program_id, team_id, owner }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);

    const body: Record<string, unknown> = { title };
    if (description) body.description = description;
    if (parent_id) body.parentId = parent_id;
    if (program_id) body.programId = program_id;
    if (team_id) body.teamId = team_id;
    if (owner) body.owner = owner;
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      id: data.id,
      type,
      url: data.id ? `${auth.url}/Item/${data.id}` : null,
    });
  },
  {
    name: "jira_align_create_item",
    description:
      "Create a Jira Align work item in a given type's collection. Set `type` to one of " +
      "epic|capability|feature|story|theme|task|defect|objective. Pass `parent_id` to attach " +
      "to an existing hierarchy. **Disable this tool to make the agent read-only.**",
    schema: z.object({
      type: TYPE_ENUM.describe("Work-item type — selects which /<type>s collection receives the POST"),
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
  async ({ type, item_id, fields }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    if (!fields || Object.keys(fields).length === 0) {
      return JSON.stringify({ error: "fields object must contain at least one field to update" });
    }
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      id: item_id,
      type,
      url: `${auth.url}/Item/${item_id}`,
      updated_fields: Object.keys(fields),
    });
  },
  {
    name: "jira_align_update_item",
    description:
      "Patch fields on a Jira Align item (title, description, owner, programId, teamId, " +
      "parentId, custom fields, …). Only the listed fields are touched. **`type` is required** " +
      "to route the PATCH to the correct /<type>s/{id} resource. **Disable this tool to make " +
      "the agent read-only.**",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      fields: z.record(z.string(), z.unknown()).describe(
        "Map of field name → new value. Use the camelCase JA REST field names.",
      ),
    }),
  },
);

export const jiraAlignTransitionItemTool = tool(
  async ({ type, item_id, state }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    if (!state) {
      // List available states for the item type if the agent didn't pass one.
      const wf = await jaFetch(auth, `/rest/align/api/2/workflows?itemType=${encodeURIComponent(type)}`) as { states?: Array<{ name: string }>; error?: string };
      if (wf && typeof wf === "object" && "error" in wf) return JSON.stringify(wf);
      return JSON.stringify({
        item_id,
        item_type: type,
        available_states: (wf.states ?? []).map((s) => s.name),
      });
    }
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}`, {
      method: "PATCH",
      body: JSON.stringify({ state }),
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, id: item_id, type, state });
  },
  {
    name: "jira_align_transition_item",
    description:
      "Move a Jira Align work item to a new workflow state (e.g. 'In Progress' → 'Done'). " +
      "Call without `state` to list valid transitions for the item's type. **`type` is required.**",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      state: z.string().optional().describe("Target state name. Omit to list available states."),
    }),
  },
);

export const jiraAlignDeleteItemTool = tool(
  async ({ type, item_id, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
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
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}`, {
      method: "DELETE",
    }) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_id: item_id, type });
  },
  {
    name: "jira_align_delete_item",
    description:
      "Permanently delete a Jira Align work item. **Irreversible.** **`type` is required** to " +
      "route to the correct collection. The agent must also pass `confirm` set to the same " +
      "`item_id` — a deliberate two-arg gate so a mis-issued tool call can't wipe an item. " +
      "**Leave this tool disabled unless the user explicitly wants delete capability.**",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      confirm: z.string().describe("Must equal `item_id` for the delete to proceed."),
    }),
  },
);

// ── Comments / discussion (read-write but lower blast-radius than item edits) ──

export const jiraAlignAddCommentTool = tool(
  async ({ type, item_id, body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, comment_id: data.id, type });
  },
  {
    name: "jira_align_add_comment",
    description:
      "Post a comment on a Jira Align work item. **`type` is required** to route to the " +
      "correct /<type>s/{id}/comments resource. Plain text body. Note: not all instances " +
      "expose comments as a sub-resource on every type — check your Swagger if this 404s.",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      body: z.string().describe("Comment text"),
    }),
  },
);

export const jiraAlignListCommentsTool = tool(
  async ({ type, item_id, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(max_results ?? 25, 100)));
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}/comments?${params.toString()}`,
    ) as { items?: Array<Record<string, unknown>>; nextPageToken?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      type, item_id,
      comments: (data.items ?? []).map((c) => ({
        id: c.id,
        body: c.body ?? c.text ?? null,
        author: c.author ?? c.createdBy ?? null,
        created_at: c.createDate ?? c.createdAt ?? null,
        updated_at: c.lastUpdated ?? c.updatedAt ?? null,
      })),
      next_page_token: data.nextPageToken ?? null,
    });
  },
  {
    name: "jira_align_list_comments",
    description:
      "List comments on a Jira Align work item. **`type` is required** to route to the correct " +
      "/<type>s/{id}/comments resource. Returns id, body, author, and timestamps. Call this to " +
      "discover a comment_id before jira_align_update_comment / jira_align_delete_comment.",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      max_results: z.number().optional().describe("Default 25, max 100"),
    }),
  },
);

export const jiraAlignUpdateCommentTool = tool(
  async ({ type, item_id, comment_id, body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}/comments/${encodeURIComponent(comment_id)}`,
      { method: "PATCH", body: JSON.stringify({ body }) },
    ) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, comment_id, type, item_id });
  },
  {
    name: "jira_align_update_comment",
    description:
      "Edit the body of an existing comment on a Jira Align work item. **`type` is required** to " +
      "route to /<type>s/{item_id}/comments/{comment_id}. Use jira_align_list_comments first to " +
      "find the comment_id. **Disable this tool to make the agent read-only.**",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      comment_id: z.string(),
      body: z.string().describe("Replacement comment text"),
    }),
  },
);

export const jiraAlignDeleteCommentTool = tool(
  async ({ type, item_id, comment_id, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = collectionFor(type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    if (confirm !== comment_id) {
      return JSON.stringify({
        error:
          `Refusing to delete comment ${comment_id}: pass \`confirm\` set to the same comment_id ` +
          `to proceed. Comment deletes are not undoable in Jira Align — verify with the user first.`,
      });
    }
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/${collection}/${encodeURIComponent(item_id)}/comments/${encodeURIComponent(comment_id)}`,
      { method: "DELETE" },
    ) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_comment_id: comment_id, type, item_id });
  },
  {
    name: "jira_align_delete_comment",
    description:
      "Permanently delete a comment from a Jira Align work item. **Irreversible.** **`type` is " +
      "required.** The agent must also pass `confirm` set to the same `comment_id` — a deliberate " +
      "two-arg gate so a mis-issued tool call can't wipe a comment. **Leave this tool disabled " +
      "unless the user explicitly wants delete capability.**",
    schema: z.object({
      type: TYPE_ENUM,
      item_id: z.string(),
      comment_id: z.string(),
      confirm: z.string().describe("Must equal `comment_id` for the delete to proceed."),
    }),
  },
);

// ── Hierarchy entities (read-only listing — ADR-0035) ──────────────────────
//
// Jira Align organizes work-items inside a hierarchy of programs, teams,
// releases, sprints (PIs), portfolios, and value streams. The work-item tools
// above return ids for those entities (programId, teamId, etc.) but until now
// the agent had no way to resolve those ids to names without a manual lookup.
// These two tools fill that gap. They mirror TYPE_TO_COLLECTION's discipline:
// reject unknown entity_type up front, route to the right /<collection>.

const ENTITY_TO_COLLECTION: Record<string, string> = {
  program: "programs",
  team: "teams",
  release: "releases",
  sprint: "sprints",
  portfolio: "portfolios",
  value_stream: "valueStreams",
};
const KNOWN_ENTITIES = Object.keys(ENTITY_TO_COLLECTION) as ReadonlyArray<keyof typeof ENTITY_TO_COLLECTION>;
const ENTITY_ENUM = z.enum(KNOWN_ENTITIES as [string, ...string[]]);

function entityCollectionFor(entity_type: string): string | { error: string } {
  const seg = ENTITY_TO_COLLECTION[entity_type.toLowerCase()];
  if (!seg) {
    return {
      error: `unknown Jira Align entity_type "${entity_type}". Expected one of: ${KNOWN_ENTITIES.join(", ")}.`,
    };
  }
  return seg;
}

function summarizeEntity(
  entity_type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: data.id,
    entity_type,
    name: data.name ?? data.title ?? null,
    description: data.description ?? null,
    state: data.state ?? data.status ?? null,
    parent_id: data.parentId ?? data.parentID ?? null,
    program_id: data.programId ?? data.programID ?? null,
    portfolio_id: data.portfolioId ?? data.portfolioID ?? null,
    start_date: data.startDate ?? null,
    end_date: data.endDate ?? null,
    active: data.isActive ?? data.active ?? null,
  };
}

export const jiraAlignListEntitiesTool = tool(
  async ({ entity_type, name_filter, max_results, filter }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = entityCollectionFor(entity_type);
    if (typeof collection !== "string") return JSON.stringify(collection);

    const params = new URLSearchParams();
    const clauses: string[] = [];
    if (name_filter) clauses.push(`contains(name, '${escapeOData(name_filter)}')`);
    if (filter) clauses.push(`(${filter})`);
    if (clauses.length) params.set("$filter", clauses.join(" and "));
    params.set("limit", String(Math.min(max_results ?? 50, 100)));

    const data = await jaFetch(auth, `/rest/align/api/2/${collection}?${params}`) as {
      items?: Array<Record<string, unknown>>;
      nextPageToken?: string;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      entity_type,
      items: (data.items ?? []).map((d) => summarizeEntity(entity_type, d)),
      next_page_token: data.nextPageToken ?? null,
    });
  },
  {
    name: "jira_align_list_entities",
    description:
      "List non-work-item Jira Align entities of a given type: programs, teams, releases, sprints (PIs), " +
      "portfolios, or value streams. Use to resolve human names → ids before passing to work-item tools, " +
      "or to enumerate available programs/teams when planning work. Filter by `name_filter` (contains-match) " +
      "or by raw OData `filter` for advanced cases.",
    schema: z.object({
      entity_type: ENTITY_ENUM,
      name_filter: z.string().optional().describe("Case-insensitive name fragment"),
      filter: z.string().optional().describe("Raw OData $filter expression (advanced)"),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);

export const jiraAlignGetEntityTool = tool(
  async ({ entity_type, entity_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = entityCollectionFor(entity_type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}/${encodeURIComponent(entity_id)}`) as
      Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify(summarizeEntity(entity_type, data));
  },
  {
    name: "jira_align_get_entity",
    description:
      "Fetch a single Jira Align hierarchy entity by id: program, team, release, sprint (PI), portfolio, " +
      "or value stream. Returns id, name, description, state, hierarchy refs, dates.",
    schema: z.object({
      entity_type: ENTITY_ENUM,
      entity_id: z.string(),
    }),
  },
);

// ── Dependencies (cross-item links) ─────────────────────────────────────────
//
// JA models cross-item dependencies as a separate /dependencies resource (not
// a sub-collection of items) — every dependency has its own id, a predecessor,
// a successor, and a type (FS / SS / FF / blocks / etc., instance-specific).
// These tools let the agent answer "what blocks X?" / "X must complete before
// Y" without falling back to manual lookups in the JA web UI.
//
// Endpoint shape varies across JA versions; the comment on jira_align_create_dependency
// flags this. If a 4xx surfaces, the user should consult their Swagger.

export const jiraAlignListDependenciesTool = tool(
  async ({ item_id, direction, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const params = new URLSearchParams();
    // direction='predecessor' → others are predecessors of this item (i.e.
    // this item is blocked by them). 'successor' → this item is the predecessor.
    // 'either' (default) → both inbound and outbound.
    let clause: string;
    if (direction === "predecessor") clause = `successorId eq ${item_id}`;
    else if (direction === "successor") clause = `predecessorId eq ${item_id}`;
    else clause = `(predecessorId eq ${item_id} or successorId eq ${item_id})`;
    params.set("$filter", clause);
    params.set("limit", String(Math.min(max_results ?? 50, 100)));
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/dependencies?${params.toString()}`,
    ) as { items?: Array<Record<string, unknown>>; nextPageToken?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      item_id,
      direction: direction ?? "either",
      dependencies: (data.items ?? []).map((d) => ({
        id: d.id,
        predecessor_id: d.predecessorId ?? d.predecessorID ?? null,
        successor_id: d.successorId ?? d.successorID ?? null,
        dependency_type: d.dependencyType ?? d.type ?? null,
        description: d.description ?? null,
        state: d.state ?? null,
      })),
      next_page_token: data.nextPageToken ?? null,
    });
  },
  {
    name: "jira_align_list_dependencies",
    description:
      "List Jira Align dependencies (links between work items) involving a given item. By default " +
      "returns both inbound and outbound; pass direction='predecessor' for items the given item " +
      "depends on (blockers), or direction='successor' for items that depend on the given item " +
      "(dependents). Returns id, predecessor_id, successor_id, dependency_type, state. Use this " +
      "to find a dependency_id before calling jira_align_delete_dependency.",
    schema: z.object({
      item_id: z.string().describe("Numeric Jira Align item id (any type)"),
      direction: z.enum(["predecessor", "successor", "either"]).optional().describe(
        "predecessor = blockers; successor = dependents; either = both. Default: either.",
      ),
      max_results: z.number().optional().describe("Default 50, max 100"),
    }),
  },
);

export const jiraAlignCreateDependencyTool = tool(
  async ({ predecessor_id, successor_id, dependency_type, description }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const body: Record<string, unknown> = {
      predecessorId: predecessor_id,
      successorId: successor_id,
    };
    if (dependency_type) body.dependencyType = dependency_type;
    if (description) body.description = description;
    const data = await jaFetch(auth, `/rest/align/api/2/dependencies`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as { id?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      dependency_id: data.id,
      predecessor_id,
      successor_id,
      dependency_type: dependency_type ?? null,
    });
  },
  {
    name: "jira_align_create_dependency",
    description:
      "Link two Jira Align work items as a dependency: the predecessor must complete before the " +
      "successor can. `dependency_type` defaults to the instance default (typically 'FS' / " +
      "finish-to-start) when omitted. Items can be of any type — JA dependencies cross the " +
      "epic/feature/story hierarchy. **Disable this tool to make the agent read-only.** Note: " +
      "dependency endpoint shape varies across JA versions — if this 4xx's, check your instance's Swagger.",
    schema: z.object({
      predecessor_id: z.string().describe("Item that must complete first"),
      successor_id: z.string().describe("Item that's blocked by the predecessor"),
      dependency_type: z.string().optional().describe(
        "e.g. 'FS' (finish-to-start), 'SS', 'FF', 'blocks'. Instance-specific.",
      ),
      description: z.string().optional(),
    }),
  },
);

export const jiraAlignDeleteDependencyTool = tool(
  async ({ dependency_id, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (confirm !== dependency_id) {
      return JSON.stringify({
        error:
          `Refusing to delete dependency ${dependency_id}: pass \`confirm\` set to the same id to ` +
          `proceed. Dependency deletes are not undoable — verify with the user first.`,
      });
    }
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/dependencies/${encodeURIComponent(dependency_id)}`,
      { method: "DELETE" },
    ) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_dependency_id: dependency_id });
  },
  {
    name: "jira_align_delete_dependency",
    description:
      "Permanently remove a Jira Align dependency link. **Irreversible.** Use " +
      "jira_align_list_dependencies first to find the dependency_id. The agent must pass " +
      "`confirm` equal to `dependency_id` — a two-arg gate against accidental deletes. " +
      "**Leave this tool disabled unless the user explicitly wants delete capability.**",
    schema: z.object({
      dependency_id: z.string(),
      confirm: z.string().describe("Must equal `dependency_id` for the delete to proceed."),
    }),
  },
);

// ── Hierarchy entity writes (create / update / delete) ─────────────────────
//
// Mirror the read-only entity tools above (jira_align_list_entities,
// jira_align_get_entity) so the agent can stand up a new program/team/sprint,
// rename one, or retire one. Reuses ENTITY_TO_COLLECTION + summarizeEntity to
// stay in lockstep with the read side.

export const jiraAlignCreateEntityTool = tool(
  async ({ entity_type, name, description, parent_id, program_id, portfolio_id, start_date, end_date }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = entityCollectionFor(entity_type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    const body: Record<string, unknown> = { name };
    if (description) body.description = description;
    if (parent_id) body.parentId = parent_id;
    if (program_id) body.programId = program_id;
    if (portfolio_id) body.portfolioId = portfolio_id;
    if (start_date) body.startDate = start_date;
    if (end_date) body.endDate = end_date;
    const data = await jaFetch(auth, `/rest/align/api/2/${collection}`, {
      method: "POST",
      body: JSON.stringify(body),
    }) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, ...summarizeEntity(entity_type, data) });
  },
  {
    name: "jira_align_create_entity",
    description:
      "Create a Jira Align hierarchy entity: program, team, release, sprint (PI), portfolio, or " +
      "value stream. Use to spin up a new program/team or schedule a new sprint. Optional dates " +
      "must be ISO-8601 (e.g. '2026-07-01'). **Disable this tool to make the agent read-only.**",
    schema: z.object({
      entity_type: ENTITY_ENUM,
      name: z.string(),
      description: z.string().optional(),
      parent_id: z.string().optional().describe(
        "Attach under this parent entity (portfolio→value-stream, program→team, etc.)",
      ),
      program_id: z.string().optional(),
      portfolio_id: z.string().optional(),
      start_date: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
      end_date: z.string().optional().describe("ISO date (YYYY-MM-DD)"),
    }),
  },
);

export const jiraAlignUpdateEntityTool = tool(
  async ({ entity_type, entity_id, fields }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = entityCollectionFor(entity_type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    if (!fields || Object.keys(fields).length === 0) {
      return JSON.stringify({ error: "fields object must contain at least one field to update" });
    }
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/${collection}/${encodeURIComponent(entity_id)}`,
      { method: "PATCH", body: JSON.stringify(fields) },
    ) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      id: entity_id,
      entity_type,
      updated_fields: Object.keys(fields),
    });
  },
  {
    name: "jira_align_update_entity",
    description:
      "Patch fields on a Jira Align hierarchy entity (program/team/release/sprint/portfolio/value " +
      "stream). Only the listed fields are touched. Use camelCase JA REST field names (name, " +
      "description, parentId, startDate, endDate, isActive, …). **Disable this tool to make the " +
      "agent read-only.**",
    schema: z.object({
      entity_type: ENTITY_ENUM,
      entity_id: z.string(),
      fields: z.record(z.string(), z.unknown()).describe(
        "Map of field name → new value. Use the camelCase JA REST field names.",
      ),
    }),
  },
);

export const jiraAlignDeleteEntityTool = tool(
  async ({ entity_type, entity_id, confirm }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const collection = entityCollectionFor(entity_type);
    if (typeof collection !== "string") return JSON.stringify(collection);
    if (confirm !== entity_id) {
      return JSON.stringify({
        error:
          `Refusing to delete ${entity_type} ${entity_id}: pass \`confirm\` set to the same id to ` +
          `proceed. Entity deletes can cascade in Jira Align (e.g. a program owns work items) — ` +
          `verify with the user first.`,
      });
    }
    const data = await jaFetch(
      auth,
      `/rest/align/api/2/${collection}/${encodeURIComponent(entity_id)}`,
      { method: "DELETE" },
    ) as { error?: string };
    if (data && typeof data === "object" && "error" in data) return JSON.stringify(data);
    return JSON.stringify({ ok: true, deleted_id: entity_id, entity_type });
  },
  {
    name: "jira_align_delete_entity",
    description:
      "Permanently delete a Jira Align hierarchy entity (program/team/release/sprint/portfolio/" +
      "value stream). **Irreversible** and may cascade — deleting a program can affect every " +
      "work item scoped to it. The agent must pass `confirm` equal to `entity_id` — a two-arg " +
      "gate against accidental deletes. **Leave this tool disabled unless the user explicitly " +
      "wants delete capability.**",
    schema: z.object({
      entity_type: ENTITY_ENUM,
      entity_id: z.string(),
      confirm: z.string().describe("Must equal `entity_id` for the delete to proceed."),
    }),
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

// JA's $filter accepts ISO-8601 date literals without quotes. Map a small set
// of relative shorthands so callers can pass "-7d" the same way they do for
// the Jira Cloud tool, without knowing OData.
function normalizeDate(input: string): string {
  const m = /^-(\d+)([dhm])$/.exec(input);
  if (!m) return input;  // assume caller passed an ISO string
  const n = Number(m[1]);
  const unitMs = m[2] === "d" ? 86_400_000 : m[2] === "h" ? 3_600_000 : 60_000;
  return new Date(Date.now() - n * unitMs).toISOString();
}

// OData string literals double single quotes for escaping. We don't get fancy
// — JA usernames and state names don't contain backslashes — but we do need
// to make sure a quote in the input doesn't break the filter.
function escapeOData(s: string): string {
  return s.replace(/'/g, "''");
}

// ── Capability arrays ─────────────────────────────────────────────────────
// Pre-grouped by capability so downstream registries (e.g. Jarela's tool
// policy system) can register them without re-listing every tool.

export const jiraAlignReadTools = [
  jiraAlignGetItemTool, jiraAlignSearchItemsTool, jiraAlignListChildrenTool,
  jiraAlignListEntitiesTool, jiraAlignGetEntityTool,
  jiraAlignListCommentsTool, jiraAlignListDependenciesTool,
] as const;

export const jiraAlignWriteTools = [
  jiraAlignCreateItemTool, jiraAlignUpdateItemTool,
  jiraAlignDeleteItemTool, jiraAlignAddCommentTool,
  jiraAlignUpdateCommentTool, jiraAlignDeleteCommentTool,
  jiraAlignCreateDependencyTool, jiraAlignDeleteDependencyTool,
  jiraAlignCreateEntityTool, jiraAlignUpdateEntityTool, jiraAlignDeleteEntityTool,
] as const;

export const jiraAlignExecuteTools = [jiraAlignTransitionItemTool] as const;

export const jiraAlignTools = [
  ...jiraAlignReadTools,
  ...jiraAlignWriteTools,
  ...jiraAlignExecuteTools,
] as const;
