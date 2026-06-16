/**
 * Native Microsoft To Do tools — direct REST calls to
 * `graph.microsoft.com/v1.0/me/todo`, no MCP and no Graph SDK.
 *
 * Auth resolution defaults to the OAuth2 refresh-token grant against the
 * Microsoft identity platform v2 endpoint. The default env-var resolver
 * accepts `MS_TODO_CLIENT_ID`, `MS_TODO_CLIENT_SECRET`,
 * `MS_TODO_REFRESH_TOKEN`, and an optional `MS_TODO_TENANT` (defaults to
 * `common`, which accepts both personal and M365 accounts). The required
 * delegated Graph scopes are `Tasks.ReadWrite` and `offline_access`.
 *
 * Call `setAuthResolver()` to plug in a custom credential source — most
 * useful for embedders (e.g. Jarela) that already manage the OAuth refresh
 * flow elsewhere and just want to hand the package a fresh access token.
 * The resolver may be sync or async and is invoked lazily on every tool
 * call, so it is safe to import the tools before configuring auth.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * The credential shape every Graph call ultimately needs. Resolvers may
 * either return a bare access token (Jarela embeds this way — it already
 * runs the refresh dance in `lib/integrations/microsoft-oauth.ts`) or a
 * full refresh-token bundle that the package will exchange for an access
 * token on demand.
 */
export type MicrosoftTodoAuth =
  | { access_token: string }
  | {
      client_id: string;
      client_secret: string;
      refresh_token: string;
      tenant?: string;
    };

export type AuthResolver = () =>
  | MicrosoftTodoAuth
  | { error: string }
  | Promise<MicrosoftTodoAuth | { error: string }>;

let _resolver: AuthResolver = resolveTodoAuthFromEnv;

export function setAuthResolver(fn: AuthResolver): void {
  _resolver = fn;
}

export function resolveTodoAuthFromEnv(): MicrosoftTodoAuth | { error: string } {
  const access = process.env.MS_TODO_ACCESS_TOKEN;
  if (access && access.trim()) return { access_token: access.trim() };
  const client_id = process.env.MS_TODO_CLIENT_ID;
  const client_secret = process.env.MS_TODO_CLIENT_SECRET;
  const refresh_token = process.env.MS_TODO_REFRESH_TOKEN;
  const tenant = process.env.MS_TODO_TENANT?.trim() || undefined;
  if (client_id && client_secret && refresh_token) {
    return { client_id, client_secret, refresh_token, tenant };
  }
  return {
    error:
      "Microsoft To Do not configured. Set MS_TODO_CLIENT_ID, " +
      "MS_TODO_CLIENT_SECRET, MS_TODO_REFRESH_TOKEN (and optionally " +
      "MS_TODO_TENANT), or set MS_TODO_ACCESS_TOKEN, or call " +
      "setAuthResolver() with your own credential provider.",
  };
}

// Exposed so external probe / test endpoints can verify the resolver works.
export async function _resolveTodoAuth(): Promise<MicrosoftTodoAuth | { error: string }> {
  return Promise.resolve(_resolver());
}

// ── Access-token cache for refresh-token resolvers ─────────────────────────

interface CachedAccessToken {
  token: string;
  expires_at: number;
}
const accessTokenCache = new Map<string, CachedAccessToken>();

const SCOPES = ["offline_access", "Tasks.ReadWrite"];

