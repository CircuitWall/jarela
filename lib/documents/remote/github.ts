// GitHub remote indexer (ADR-0029).
//
// Source kinds handled:
//   - github_pulls → all PRs of one repo + their issue comments + review
//                    bodies, flattened to one document per PR.
//   - github_repo  → text files on one branch of one repo (default branch
//                    by default), walked via the Git Trees API. Filtered
//                    by the same extension allowlist + binary heuristic
//                    as the local-folder walker so the two surfaces stay
//                    in sync.
//
// On-demand helpers (called via lib/documents/remote/index.ts'
// indexOnDemand) cover one-shot indexing of a PR / issue / file URL
// under the shared `on_demand_url` source row.

import {
  _ghFetch,
  _resolveGithubAuth,
  type GitHubAuth,
} from "@/lib/tools/github";
import {
  parseSourceConfig,
  updateDocumentSourceCursor,
  type DocumentSourceRow,
} from "@/lib/stores/document-sources";
import { ALLOWED_EXT, isLikelyBinary, lowerExt } from "../indexer";
import { upsertRemoteDocument, type UpsertResult } from "./upsert";

const PR_PAGE_LIMIT = 50;
const MAX_PRS_PER_RUN = 200;
const MAX_FILES_PER_RUN = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // matches local indexer

interface GhUserLite { login?: string }
interface GhPull {
  number: number;
  title?: string;
  state?: string;
  body?: string;
  updated_at?: string;
  html_url?: string;
  user?: GhUserLite;
  draft?: boolean;
}
interface GhIssueComment {
  user?: GhUserLite;
  created_at?: string;
  body?: string;
}
interface GhReview {
  user?: GhUserLite;
  state?: string;
  submitted_at?: string;
  body?: string;
}
interface GhIssue {
  number: number;
  title?: string;
  body?: string;
  updated_at?: string;
  state?: string;
  html_url?: string;
  user?: GhUserLite;
}
interface GhTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
  sha?: string;
}
interface GhTreeResp {
  sha?: string;
  tree?: GhTreeEntry[];
  truncated?: boolean;
}
interface GhRepo {
  default_branch?: string;
}
interface GhContents {
  type?: "file" | "dir" | "symlink" | "submodule";
  encoding?: string;
  content?: string;
  size?: number;
  sha?: string;
}

function ghError(data: unknown): string | null {
  return (data as { error?: string })?.error ?? null;
}

function liteAuthor(u: GhUserLite | undefined): string {
  return u?.login ?? "unknown";
}

// One-document-per-PR text body. Mirrors the Jira flattener: title +
// URL on the first lines so retrieval results read sensibly even when
// only the leading chunk surfaces.
function flattenPull(
  pr: GhPull,
  comments: GhIssueComment[],
  reviews: GhReview[],
): string {
  const parts: string[] = [];
  parts.push(`PR #${pr.number}: ${pr.title ?? ""}`.trim());
  if (pr.html_url) parts.push(pr.html_url);
  parts.push(`State: ${pr.state ?? "unknown"}${pr.draft ? " (draft)" : ""} · author: ${liteAuthor(pr.user)}`);
  if (pr.body && pr.body.trim()) parts.push(pr.body.trim());
  for (const c of comments) {
    if (!c.body?.trim()) continue;
    const ts = c.created_at ? ` (${c.created_at.slice(0, 10)})` : "";
    parts.push(`Comment by ${liteAuthor(c.user)}${ts}:\n${c.body.trim()}`);
  }
  for (const r of reviews) {
    if (!r.body?.trim()) continue;
    const ts = r.submitted_at ? ` (${r.submitted_at.slice(0, 10)})` : "";
    parts.push(`Review by ${liteAuthor(r.user)} — ${r.state ?? ""}${ts}:\n${r.body.trim()}`);
  }
  return parts.join("\n\n");
}

function flattenIssue(issue: GhIssue, comments: GhIssueComment[]): string {
  const parts: string[] = [];
  parts.push(`Issue #${issue.number}: ${issue.title ?? ""}`.trim());
  if (issue.html_url) parts.push(issue.html_url);
  parts.push(`State: ${issue.state ?? "unknown"} · author: ${liteAuthor(issue.user)}`);
  if (issue.body && issue.body.trim()) parts.push(issue.body.trim());
  for (const c of comments) {
    if (!c.body?.trim()) continue;
    const ts = c.created_at ? ` (${c.created_at.slice(0, 10)})` : "";
    parts.push(`Comment by ${liteAuthor(c.user)}${ts}:\n${c.body.trim()}`);
  }
  return parts.join("\n\n");
}

async function listIssueComments(auth: GitHubAuth, owner: string, repo: string, n: number): Promise<GhIssueComment[]> {
  const data = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${n}/comments?per_page=100`,
  );
  return Array.isArray(data) ? (data as GhIssueComment[]) : [];
}

async function listReviews(auth: GitHubAuth, owner: string, repo: string, n: number): Promise<GhReview[]> {
  const data = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${n}/reviews?per_page=100`,
  );
  return Array.isArray(data) ? (data as GhReview[]) : [];
}

