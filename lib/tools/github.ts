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
import { parseJsonSafe } from "@/lib/utils/json";
import { isLikelyBinary } from "@/lib/documents/indexer";
import { registerTools } from "./registry";
import { httpStatusToErrorCode, parseRetryAfterMs, networkErrorCode, defaultHttpHint } from "./error-codes";

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
  try {
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
      // ADR-0049/0050 — stable error code so the agent can branch on
      // 401/403/429 without parsing the message text. GitHub's primary
      // rate-limit returns 403 with X-RateLimit-Remaining=0; the secondary
      // rate-limit and abuse detection return 429. We prefer the
      // GitHub-specific x-ratelimit-reset (epoch seconds) over Retry-After
      // when present.
      const code = githubStatusCode(res);
      const retryAfterMs = code === "http_429" ? githubRetryAfterMs(res) : undefined;
      // GitHub-specific override on 403: the secondary rate-limit returns 403
      // with `X-RateLimit-Remaining: 0` rather than 429, and the recovery path
      // is "wait, retry once" — same as 429. Treat the hint that way too.
      const hint = code === "http_429"
        ? "GitHub rate-limited this request. If retry_after_ms is set, wait that long; if not, GitHub's primary limit (5000/hr) resets at the next hour boundary."
        : defaultHttpHint("GitHub", code);
      return {
        error: `GitHub ${res.status}: ${text.slice(0, 500)}`,
        code,
        status: res.status,
        url,
        ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
        ...(hint ? { hint } : {}),
      };
    }
    if (!text) return {};
    return parseJsonSafe<unknown>(text, text);
  } catch (err) {
    const code = networkErrorCode(err) ?? ((err as { name?: string }).name === "AbortError" ? "tool_timeout" : "fetch_error");
    const hint = code === "network_error"
      ? "Network failure reaching api.github.com. Retry once; if it keeps failing, check the corporate proxy / VPN."
      : code === "tool_timeout"
        ? "The GitHub API didn't respond within the per-tool deadline. Narrow the request (smaller per_page, scoped repo:owner/name search) or try again."
        : undefined;
    return {
      error: `GitHub fetch threw: ${err instanceof Error ? err.message : String(err)}`,
      code,
      url,
      ...(hint ? { hint } : {}),
    };
  }
}

function githubStatusCode(res: Response): string {
  // Primary rate-limit: 403 + X-RateLimit-Remaining: 0. Treat as http_429
  // so the playbook's retry-once-with-backoff branch fires.
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    return "http_429";
  }
  return httpStatusToErrorCode(res.status);
}

function githubRetryAfterMs(res: Response): number | undefined {
  const ra = parseRetryAfterMs(res.headers.get("retry-after"));
  if (ra !== undefined) return ra;
  const reset = res.headers.get("x-ratelimit-reset");
  if (!reset) return undefined;
  const epochSec = Number(reset);
  if (!Number.isFinite(epochSec)) return undefined;
  const delta = epochSec * 1000 - Date.now();
  return delta > 0 ? delta : 0;
}