async function exchangeRefreshToken(
  creds: {
    client_id: string;
    client_secret: string;
    refresh_token: string;
    tenant?: string;
  },
): Promise<string | { error: string }> {
  const tenant = creds.tenant || "common";
  const key = `${tenant}:${creds.refresh_token.slice(0, 24)}`;
  const cached = accessTokenCache.get(key);
  if (cached && cached.expires_at > Date.now() + 60_000) return cached.token;

  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: "refresh_token",
    scope: SCOPES.join(" "),
  });
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      accessTokenCache.delete(key);
      return {
        error: `Microsoft OAuth refresh failed (${res.status}): ${text.slice(0, 300)}`,
      };
    }
    const parsed = JSON.parse(text) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!parsed.access_token) return { error: "OAuth response missing access_token" };
    const expires_at = Date.now() + (parsed.expires_in ?? 3000) * 1000;
    accessTokenCache.set(key, { token: parsed.access_token, expires_at });
    return parsed.access_token;
  } catch (err) {
    return { error: `Microsoft OAuth refresh threw: ${(err as Error).message}` };
  }
}

async function resolveAccessToken(): Promise<string | { error: string }> {
  const auth = await Promise.resolve(_resolver());
  if ("error" in auth) return { error: auth.error };
  if ("access_token" in auth) return auth.access_token;
  return exchangeRefreshToken(auth);
}

// ── Graph fetch helper ─────────────────────────────────────────────────────

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/**
 * Low-level escape hatch for Graph endpoints not yet wrapped as tools.
 * Returns parsed JSON on success, `{ ok: true }` on 204 No Content, or
 * `{ error: string, url?: string }` on a non-2xx response.
 */
export async function graphFetch(
  pathOrUrl: string,
  init?: RequestInit,
): Promise<unknown> {
  const token = await resolveAccessToken();
  if (typeof token !== "string") return token;
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "circuitwall-ms-todo-langchain",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return { ok: true };
    const text = await res.text();
    if (!res.ok) {
      return { error: `Graph ${res.status}: ${text.slice(0, 500)}`, url };
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    return { error: `Graph fetch threw: ${(err as Error).message}` };
  }
}

// ── Type shapes (minimal subset of Microsoft Graph todo resources) ─────────

interface GraphDateTimeTimeZone {
  dateTime?: string;
  timeZone?: string;
}

interface GraphItemBody {
  content?: string;
  contentType?: "text" | "html";
}

interface GraphTodoList {
  id?: string;
  displayName?: string;
  isOwner?: boolean;
  isShared?: boolean;
  wellknownListName?: string;
}

interface GraphTodoTask {
  id?: string;
  title?: string;
  status?: TaskStatus;
  importance?: TaskImportance;
  body?: GraphItemBody;
  bodyLastModifiedDateTime?: string;
  dueDateTime?: GraphDateTimeTimeZone | null;
  reminderDateTime?: GraphDateTimeTimeZone | null;
  startDateTime?: GraphDateTimeTimeZone | null;
  completedDateTime?: GraphDateTimeTimeZone | null;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  isReminderOn?: boolean;
  hasAttachments?: boolean;
  categories?: string[];
  linkedResources?: Array<{
    webUrl?: string;
    applicationName?: string;
    displayName?: string;
  }>;
}

interface GraphChecklistItem {
  id?: string;
  displayName?: string;
  isChecked?: boolean;
  createdDateTime?: string;
  checkedDateTime?: string | null;
}

type TaskStatus =
  | "notStarted"
  | "inProgress"
  | "completed"
  | "waitingOnOthers"
  | "deferred";
type TaskImportance = "low" | "normal" | "high";

function slimList(l: GraphTodoList): Record<string, unknown> {
  return {
    id: l.id,
    name: l.displayName ?? null,
    is_owner: l.isOwner === true,
    is_shared: l.isShared === true,
    // Wellknown values include "defaultList", "flaggedEmails", "unknownFutureValue".
    well_known: l.wellknownListName ?? null,
  };
}

