// Jira agile tools — boards, sprints, backlog, rank. Lives at
// /rest/agile/1.0/... (not /rest/api/3/), but uses the same atlassianFetch
// wrapper since the auth + hostname are identical. Split out of the
// monolithic lib/tools/atlassian.ts in the bloat-audit refactor.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveAuth, atlassianFetch } from "./_auth";

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