// Exposed for sibling modules that need the same auth/proxy/CA-bundle
// behaviour without duplicating the wrapper (currently:
// `lib/documents/remote/github.ts`, ADR-0029). Mirrors `_atlassianFetch`.
export async function _ghFetch(
  auth: GitHubAuth,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  return ghFetch(auth, path, init);
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const BODY_CAP = 20_000;
const COMMENT_CAP = 8_000;
const PATCH_CAP = 8_000;
const SNIPPET_CAP = 400;

// Pure-fn body cap. Returns the same `body` field shape as the existing
// inline ternaries in github_get_issue / github_get_pull (str + truncated
// flag) so the agent doesn't need to handle two shapes.
export function truncate(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

// `/repos/.../contents/{path}` returns a base64-encoded blob; the API also
// returns the same response shape for directories (as an array). Decode +
// detect binary so the agent gets useful output for text and a clear
// not-text signal for everything else.
export interface DecodedBlob {
  binary: boolean;
  text?: string;
  size_bytes: number;
}
export function decodeContentsBlob(content: string, encoding: string | undefined): DecodedBlob {
  if (!content) return { binary: false, text: "", size_bytes: 0 };
  const b64 = encoding === "base64" ? content.replace(/\s+/g, "") : "";
  const buf = b64 ? Buffer.from(b64, "base64") : Buffer.from(content, "utf8");
  if (isLikelyBinary(buf)) return { binary: true, size_bytes: buf.length };
  return { binary: false, text: buf.toString("utf8"), size_bytes: buf.length };
}

// Trim repo URLs on issue/PR responses to user-facing html_urls (the API
// returns api.github.com/repos/... which is useless for a human).
type GhUser = { login?: string } | null;
type GhLabel = { name?: string };

function liteUser(u: unknown): string | null {
  return (u as GhUser)?.login ?? null;
}
function liteLabels(labels: unknown): string[] {
  return (labels as GhLabel[] | undefined ?? []).map((l) => l.name).filter(Boolean) as string[];
}

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
        user: liteUser(i.user),
        labels: liteLabels(i.labels),
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
    const assignees = (data.assignees as Array<{ login?: string }> | undefined ?? [])
      .map((a) => a.login).filter(Boolean);
    const cap = truncate(typeof data.body === "string" ? data.body : "", BODY_CAP);
    return JSON.stringify({
      number: data.number,
      title: data.title,
      state: data.state,
      is_pr: !!data.pull_request,
      url: data.html_url,
      author: liteUser(data.user),
      labels: liteLabels(data.labels),
      assignees,
      created_at: data.created_at,
      updated_at: data.updated_at,
      closed_at: data.closed_at,
      comments: data.comments,
      body: cap.text,
      truncated: cap.truncated,
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
        user: liteUser(p.user),
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
    const cap = truncate(typeof data.body === "string" ? data.body : "", BODY_CAP);
    return JSON.stringify({
      number: data.number,
      title: data.title,
      state: data.state,
      draft: data.draft,
      merged: data.merged,
      mergeable: data.mergeable,           // null = GitHub still computing
      mergeable_state: data.mergeable_state,
      url: data.html_url,
      author: liteUser(data.user),
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
      body: cap.text,
      truncated: cap.truncated,
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

// ── Issue write / read (cont'd) ────────────────────────────────────────────

export const githubUpdateIssueTool = tool(
  async ({ owner, repo, number, title, body, state, state_reason, labels, assignees }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (state_reason !== undefined) payload.state_reason = state_reason;
    if (labels !== undefined) payload.labels = labels;
    if (assignees !== undefined) payload.assignees = assignees;
    if (Object.keys(payload).length === 0) {
      return JSON.stringify({ error: "no fields to update — pass at least one of title/body/state/labels/assignees" });
    }
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    ) as { number?: number; html_url?: string; state?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      number: data.number,
      state: data.state,
      url: data.html_url,
      updated_fields: Object.keys(payload),
    });
  },
  {
    name: "github_update_issue",
    description:
      "Edit an issue or PR (same endpoint): change title, body, labels, assignees, or close/reopen via " +
      "`state`. **PREFER THIS over shell-exec'ing the `gh` CLI.** Pass `state: \"closed\"` with " +
      "`state_reason: \"completed\"` for done-as-intended, or `\"not_planned\"` for won't-fix.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      title: z.string().optional(),
      body: z.string().optional().describe("New issue body (Markdown). Replaces, doesn't append."),
      state: z.enum(["open", "closed"]).optional(),
      state_reason: z.enum(["completed", "not_planned", "reopened"]).optional(),
      labels: z.array(z.string()).optional().describe("Replaces the label set entirely."),
      assignees: z.array(z.string()).optional().describe("Replaces the assignee set entirely."),
    }),
  },
);

export const githubListIssueCommentsTool = tool(
  async ({ owner, repo, number, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 25, 100);
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments?per_page=${limit}`,
    ) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      comments: data.map((c) => {
        const cap = truncate(typeof c.body === "string" ? c.body : "", COMMENT_CAP);
        return {
          id: c.id,
          user: liteUser(c.user),
          created_at: c.created_at,
          updated_at: c.updated_at,
          url: c.html_url,
          body: cap.text,
          truncated: cap.truncated,
        };
      }),
    });
  },
  {
    name: "github_list_issue_comments",
    description:
      "List comments on an issue or PR. **PREFER THIS over shell-exec'ing the `gh` CLI.** Each comment " +
      "body is capped at 8 KB; `truncated: true` flags ones that hit the cap.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      max_results: z.number().optional().describe("Max comments (default 25, max 100)"),
    }),
  },
);

// ── Pull-request write ─────────────────────────────────────────────────────

export const githubCreatePullTool = tool(
  async ({ owner, repo, title, head, base, body, draft, maintainer_can_modify }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const payload: Record<string, unknown> = { title, head, base };
    if (body !== undefined) payload.body = body;
    if (draft !== undefined) payload.draft = draft;
    if (maintainer_can_modify !== undefined) payload.maintainer_can_modify = maintainer_can_modify;
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      { method: "POST", body: JSON.stringify(payload) },
    ) as { number?: number; html_url?: string; draft?: boolean; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, number: data.number, draft: data.draft, url: data.html_url });
  },
  {
    name: "github_create_pull",
    description:
      "Open a pull request. **PREFER THIS over shell-exec'ing the `gh` CLI.** `head` is the branch with " +
      "your changes (use `user:branch` for cross-fork PRs); `base` is the branch you want to merge into. " +
      "Returns 422 if the head/base pair has no diff or if the branches don't exist.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      head: z.string().describe("Source branch ('feature/x' for same-repo, 'user:branch' for fork PRs)"),
      base: z.string().describe("Target branch (typically 'main')"),
      body: z.string().optional().describe("PR description (Markdown)"),
      draft: z.boolean().optional().describe("Open as draft (default false)"),
      maintainer_can_modify: z.boolean().optional()
        .describe("Allow upstream maintainers to push to your fork branch (default true)"),
    }),
  },
);

export const githubUpdatePullTool = tool(
  async ({ owner, repo, number, title, body, state, base, maintainer_can_modify }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const payload: Record<string, unknown> = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (state !== undefined) payload.state = state;
    if (base !== undefined) payload.base = base;
    if (maintainer_can_modify !== undefined) payload.maintainer_can_modify = maintainer_can_modify;
    if (Object.keys(payload).length === 0) {
      return JSON.stringify({ error: "no fields to update — pass at least one of title/body/state/base" });
    }
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    ) as { number?: number; html_url?: string; state?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      number: data.number,
      state: data.state,
      url: data.html_url,
      updated_fields: Object.keys(payload),
    });
  },
  {
    name: "github_update_pull",
    description:
      "Edit a pull request: title, body, base branch, or close/reopen. **PREFER THIS over shell-exec'ing " +
      "the `gh` CLI.** To MERGE a PR use github_merge_pull — `state` here only opens / closes.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      title: z.string().optional(),
      body: z.string().optional(),
      state: z.enum(["open", "closed"]).optional()
        .describe("`closed` here means 'close without merging'. Use github_merge_pull to merge."),
      base: z.string().optional().describe("Re-target the PR at a different base branch."),
      maintainer_can_modify: z.boolean().optional(),
    }),
  },
);

export const githubMergePullTool = tool(
  async ({ owner, repo, number, method, commit_title, commit_message, sha }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const payload: Record<string, unknown> = {};
    if (commit_title !== undefined) payload.commit_title = commit_title;
    if (commit_message !== undefined) payload.commit_message = commit_message;
    if (method !== undefined) payload.merge_method = method;
    if (sha !== undefined) payload.sha = sha;
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`,
      { method: "PUT", body: JSON.stringify(payload) },
    ) as { merged?: boolean; sha?: string; message?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: !!data.merged,
      merged_sha: data.sha ?? null,
      message: data.message ?? null,
    });
  },
  {
    name: "github_merge_pull",
    description:
      "Merge a pull request. **PREFER THIS over shell-exec'ing the `gh` CLI.** `method` selects the " +
      "merge strategy (default `merge`); pass `sha` to refuse the merge if the PR head has been " +
      "force-pushed since you last looked. 405 means the PR isn't mergeable yet (still in CI / has " +
      "conflicts / needs review); 409 means the `sha` guard tripped.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      method: z.enum(["merge", "squash", "rebase"]).optional(),
      commit_title: z.string().optional()
        .describe("Title for the merge commit (or squash commit). Default: GitHub's auto-generated title."),
      commit_message: z.string().optional(),
      sha: z.string().optional()
        .describe("Refuse to merge unless the PR head still matches this SHA — guards against TOCTOU."),
    }),
  },
);

