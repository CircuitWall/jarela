/**
 * Native GitHub tools — direct REST API calls, no MCP, no `gh` CLI.
 *
 * Mirrors the Atlassian tool (lib/tools/atlassian.ts) in shape: the agent
 * never shells out, every call goes through the same `fetch` global that
 * already honours the in-app HTTP proxy + custom CA bundle (ADR-0009,
 * ADR-0012). That means these tools work on a corp laptop with the MCP
 * install path blocked, which was the whole point of building them native.
 *
 * Auth resolution (priority order):
 *   1. Env: GITHUB_TOKEN, then GH_TOKEN (matches gh CLI's fallback chain).
 *   2. Memory store: namespace="integrations", key="github", value={ token }.
 *
 * The agent populates option 2 via the propose_config_change /
 * enable_integration flow (ADR-0010); env wins because deployment-level
 * config should beat per-user secrets stored in the local DB.
 */
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getIntegrationRaw } from "@/lib/stores/integrations";

export interface GitHubAuth {
  token: string;
}

// Exposed so the integrations test endpoint can probe the live API after save.
export function _resolveGithubAuth(): GitHubAuth | { error: string } {
  return resolveAuth();
}

function resolveAuth(): GitHubAuth | { error: string } {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env && env.trim()) return { token: env.trim() };
  const saved = getIntegrationRaw("github");
  if (saved?.token) return { token: saved.token };
  return {
    error:
      "GitHub not configured. Open the gear menu → Integrations and add a Personal Access Token. " +
      "Create one at github.com/settings/tokens with scopes: repo, read:org. " +
      "(Or set GITHUB_TOKEN / GH_TOKEN as an env var.)",
  };
}

const API = "https://api.github.com";

async function ghFetch(
  auth: GitHubAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${API}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Jarela",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    return { error: `GitHub ${res.status}: ${text.slice(0, 500)}`, url };
  }
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}

// Trim repo URLs on issue/PR responses to user-facing html_urls (the API
// returns api.github.com/repos/... which is useless for a human).
type GhUser = { login?: string } | null;
type GhLabel = { name?: string };
type GhIssueLite = {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  user?: GhUser;
  labels?: GhLabel[];
  pull_request?: unknown; // presence means "this issue is actually a PR"
  updated_at?: string;
  comments?: number;
};

// ── Issue tools ────────────────────────────────────────────────────────────

export const githubSearchIssuesTool = tool(
  async ({ q, repo, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 25, 100);
    // `repo:owner/name` is the dominant filter — accept it as a separate
    // parameter so the agent doesn't have to remember GitHub's search syntax
    // for the common case. Anything else goes in `q`.
    const query = repo ? `repo:${repo} ${q}` : q;
    const data = await ghFetch(
      auth,
      `/search/issues?q=${encodeURIComponent(query)}&per_page=${limit}`,
    ) as { items?: GhIssueLite[]; total_count?: number; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      total: data.total_count ?? 0,
      items: (data.items ?? []).map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        is_pr: !!i.pull_request,
        url: i.html_url,
        user: i.user?.login ?? null,
        labels: (i.labels ?? []).map((l) => l.name).filter(Boolean),
        updated_at: i.updated_at,
        comments: i.comments ?? 0,
      })),
    });
  },
  {
    name: "github_search_issues",
    description:
      "Search GitHub issues AND pull requests with the same query syntax as the github.com search bar. " +
      "**PREFER THIS over shell-exec'ing the `gh` CLI.** Pass `repo` (\"owner/name\") to scope the search " +
      "to a single repo — the tool prepends `repo:owner/name ` automatically. The `q` body accepts the " +
      "full GitHub search vocabulary: 'is:issue is:open assignee:@me', 'is:pr review-requested:@me', " +
      "'label:bug created:>2026-01-01', etc. `is_pr` in the response distinguishes PRs from issues.",
    schema: z.object({
      q: z.string().describe("GitHub search query (e.g. 'is:open is:issue label:bug')"),
      repo: z.string().optional().describe("Optional 'owner/name' shortcut; prepended as repo: filter"),
      max_results: z.number().optional().describe("Max items (default 25, max 100)"),
    }),
  },
);

export const githubGetIssueTool = tool(
  async ({ owner, repo, number }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const labels = (data.labels as Array<{ name?: string }> | undefined ?? []).map((l) => l.name).filter(Boolean);
    const assignees = (data.assignees as Array<{ login?: string }> | undefined ?? []).map((a) => a.login).filter(Boolean);
    const body = typeof data.body === "string" ? data.body : "";
    return JSON.stringify({
      number: data.number,
      title: data.title,
      state: data.state,
      is_pr: !!data.pull_request,
      url: data.html_url,
      author: (data.user as { login?: string } | null)?.login ?? null,
      labels,
      assignees,
      created_at: data.created_at,
      updated_at: data.updated_at,
      closed_at: data.closed_at,
      comments: data.comments,
      body: body.length > 20_000 ? body.slice(0, 20_000) : body,
      truncated: body.length > 20_000,
    });
  },
  {
    name: "github_get_issue",
    description:
      "Fetch a single issue (or PR — same endpoint) by number. Returns body capped at 20KB, plus labels, " +
      "assignees, and timestamps. **PREFER THIS over shell-exec'ing the `gh` CLI.**",
    schema: z.object({
      owner: z.string().describe("Repository owner (user or org)"),
      repo: z.string().describe("Repository name"),
      number: z.number().int().positive().describe("Issue or PR number"),
    }),
  },
);