export interface GithubIndexStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
  cursor: string | null;
  embedFailed: number;
  embedError: string | null;
}

function emptyStats(cursor: string | null): GithubIndexStats {
  return { scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0, cursor, embedFailed: 0, embedError: null };
}

function applyUpsert(stats: GithubIndexStats, res: UpsertResult): void {
  if (res.status === "added") stats.added++;
  else if (res.status === "updated") stats.updated++;
  else stats.unchanged++;
  stats.embedFailed += res.chunks - res.embedded;
  if (res.embedError && !stats.embedError) stats.embedError = res.embedError;
}

// ── github_pulls ──────────────────────────────────────────────────────────

interface PullsConfig {
  owner?: string;
  repo?: string;
  recency_days?: number;
  state?: "open" | "closed" | "all";
}

async function runGithubPullsIndexer(source: DocumentSourceRow): Promise<GithubIndexStats> {
  const cfg = parseSourceConfig<PullsConfig>(source) ?? {};
  if (!cfg.owner || !cfg.repo) throw new Error("github_pulls requires config.owner and config.repo");
  const stats = emptyStats(source.last_cursor);
  const auth = _resolveGithubAuth();
  if ("error" in auth) throw new Error(auth.error);

  const cutoffMs = cfg.recency_days && cfg.recency_days > 0
    ? Date.now() - cfg.recency_days * 86_400_000
    : null;
  const sinceMs = source.last_cursor ? Date.parse(source.last_cursor) : NaN;
  const state = cfg.state ?? "all";
  let highWater = source.last_cursor;

  // Sorted by `updated desc` so we can stop early as soon as we drop
  // below the watermark or the recency cutoff.
  let page = 1;
  outer: while (stats.scanned < MAX_PRS_PER_RUN) {
    const data = await _ghFetch(
      auth,
      `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/pulls` +
        `?state=${state}&sort=updated&direction=desc&per_page=${PR_PAGE_LIMIT}&page=${page}`,
    );
    const err = ghError(data);
    if (err) throw new Error(err);
    const pulls = Array.isArray(data) ? (data as GhPull[]) : [];
    if (pulls.length === 0) break;

    for (const pr of pulls) {
      stats.scanned++;
      const updated = pr.updated_at ?? "";
      const updatedMs = Date.parse(updated);
      if (cutoffMs !== null && Number.isFinite(updatedMs) && updatedMs < cutoffMs) break outer;
      if (Number.isFinite(sinceMs) && Number.isFinite(updatedMs) && updatedMs <= sinceMs) break outer;

      try {
        const [comments, reviews] = await Promise.all([
          listIssueComments(auth, cfg.owner, cfg.repo, pr.number),
          listReviews(auth, cfg.owner, cfg.repo, pr.number),
        ]);
        const text = flattenPull(pr, comments, reviews);
        const res = await upsertRemoteDocument(source.id, {
          path: `github-pull://${cfg.owner}/${cfg.repo}/${pr.number}`,
          title: `PR #${pr.number}: ${pr.title ?? ""}`.trim(),
          externalUpdatedAt: updated || new Date().toISOString(),
          text,
        });
        applyUpsert(stats, res);
        if (updated && (!highWater || updated > highWater)) highWater = updated;
      } catch {
        stats.errors++;
      }
    }
    if (pulls.length < PR_PAGE_LIMIT) break;
    page++;
  }

  if (highWater && highWater !== source.last_cursor) {
    updateDocumentSourceCursor(source.id, highWater);
    stats.cursor = highWater;
  }
  return stats;
}

// ── github_repo ───────────────────────────────────────────────────────────

interface RepoConfig {
  owner?: string;
  repo?: string;
  ref?: string;
  path_prefix?: string;
}

async function resolveDefaultBranch(auth: GitHubAuth, owner: string, repo: string): Promise<string> {
  const data = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  ) as GhRepo & { error?: string };
  if (data.error) throw new Error(data.error);
  if (!data.default_branch) throw new Error(`could not resolve default branch for ${owner}/${repo}`);
  return data.default_branch;
}