export const githubRequestReviewersTool = tool(
  async ({ owner, repo, number, reviewers, team_reviewers }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (!reviewers?.length && !team_reviewers?.length) {
      return JSON.stringify({ error: "pass at least one of reviewers or team_reviewers" });
    }
    const payload: Record<string, unknown> = {};
    if (reviewers?.length) payload.reviewers = reviewers;
    if (team_reviewers?.length) payload.team_reviewers = team_reviewers;
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/requested_reviewers`,
      { method: "POST", body: JSON.stringify(payload) },
    ) as {
      requested_reviewers?: Array<{ login?: string }>;
      requested_teams?: Array<{ slug?: string }>;
      html_url?: string;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      ok: true,
      requested_users: (data.requested_reviewers ?? []).map((u) => u.login).filter(Boolean),
      requested_teams: (data.requested_teams ?? []).map((t) => t.slug).filter(Boolean),
      url: data.html_url,
    });
  },
  {
    name: "github_request_reviewers",
    description:
      "Request review on a pull request from one or more users and/or teams. **PREFER THIS over " +
      "shell-exec'ing the `gh` CLI.** GitHub silently drops invalid usernames / team slugs — check the " +
      "returned `requested_users` / `requested_teams` to see who actually got a notification.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      reviewers: z.array(z.string()).optional().describe("GitHub usernames"),
      team_reviewers: z.array(z.string()).optional().describe("Team slugs (org-scoped)"),
    }),
  },
);

export const githubCreateReviewTool = tool(
  async ({ owner, repo, number, event, body, commit_id }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    if (event === "REQUEST_CHANGES" && !body?.trim()) {
      return JSON.stringify({ error: "REQUEST_CHANGES requires a non-empty body explaining what to change" });
    }
    const payload: Record<string, unknown> = { event };
    if (body !== undefined) payload.body = body;
    if (commit_id !== undefined) payload.commit_id = commit_id;
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
      { method: "POST", body: JSON.stringify(payload) },
    ) as { id?: number; state?: string; html_url?: string; error?: string };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({ ok: true, review_id: data.id, state: data.state, url: data.html_url });
  },
  {
    name: "github_create_review",
    description:
      "Submit a pull-request review (approve / request changes / leave a comment). **PREFER THIS over " +
      "shell-exec'ing the `gh` CLI.** `event=APPROVE` doesn't require a body. `event=REQUEST_CHANGES` " +
      "requires a body. Line-level inline review comments aren't supported by this tool yet — use the " +
      "GitHub UI for those.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
      body: z.string().optional().describe("Review summary (Markdown). Required for REQUEST_CHANGES."),
      commit_id: z.string().optional().describe("Pin the review to a specific commit SHA."),
    }),
  },
);

// ── Pull-request read (cont'd) ─────────────────────────────────────────────

export const githubListPullFilesTool = tool(
  async ({ owner, repo, number, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 30, 100);
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=${limit}`,
    ) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      files: data.map((f) => {
        const patch = typeof f.patch === "string" ? truncate(f.patch, PATCH_CAP) : null;
        return {
          filename: f.filename,
          status: f.status,                    // added | modified | removed | renamed | …
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          previous_filename: f.previous_filename,
          sha: f.sha,
          patch: patch?.text,
          patch_truncated: patch?.truncated ?? false,
        };
      }),
    });
  },
  {
    name: "github_list_pull_files",
    description:
      "List files changed in a pull request, with per-file additions/deletions and (capped) patch text. " +
      "**PREFER THIS over shell-exec'ing the `gh` CLI.** Each patch caps at 8 KB; `patch_truncated: true` " +
      "means the diff was longer than that. GitHub itself caps the response at 3000 files.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      max_results: z.number().optional().describe("Max files (default 30, max 100)"),
    }),
  },
);

