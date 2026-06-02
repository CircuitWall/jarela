// Jira project metadata — projects, versions, components, generic enums.
// Split out of the monolithic lib/tools/atlassian.ts in the bloat-audit
// refactor.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveAuth, atlassianFetch } from "./_auth";

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
