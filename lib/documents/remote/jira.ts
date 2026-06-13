// Jira remote indexer (ADR-0026).
//
// Source kinds handled:
//   - jira_project  â†’ JQL `project = "<key>"`
//   - jira_jql      â†’ user-supplied JQL
//
// Each indexed "document" is one issue, with its summary, description and
// comments flattened into one text body. Comments live on the same chunk
// graph as the issue body so the same retrieval query can surface either.

import { atlassianFetch, type AtlassianAuth } from "@circuitwall/atlassian-langchain";
import { resolvePackageAuth } from "@/lib/tools/auth-registry";
import {
  parseSourceConfig,
  updateDocumentSourceCursor,
  type DocumentSourceRow,
} from "@/lib/stores/document-sources";
import { adfToText } from "./flatten";
import { upsertRemoteDocument, type UpsertResult } from "./upsert";

const PAGE_LIMIT = 50;
const MAX_ISSUES_PER_RUN = 500;

interface JiraComment {
  author?: { displayName?: string };
  created?: string;
  body?: unknown;          // ADF
}
interface JiraIssueFields {
  summary?: string;
  description?: unknown;   // ADF
  updated?: string;
  comment?: { comments?: JiraComment[]; total?: number };
}
interface JiraIssue {
  key: string;
  fields?: JiraIssueFields;
}
interface JiraSearchResp {
  issues?: JiraIssue[];
  nextPageToken?: string;
}

function buildJql(source: DocumentSourceRow, since: string | null): string {
  const cfg = parseSourceConfig<{ project_key?: string; jql?: string; recency_days?: number }>(source) ?? {};
  const clauses: string[] = [];
  if (source.kind === "jira_project") {
    if (!cfg.project_key) throw new Error("jira_project requires config.project_key");
    clauses.push(`project = "${cfg.project_key}"`);
  } else if (source.kind === "jira_jql") {
    if (!cfg.jql) throw new Error("jira_jql requires config.jql");
    clauses.push(`(${cfg.jql})`);
  }
  if (cfg.recency_days && cfg.recency_days > 0) {
    clauses.push(`updated >= -${cfg.recency_days}d`);
  }
  if (since) clauses.push(`updated > "${formatJqlDate(since)}"`);
  // Monotonic order keeps incremental cursors well-defined even on partial runs.
  return `${clauses.join(" AND ")} ORDER BY updated ASC`;
}

function formatJqlDate(iso: string): string {
  // JQL `updated > "yyyy/MM/dd HH:mm"` â€” minute resolution is enough.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ` +
         `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function flattenIssue(issue: JiraIssue, baseUrl: string): { text: string; updatedAt: string } {
  const f = issue.fields ?? {};
  const parts: string[] = [];
  parts.push(`${issue.key} â€” ${f.summary ?? ""}`.trim());
  parts.push(`${baseUrl}/browse/${issue.key}`);
  const desc = adfToText(f.description);
  if (desc) parts.push(desc);
  for (const c of f.comment?.comments ?? []) {
    const body = adfToText(c.body);
    if (!body.trim()) continue;
    const author = c.author?.displayName ?? "unknown";
    const ts = c.created ? ` (${c.created.slice(0, 10)})` : "";
    parts.push(`Comment by ${author}${ts}:\n${body}`);
  }
  return {
    text: parts.join("\n\n"),
    updatedAt: f.updated ?? new Date().toISOString(),
  };
}

async function fetchIssue(auth: AtlassianAuth, key: string): Promise<JiraIssue | null> {
  const data = await atlassianFetch(
    auth,
    `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,updated,comment`,
  ) as JiraIssue & { error?: string };
  if (!data || (data as { error?: string }).error) return null;
  return data;
}

export interface JiraIndexStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
  cursor: string | null;
  embedFailed: number;
  embedError: string | null;
}

export async function runJiraIndexer(source: DocumentSourceRow): Promise<JiraIndexStats> {
  const stats: JiraIndexStats = {
    scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0,
    cursor: source.last_cursor,
    embedFailed: 0, embedError: null,
  };
  const auth = resolvePackageAuth<AtlassianAuth>("atlassian");
  if ("error" in auth) throw new Error(auth.error);

  const jql = buildJql(source, source.last_cursor);
  let nextPageToken: string | undefined;
  let highWater = source.last_cursor;

  while (stats.scanned < MAX_ISSUES_PER_RUN) {
    const data = await atlassianFetch(auth, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        fields: ["summary", "description", "updated", "comment"],
        maxResults: PAGE_LIMIT,
        nextPageToken,
      }),
    }) as JiraSearchResp & { error?: string };
    if ((data as { error?: string }).error) throw new Error((data as { error?: string }).error);
    const issues = data.issues ?? [];
    if (issues.length === 0) break;

    for (const issue of issues) {
      stats.scanned++;
      try {
        const { text, updatedAt } = flattenIssue(issue, auth.url);
        const res = await upsertRemoteDocument(source.id, {
          path: `jira://${issue.key}`,
          title: `${issue.key}: ${issue.fields?.summary ?? ""}`.trim(),
          externalUpdatedAt: updatedAt,
          text,
        });
        if (res.status === "added") stats.added++;
        else if (res.status === "updated") stats.updated++;
        else stats.unchanged++;
        stats.embedFailed += res.chunks - res.embedded;
        if (res.embedError && !stats.embedError) stats.embedError = res.embedError;
        if (!highWater || updatedAt > highWater) highWater = updatedAt;
      } catch {
        stats.errors++;
      }
    }
    nextPageToken = data.nextPageToken;
    if (!nextPageToken) break;
  }

  if (highWater && highWater !== source.last_cursor) {
    updateDocumentSourceCursor(source.id, highWater);
    stats.cursor = highWater;
  }
  return stats;
}

/** On-demand: fetch & index a single issue by key under the shared
 *  on_demand_url source row. */
export async function indexJiraIssueByKey(
  sourceId: string,
  key: string,
): Promise<UpsertResult> {
  const auth = resolvePackageAuth<AtlassianAuth>("atlassian");
  if ("error" in auth) throw new Error(auth.error);
  const issue = await fetchIssue(auth, key);
  if (!issue) throw new Error(`jira issue ${key} not found`);
  const { text, updatedAt } = flattenIssue(issue, auth.url);
  return upsertRemoteDocument(sourceId, {
    path: `jira://${issue.key}`,
    title: `${issue.key}: ${issue.fields?.summary ?? ""}`.trim(),
    externalUpdatedAt: updatedAt,
    text,
  });
}