export const githubListPullReviewsTool = tool(
  async ({ owner, repo, number, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 30, 100);
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews?per_page=${limit}`,
    ) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      reviews: data.map((r) => {
        const cap = truncate(typeof r.body === "string" ? r.body : "", COMMENT_CAP);
        return {
          id: r.id,
          user: liteUser(r.user),
          state: r.state,                     // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
          submitted_at: r.submitted_at,
          commit_id: r.commit_id,
          url: r.html_url,
          body: cap.text,
          truncated: cap.truncated,
        };
      }),
    });
  },
  {
    name: "github_list_pull_reviews",
    description:
      "List reviews submitted on a pull request (approvals, change-requests, comment-only). **PREFER THIS " +
      "over shell-exec'ing the `gh` CLI.** Use this to check whether a PR is approved before calling " +
      "github_merge_pull.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      number: z.number().int().positive(),
      max_results: z.number().optional().describe("Max reviews (default 30, max 100)"),
    }),
  },
);

// ── Repo content ───────────────────────────────────────────────────────────

export const githubListBranchesTool = tool(
  async ({ owner, repo, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 30, 100);
    const data = await ghFetch(
      auth,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=${limit}`,
    ) as Array<Record<string, unknown>> | { error?: string };
    if (!Array.isArray(data)) return JSON.stringify(data);
    return JSON.stringify({
      branches: data.map((b) => ({
        name: b.name,
        commit_sha: (b.commit as { sha?: string } | null)?.sha ?? null,
        protected: b.protected,
      })),
    });
  },
  {
    name: "github_list_branches",
    description:
      "List branches in a repository with their head SHAs and protection state. **PREFER THIS over " +
      "shell-exec'ing the `gh` CLI.** Useful before opening a PR (confirm the head branch exists " +
      "and is the SHA you expect).",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      max_results: z.number().optional().describe("Max branches (default 30, max 100)"),
    }),
  },
);