function slimTask(t: GraphTodoTask): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title ?? null,
    status: t.status ?? null,
    importance: t.importance ?? null,
    body: t.body?.content ?? null,
    body_type: t.body?.contentType ?? null,
    due: t.dueDateTime?.dateTime ?? null,
    due_time_zone: t.dueDateTime?.timeZone ?? null,
    reminder: t.reminderDateTime?.dateTime ?? null,
    start: t.startDateTime?.dateTime ?? null,
    completed: t.completedDateTime?.dateTime ?? null,
    created: t.createdDateTime ?? null,
    last_modified: t.lastModifiedDateTime ?? null,
    is_reminder_on: t.isReminderOn === true,
    has_attachments: t.hasAttachments === true,
    categories: t.categories ?? [],
    linked_resources: (t.linkedResources ?? []).map((r) => ({
      web_url: r.webUrl ?? null,
      application: r.applicationName ?? null,
      name: r.displayName ?? null,
    })),
  };
}

function slimChecklistItem(c: GraphChecklistItem): Record<string, unknown> {
  return {
    id: c.id,
    name: c.displayName ?? null,
    is_checked: c.isChecked === true,
    created: c.createdDateTime ?? null,
    checked: c.checkedDateTime ?? null,
  };
}

// Build the Graph `dueDateTime` / `reminderDateTime` envelope. Graph wants a
// naive datetime string ("2026-06-17T15:00:00.000") and a separate timeZone;
// we accept RFC3339 plus an optional time_zone and split them apart.
function dateTimeEnvelope(iso: string, time_zone?: string): GraphDateTimeTimeZone {
  // Graph rejects "Z" suffix on dateTime — strip it and default the zone to UTC.
  let dateTime = iso;
  let tz = time_zone ?? "UTC";
  if (dateTime.endsWith("Z")) {
    dateTime = dateTime.slice(0, -1);
    if (!time_zone) tz = "UTC";
  }
  return { dateTime, timeZone: tz };
}

// ── Task-list tools ────────────────────────────────────────────────────────

export const msTodoListListsTool = tool(
  async () => {
    const data = (await graphFetch("/me/todo/lists?$top=100")) as {
      value?: GraphTodoList[];
      error?: string;
    };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      lists: (data.value ?? []).map(slimList),
    });
  },
  {
    name: "ms_todo_list_lists",
    description:
      "List the user's Microsoft To Do task lists. Returns id, name, ownership, " +
      "shared flag, and wellknownListName (e.g. 'defaultList' for the Tasks " +
      "inbox, 'flaggedEmails' for the auto-list of flagged Outlook mail). " +
      "Use the returned `id` with the other ms_todo_* tools as `list_id`. " +
      "Call this first when the user refers to a list by name.",
    schema: z.object({}),
  },
);

export const msTodoCreateListTool = tool(
  async ({ name }) => {
    const r = (await graphFetch("/me/todo/lists", {
      method: "POST",
      body: JSON.stringify({ displayName: name }),
    })) as GraphTodoList & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimList(r));
  },
  {
    name: "ms_todo_create_list",
    description:
      "Create a new Microsoft To Do task list. Returns the new list's id and " +
      "metadata. List names must be unique per user; reusing a name yields a 409.",
    schema: z.object({
      name: z.string().min(1).describe("Display name for the new list"),
    }),
  },
);

export const msTodoUpdateListTool = tool(
  async ({ list_id, name }) => {
    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}`,
      { method: "PATCH", body: JSON.stringify({ displayName: name }) },
    )) as GraphTodoList & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimList(r));
  },
  {
    name: "ms_todo_update_list",
    description:
      "Rename an existing Microsoft To Do task list. The default 'Tasks' list " +
      "(wellknownListName=defaultList) cannot be renamed and returns a 400.",
    schema: z.object({
      list_id: z.string().describe("List id from ms_todo_list_lists"),
      name: z.string().min(1).describe("New display name"),
    }),
  },
);

export const msTodoDeleteListTool = tool(
  async ({ list_id }) => {
    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}`,
      { method: "DELETE" },
    )) as { ok?: boolean; error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({ ok: true, id: list_id });
  },
  {
    name: "ms_todo_delete_list",
    description:
      "Permanently delete a Microsoft To Do task list and all its tasks. The " +
      "default list and well-known lists cannot be deleted. This action is " +
      "irreversible — confirm with the user before invoking.",
    schema: z.object({
      list_id: z.string().describe("List id to delete"),
    }),
  },
);