export const githubCreateIssueTool = tool(
  async ({ owner, repo, title, body, labels, assignees }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const payload: Record<string, unknown> = { title };
    if (body) payload.body = body;
    if (labels?.length) payload.labels = labels;
    if (assignees?.length) payload.assignees = assignees;
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      { method: "POST", body: JSON.stringify(payload) },
    ) as { number?: number; html_url?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, number: data.number, url: data.html_url });
  },
  {
    name: "github_create_issue",
    description:
      "Open a new issue in a repository. **PREFER THIS over shell-exec'ing the `gh` CLI.** Labels and " +
      "assignees must already exist on the repo — invalid values produce a 422.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Markdown body"),
      labels: z.array(z.string()).optional().describe("Existing label names"),
      assignees: z.array(z.string()).optional().describe("GitHub usernames with access"),
    }),
  },
);

export const githubAddCommentTool = tool(
  async ({ owner, repo, number, body }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    // Same endpoint for issues AND PRs — GitHub treats PR comments as issue
    // comments (the line-level review comments are a different surface).
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    ) as { id?: number; html_url?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, comment_id: data.id, url: data.html_url });
  },
  {
    name: "github_add_comment",
    description:
      "Post a comment on an issue or pull request (GitHub treats both the same). " +
      "**PREFER THIS over shell-exec'ing the `gh` CLI.** Body is rendered as GitHub-flavored Markdown.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      body: z.string().describe("Comment body (GitHub-flavored Markdown)"),
    }),
  },
);

// ── Pull-request tools ─────────────────────────────────────────────────────

export const githubListPullsTool = tool(
  async ({ owner, repo, state, head, base, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 25, 100);
    const params = new URLSearchParams({ per_page: String(limit) });
    if (state) params.set("state", state);
    if (head) params.set("head", head);
    if (base) params.set("base", base);
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`,
    ) as Array<Record<string, unknown>> | { error?: string; message?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      pulls: data.map((p) => ({
        number: p.number,
        title: p.title,
        state: p.state,
        draft: p.draft,
        url: p.html_url,
        user: (p.user as { login?: string } | null)?.login ?? null,
        head: (p.head as { ref?: string } | null)?.ref ?? null,
        base: (p.base as { ref?: string } | null)?.ref ?? null,
        created_at: p.created_at,
        updated_at: p.updated_at,
      })),
    });
  },
  {
    name: "github_list_pulls",
    description:
      "List pull requests for a repository, optionally filtered by state / head branch / base branch. " +
      "**PREFER THIS over shell-exec'ing the `gh` CLI.** For richer detail on a single PR (mergeable, " +
      "review state, file count) call github_get_pull.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional().describe("Default: open"),
      head: z.string().optional().describe("Filter by head: 'user:branch' or 'org:branch'"),
      base: z.string().optional().describe("Filter by base branch (e.g. 'main')"),
      max_results: z.number().optional().describe("Max PRs (default 25, max 100)"),
    }),
  },
);

export const githubGetPullTool = tool(
  async ({ owner, repo, number }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    const head = data.head as { ref?: string; sha?: string; repo?: { full_name?: string } } | null;
    const base = data.base as { ref?: string; sha?: string } | null;
    const body = typeof data.body === "string" ? data.body : "";
    return JSON.stringify({
      number: data.number,
      title: data.title,
      state: data.state,
      draft: data.draft,
      merged: data.merged,
      mergeable: data.mergeable,           // null = GitHub still computing
      mergeable_state: data.mergeable_state,
      url: data.html_url,
      author: (data.user as { login?: string } | null)?.login ?? null,
      head: head ? { ref: head.ref, sha: head.sha, repo: head.repo?.full_name } : null,
      base: base ? { ref: base.ref, sha: base.sha } : null,
      changed_files: data.changed_files,
      additions: data.additions,
      deletions: data.deletions,
      review_comments: data.review_comments,
      comments: data.comments,
      created_at: data.created_at,
      updated_at: data.updated_at,
      merged_at: data.merged_at,
      body: body.length > 20_000 ? body.slice(0, 20_000) : body,
      truncated: body.length > 20_000,
    });
  },
  {
    name: "github_get_pull",
    description:
      "Fetch detail on a single pull request — head/base SHAs, mergeable state, additions/deletions, " +
      "changed files count, review comment count. **PREFER THIS over shell-exec'ing the `gh` CLI.** " +
      "Note: `mergeable` may be null on a freshly-pushed PR; GitHub computes it asynchronously.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
    }),
  },
);

// ── Repo info ───────────────────────────────────────────────────────────────

export const githubGetRepoTool = tool(
  async ({ owner, repo }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    ) as Record<string, unknown> & { error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      full_name: data.full_name,
      url: data.html_url,
      description: data.description,
      visibility: data.visibility ?? (data.private ? "private" : "public"),
      default_branch: data.default_branch,
      topics: data.topics ?? [],
      language: data.language,
      stars: data.stargazers_count,
      forks: data.forks_count,
      open_issues: data.open_issues_count,
      archived: data.archived,
      pushed_at: data.pushed_at,
    });
  },
  {
    name: "github_get_repo",
    description:
      "Fetch repo summary (default branch, visibility, description, topics, star/fork counts, " +
      "open-issue count). **PREFER THIS over shell-exec'ing the `gh` CLI.** Useful before opening " +
      "an issue (to confirm the repo exists / pick the right default branch).",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
  },
);