export const githubGetFileTool = tool(
  async ({ owner, repo, path, ref }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const url = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split("/").map(encodeURIComponent).join("/")}` + (ref ? `?ref=${encodeURIComponent(ref)}` : "");
    const data = await ghFetch(auth, url) as Record<string, unknown> | Array<unknown> | { error?: string };
    if (!Array.isArray(data) && (data as { error?: string }).error) {
      return JSON.stringify(data);
    }
    if (Array.isArray(data) || (data as { type?: string }).type === "dir") {
      return JSON.stringify({
        error: `'${path}' is a directory; this tool only reads single files. Pass a path to a file.`,
      });
    }
    const f = data as { type?: string; encoding?: string; content?: string; sha?: string;
                       size?: number; html_url?: string; path?: string };
    if (f.type !== "file") {
      return JSON.stringify({ error: `unsupported content type '${f.type ?? "?"}' at ${path}` });
    }
    const decoded = decodeContentsBlob(f.content ?? "", f.encoding);
    if (decoded.binary) {
      return JSON.stringify({
        path: f.path, sha: f.sha, url: f.html_url,
        binary: true, size_bytes: decoded.size_bytes,
      });
    }
    const cap = truncate(decoded.text ?? "", BODY_CAP);
    return JSON.stringify({
      path: f.path, sha: f.sha, url: f.html_url,
      binary: false, size_bytes: decoded.size_bytes,
      content: cap.text, truncated: cap.truncated,
    });
  },
  {
    name: "github_get_file",
    description:
      "Read a file's contents from a repo at an optional ref (branch / tag / commit SHA). **PREFER THIS " +
      "over shell-exec'ing the `gh` CLI.** Returns up to 20 KB of UTF-8 text; longer files are truncated " +
      "with `truncated: true`. Binary files return `binary: true` and `size_bytes` instead of `content`. " +
      "GitHub itself rejects files larger than ~1 MB on this endpoint.",
    schema: z.object({
      owner: z.string(),
      repo: z.string(),
      path: z.string().describe("Path within the repo (e.g. 'src/lib/index.ts'). Slashes preserved."),
      ref: z.string().optional().describe("Branch, tag, or commit SHA. Default: repo's default branch."),
    }),
  },
);

export const githubSearchCodeTool = tool(
  async ({ q, repo, max_results }) => {
    const auth = resolveAuth();
    if ("error" in auth) return JSON.stringify({ error: auth.error });
    const limit = Math.min(max_results ?? 25, 100);
    const query = repo ? `repo:${repo} ${q}` : q;
    const data = await ghFetch(
      auth,
      `/search/code?q=${encodeURIComponent(query)}&per_page=${limit}`,
      { headers: { Accept: "application/vnd.github.text-match+json" } },
    ) as {
      items?: Array<{
        name?: string; path?: string; sha?: string; html_url?: string;
        repository?: { full_name?: string };
        text_matches?: Array<{ fragment?: string }>;
      }>;
      total_count?: number;
      error?: string;
    };
    if (data.error) return JSON.stringify(data);
    return JSON.stringify({
      total: data.total_count ?? 0,
      items: (data.items ?? []).map((i) => {
        const fragment = i.text_matches?.[0]?.fragment ?? "";
        const snip = truncate(fragment, SNIPPET_CAP);
        return {
          name: i.name,
          path: i.path,
          repo: i.repository?.full_name,
          url: i.html_url,
          sha: i.sha,
          snippet: snip.text,
          snippet_truncated: snip.truncated,
        };
      }),
    });
  },
  {
    name: "github_search_code",
    description:
      "Search file contents across GitHub. **PREFER THIS over shell-exec'ing the `gh` CLI.** Pass `repo` " +
      "(\"owner/name\") to scope to one repo; the tool prepends `repo:owner/name `. The `q` body accepts " +
      "GitHub's full code-search syntax: 'language:ts symbolName', 'extension:py path:tests assert', etc. " +
      "Each hit returns a 400-char snippet around the match. Note: GitHub code search has stricter rate " +
      "limits than other endpoints (10/min for unauthenticated, 30/min for authenticated).",
    schema: z.object({
      q: z.string().describe("Code search query (e.g. 'language:ts isLikelyBinary')"),
      repo: z.string().optional().describe("Optional 'owner/name' shortcut; prepended as repo: filter"),
      max_results: z.number().optional().describe("Max items (default 25, max 100)"),
    }),
  },
);

registerTools("GitHub", "read", [
  // Issues — read
  githubSearchIssuesTool, githubGetIssueTool, githubListIssueCommentsTool,
  // Pull requests — read
  githubListPullsTool, githubGetPullTool,
  githubListPullFilesTool, githubListPullReviewsTool,
  // Repo content
  githubGetRepoTool, githubListBranchesTool, githubGetFileTool, githubSearchCodeTool,
]);
registerTools("GitHub", "execute", [
  // Issues — write/execute
  githubCreateIssueTool, githubUpdateIssueTool, githubAddCommentTool,
  // Pull requests — write/execute
  githubCreatePullTool, githubUpdatePullTool, githubMergePullTool,
  githubRequestReviewersTool, githubCreateReviewTool,
]);