// ── Task tools ─────────────────────────────────────────────────────────────

export const msTodoListTasksTool = tool(
  async ({ list_id, status, importance, due_before, due_after, max_results }) => {
    const params = new URLSearchParams({
      $top: String(Math.min(Math.max(max_results ?? 50, 1), 100)),
      $orderby: "createdDateTime desc",
    });
    // Build a Graph $filter clause from the structured filters. Multiple
    // clauses are combined with `and`. Wrapping dueDateTime/dateTime in
    // single quotes is required by Graph's OData parser.
    const filters: string[] = [];
    if (status) filters.push(`status eq '${status}'`);
    if (importance) filters.push(`importance eq '${importance}'`);
    if (due_before) {
      filters.push(
        `dueDateTime/dateTime lt '${due_before.replace(/Z$/, "")}'`,
      );
    }
    if (due_after) {
      filters.push(
        `dueDateTime/dateTime ge '${due_after.replace(/Z$/, "")}'`,
      );
    }
    if (filters.length > 0) params.set("$filter", filters.join(" and "));

    const data = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks?${params.toString()}`,
    )) as { value?: GraphTodoTask[]; "@odata.nextLink"?: string; error?: string };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      tasks: (data.value ?? []).map(slimTask),
      next_link: data["@odata.nextLink"] ?? null,
    });
  },
  {
    name: "ms_todo_list_tasks",
    description:
      "List tasks in a Microsoft To Do list with optional filters. Defaults: " +
      "newest first, top 50, no filter. Filter by `status` (notStarted | " +
      "inProgress | completed | waitingOnOthers | deferred), `importance` (low " +
      "| normal | high), and/or a `due_before`/`due_after` window (RFC3339). " +
      "Call ms_todo_list_lists first to resolve the user's list name to an id.",
    schema: z.object({
      list_id: z.string().describe("List id from ms_todo_list_lists"),
      status: z
        .enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"])
        .optional()
        .describe("Filter by task status"),
      importance: z
        .enum(["low", "normal", "high"])
        .optional()
        .describe("Filter by importance"),
      due_before: z.string().optional().describe("RFC3339 upper bound on dueDateTime"),
      due_after: z.string().optional().describe("RFC3339 lower bound on dueDateTime"),
      max_results: z.number().int().optional().describe("Max tasks (default 50, max 100)"),
    }),
  },
);

export const msTodoGetTaskTool = tool(
  async ({ list_id, task_id }) => {
    const t = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
    )) as GraphTodoTask & { error?: string };
    if (t.error) return JSON.stringify({ error: t.error });
    return JSON.stringify(slimTask(t));
  },
  {
    name: "ms_todo_get_task",
    description:
      "Fetch one Microsoft To Do task by id. Returns the same slim shape as " +
      "ms_todo_list_tasks but with the full body field included.",
    schema: z.object({
      list_id: z.string().describe("List id containing the task"),
      task_id: z.string().describe("Task id (from ms_todo_list_tasks)"),
    }),
  },
);

const TASK_BODY_SCHEMA = z.object({
  list_id: z.string().describe("List id to create the task in"),
  title: z.string().min(1).describe("Task title"),
  body: z.string().optional().describe("Long-form notes (plain text)"),
  importance: z.enum(["low", "normal", "high"]).optional().describe("Importance (default 'normal')"),
  due_iso: z
    .string()
    .optional()
    .describe("Due datetime, RFC3339. Defaults to UTC unless `due_time_zone` is set"),
  due_time_zone: z
    .string()
    .optional()
    .describe("IANA timezone for due_iso (e.g. 'America/Los_Angeles')"),
  reminder_iso: z.string().optional().describe("Reminder datetime, RFC3339"),
  reminder_time_zone: z.string().optional().describe("IANA timezone for reminder_iso"),
  categories: z.array(z.string()).optional().describe("Outlook categories to tag the task with"),
});

export const msTodoCreateTaskTool = tool(
  async ({
    list_id, title, body, importance, due_iso, due_time_zone,
    reminder_iso, reminder_time_zone, categories,
  }) => {
    interface CreateBody {
      title: string;
      importance?: TaskImportance;
      body?: GraphItemBody;
      dueDateTime?: GraphDateTimeTimeZone;
      reminderDateTime?: GraphDateTimeTimeZone;
      isReminderOn?: boolean;
      categories?: string[];
    }
    const payload: CreateBody = { title };
    if (importance) payload.importance = importance;
    if (body) payload.body = { content: body, contentType: "text" };
    if (due_iso) payload.dueDateTime = dateTimeEnvelope(due_iso, due_time_zone);
    if (reminder_iso) {
      payload.reminderDateTime = dateTimeEnvelope(reminder_iso, reminder_time_zone);
      payload.isReminderOn = true;
    }
    if (categories?.length) payload.categories = categories;

    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks`,
      { method: "POST", body: JSON.stringify(payload) },
    )) as GraphTodoTask & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimTask(r));
  },
  {
    name: "ms_todo_create_task",
    description:
      "Create a new Microsoft To Do task. `due_iso` and `reminder_iso` are " +
      "RFC3339 strings interpreted in UTC unless paired with an IANA timezone. " +
      "Setting `reminder_iso` automatically turns on the reminder. Use " +
      "ms_todo_list_lists to find the target list_id; pass the default list's " +
      "id to put the task in the user's main 'Tasks' inbox.",
    schema: TASK_BODY_SCHEMA,
  },
);