async function runGithubRepoIndexer(source: DocumentSourceRow): Promise<GithubIndexStats> {
  const cfg = parseSourceConfig<RepoConfig>(source) ?? {};
  if (!cfg.owner || !cfg.repo) throw new Error("github_repo requires config.owner and config.repo");
  const stats = emptyStats(source.last_cursor);
  const auth = _resolveGithubAuth();
  if ("error" in auth) throw new Error(auth.error);

  const ref = cfg.ref ?? await resolveDefaultBranch(auth, cfg.owner, cfg.repo);
  const tree = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  ) as GhTreeResp & { error?: string };
  if (tree.error) throw new Error(tree.error);
  const treeSha = tree.sha ?? null;

  // Cheap no-op: if the branch head hasn't moved since last walk, skip
  // the whole thing. Saves a contents fetch per file on quiet repos.
  if (treeSha && source.last_cursor === treeSha) {
    stats.cursor = treeSha;
    return stats;
  }

  const prefix = (cfg.path_prefix ?? "").replace(/^\/+|\/+$/g, "");
  const blobs = (tree.tree ?? []).filter((e) => {
    if (e.type !== "blob") return false;
    if (typeof e.size === "number" && e.size > MAX_FILE_BYTES) return false;
    if (!ALLOWED_EXT.has(lowerExt(e.path))) return false;
    if (prefix && !(e.path === prefix || e.path.startsWith(prefix + "/"))) return false;
    return true;
  });

  for (const entry of blobs) {
    if (stats.scanned >= MAX_FILES_PER_RUN) break;
    stats.scanned++;
    try {
      const contents = await _ghFetch(
        auth,
        `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${entry.path
          .split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
      ) as GhContents & { error?: string };
      if (contents.error) { stats.errors++; continue; }
      if (contents.type !== "file" || !contents.content) continue;
      const buf = Buffer.from(contents.content.replace(/\s+/g, ""), contents.encoding === "base64" ? "base64" : "utf8");
      if (isLikelyBinary(buf)) continue;
      const text = buf.toString("utf8");
      const res = await upsertRemoteDocument(source.id, {
        path: `github-file://${cfg.owner}/${cfg.repo}@${ref}/${entry.path}`,
        title: entry.path,
        externalUpdatedAt: new Date().toISOString(), // tree SHA carries the cursor; per-file mtime would need a commits API call we'd rather skip
        text,
      });
      applyUpsert(stats, res);
    } catch {
      stats.errors++;
    }
  }

  if (treeSha && treeSha !== source.last_cursor) {
    updateDocumentSourceCursor(source.id, treeSha);
    stats.cursor = treeSha;
  }
  return stats;
}

// ── Dispatcher entry-point used by lib/documents/remote/index.ts ──────────

export async function runGithubIndexer(source: DocumentSourceRow): Promise<GithubIndexStats> {
  if (source.kind === "github_pulls") return runGithubPullsIndexer(source);
  if (source.kind === "github_repo")  return runGithubRepoIndexer(source);
  throw new Error(`runGithubIndexer called with unsupported kind: ${source.kind}`);
}

// ── On-demand helpers (called from indexOnDemand) ─────────────────────────

export async function indexGithubPullByUrl(
  sourceId: string,
  owner: string,
  repo: string,
  number: number,
): Promise<UpsertResult> {
  const auth = _resolveGithubAuth();
  if ("error" in auth) throw new Error(auth.error);
  const pr = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
  ) as GhPull & { error?: string };
  if (pr.error) throw new Error(pr.error);
  const [comments, reviews] = await Promise.all([
    listIssueComments(auth, owner, repo, number),
    listReviews(auth, owner, repo, number),
  ]);
  const text = flattenPull(pr, comments, reviews);
  return upsertRemoteDocument(sourceId, {
    path: `github-pull://${owner}/${repo}/${number}`,
    title: `PR #${number}: ${pr.title ?? ""}`.trim(),
    externalUpdatedAt: pr.updated_at ?? new Date().toISOString(),
    text,
  });
}

export async function indexGithubIssueByUrl(
  sourceId: string,
  owner: string,
  repo: string,
  number: number,
): Promise<UpsertResult> {
  const auth = _resolveGithubAuth();
  if ("error" in auth) throw new Error(auth.error);
  const issue = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
  ) as GhIssue & { error?: string };
  if (issue.error) throw new Error(issue.error);
  const comments = await listIssueComments(auth, owner, repo, number);
  const text = flattenIssue(issue, comments);
  return upsertRemoteDocument(sourceId, {
    path: `github-issue://${owner}/${repo}/${number}`,
    title: `Issue #${number}: ${issue.title ?? ""}`.trim(),
    externalUpdatedAt: issue.updated_at ?? new Date().toISOString(),
    text,
  });
}

export async function indexGithubFileByUrl(
  sourceId: string,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<UpsertResult> {
  const auth = _resolveGithubAuth();
  if ("error" in auth) throw new Error(auth.error);
  const contents = await _ghFetch(
    auth,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path
      .split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
  ) as GhContents & { error?: string };
  if (contents.error) throw new Error(contents.error);
  if (contents.type !== "file" || !contents.content) {
    throw new Error(`github contents at ${path} is not a file`);
  }
  const buf = Buffer.from(contents.content.replace(/\s+/g, ""), contents.encoding === "base64" ? "base64" : "utf8");
  if (isLikelyBinary(buf)) throw new Error(`github file ${path} appears to be binary`);
  return upsertRemoteDocument(sourceId, {
    path: `github-file://${owner}/${repo}@${ref}/${path}`,
    title: path,
    externalUpdatedAt: new Date().toISOString(),
    text: buf.toString("utf8"),
  });
}