export const msTodoUpdateTaskTool = tool(
  async ({
    list_id, task_id, title, body, status, importance, due_iso, due_time_zone,
    reminder_iso, reminder_time_zone, categories, clear_due, clear_reminder,
  }) => {
    const patch: Record<string, unknown> = {};
    if (title !== undefined) patch.title = title;
    if (body !== undefined) patch.body = { content: body, contentType: "text" };
    if (status !== undefined) patch.status = status;
    if (importance !== undefined) patch.importance = importance;
    if (due_iso !== undefined) patch.dueDateTime = dateTimeEnvelope(due_iso, due_time_zone);
    if (reminder_iso !== undefined) {
      patch.reminderDateTime = dateTimeEnvelope(reminder_iso, reminder_time_zone);
      patch.isReminderOn = true;
    }
    if (categories !== undefined) patch.categories = categories;
    // Graph clears a date by sending null (NOT an empty object).
    if (clear_due) patch.dueDateTime = null;
    if (clear_reminder) {
      patch.reminderDateTime = null;
      patch.isReminderOn = false;
    }
    if (Object.keys(patch).length === 0) {
      return JSON.stringify({ error: "Provide at least one field to update" });
    }

    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    )) as GraphTodoTask & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimTask(r));
  },
  {
    name: "ms_todo_update_task",
    description:
      "Patch a Microsoft To Do task. Only supplied fields are changed; omit " +
      "fields to leave them alone. Pass `clear_due: true` or `clear_reminder: " +
      "true` to remove a date that was previously set. Use ms_todo_complete_task " +
      "for the common 'mark done' case — it's a thin wrapper over this with " +
      "status='completed'.",
    schema: z.object({
      list_id: z.string(),
      task_id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z
        .enum(["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"])
        .optional(),
      importance: z.enum(["low", "normal", "high"]).optional(),
      due_iso: z.string().optional(),
      due_time_zone: z.string().optional(),
      reminder_iso: z.string().optional(),
      reminder_time_zone: z.string().optional(),
      categories: z.array(z.string()).optional(),
      clear_due: z.boolean().optional().describe("Remove the existing due date"),
      clear_reminder: z.boolean().optional().describe("Remove the existing reminder"),
    }),
  },
);

export const msTodoCompleteTaskTool = tool(
  async ({ list_id, task_id }) => {
    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
      { method: "PATCH", body: JSON.stringify({ status: "completed" }) },
    )) as GraphTodoTask & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimTask(r));
  },
  {
    name: "ms_todo_complete_task",
    description:
      "Mark a Microsoft To Do task as completed (status='completed'). Convenience " +
      "wrapper around ms_todo_update_task for the dominant 'tick it off' case. " +
      "Graph automatically populates completedDateTime.",
    schema: z.object({
      list_id: z.string().describe("List id containing the task"),
      task_id: z.string().describe("Task id to complete"),
    }),
  },
);

export const msTodoDeleteTaskTool = tool(
  async ({ list_id, task_id }) => {
    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}`,
      { method: "DELETE" },
    )) as { ok?: boolean; error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify({ ok: true, id: task_id });
  },
  {
    name: "ms_todo_delete_task",
    description:
      "Permanently delete a Microsoft To Do task. This action is irreversible — " +
      "confirm with the user before invoking. For 'mark as done' use " +
      "ms_todo_complete_task instead.",
    schema: z.object({
      list_id: z.string().describe("List id containing the task"),
      task_id: z.string().describe("Task id to delete"),
    }),
  },
);

// ── Checklist (sub-item) tools ─────────────────────────────────────────────

export const msTodoListChecklistItemsTool = tool(
  async ({ list_id, task_id }) => {
    const data = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems`,
    )) as { value?: GraphChecklistItem[]; error?: string };
    if ("error" in data && data.error) return JSON.stringify(data);
    return JSON.stringify({
      items: (data.value ?? []).map(slimChecklistItem),
    });
  },
  {
    name: "ms_todo_list_checklist_items",
    description:
      "List the checklist sub-items (steps) of a Microsoft To Do task. Each " +
      "item has its own id, display name, and is_checked flag. Useful for " +
      "breaking a complex task into ordered steps.",
    schema: z.object({
      list_id: z.string(),
      task_id: z.string(),
    }),
  },
);

export const msTodoAddChecklistItemTool = tool(
  async ({ list_id, task_id, name, is_checked }) => {
    const r = (await graphFetch(
      `/me/todo/lists/${encodeURIComponent(list_id)}/tasks/${encodeURIComponent(task_id)}/checklistItems`,
      {
        method: "POST",
        body: JSON.stringify({ displayName: name, isChecked: is_checked === true }),
      },
    )) as GraphChecklistItem & { error?: string };
    if (r.error) return JSON.stringify({ error: r.error });
    return JSON.stringify(slimChecklistItem(r));
  },
  {
    name: "ms_todo_add_checklist_item",
    description:
      "Append a checklist sub-item (step) to a Microsoft To Do task. Pass " +
      "`is_checked: true` to add an already-completed step (rare; usually omit).",
    schema: z.object({
      list_id: z.string(),
      task_id: z.string(),
      name: z.string().min(1).describe("Display name for the sub-item"),
      is_checked: z.boolean().optional().describe("Create as already-checked (default false)"),
    }),
  },
);

// ── Capability groups ──────────────────────────────────────────────────────

export const msTodoReadTools = [
  msTodoListListsTool,
  msTodoListTasksTool,
  msTodoGetTaskTool,
  msTodoListChecklistItemsTool,
] as const;

export const msTodoWriteTools = [
  msTodoCreateListTool,
  msTodoUpdateListTool,
  msTodoDeleteListTool,
  msTodoCreateTaskTool,
  msTodoUpdateTaskTool,
  msTodoCompleteTaskTool,
  msTodoDeleteTaskTool,
  msTodoAddChecklistItemTool,
] as const;

export const msTodoTools = [...msTodoReadTools, ...msTodoWriteTools] as const;
