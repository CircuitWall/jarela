// Remote document-source dispatcher (ADR-0026).
//
// `lib/documents/indexer.ts` walks local folders. For non-local kinds it
// delegates to one of these per-kind handlers. Keeping the dispatcher tiny
// (just a switch) keeps the local-folder happy path untouched.

import {
  createDocumentSource,
  getDocumentSourceByPath,
  markSourceScanned,
  type DocumentSourceRow,
} from "@/lib/stores/document-sources";
import { runConfluenceIndexer, indexConfluencePageById } from "./confluence";
import { runJiraIndexer, indexJiraIssueByKey } from "./jira";
import {
  runGithubIndexer,
  indexGithubPullByUrl,
  indexGithubIssueByUrl,
  indexGithubFileByUrl,
} from "./github";
import type { UpsertResult } from "./upsert";

export interface RemoteIndexStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
  /** Total chunks across this run that didn't get an embedding vector. */
  embedFailed?: number;
  /** First embed error message seen, if any. */
  embedError?: string | null;
}

/** Returns true if `kind` is anything other than `local_folder`. */
export function isRemoteKind(kind: string): boolean {
  return kind !== "local_folder";
}

export async function runRemoteSource(source: DocumentSourceRow): Promise<RemoteIndexStats> {
  let lastError: string | null = null;
  let stats: RemoteIndexStats = { scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0 };
  try {
    switch (source.kind) {
      case "confluence_space":
      case "confluence_cql": {
        const s = await runConfluenceIndexer(source);
        stats = s;
        break;
      }
      case "jira_project":
      case "jira_jql": {
        const s = await runJiraIndexer(source);
        stats = s;
        break;
      }
      case "github_pulls":
      case "github_repo": {
        const s = await runGithubIndexer(source);
        stats = s;
        break;
      }
      case "on_demand_url":
        // No background sweep — items are added one-at-a-time via
        // indexOnDemand() from the tool / API surface.
        break;
      default:
        throw new Error(`unsupported remote source kind: ${source.kind}`);
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    stats.errors++;
  }
  // Mirror the local indexer's surfacing rule: a fetch error wins; otherwise
  // bubble up an embed-failure summary so the operator sees that semantic
  // search is degraded for this source without grepping logs.
  const embedFailed = stats.embedFailed ?? 0;
  const composite = lastError
    ? lastError
    : embedFailed > 0
      ? `${embedFailed} chunk${embedFailed === 1 ? "" : "s"} failed to embed${stats.embedError ? ": " + stats.embedError : ""}`
      : null;
  markSourceScanned(source.id, composite);
  return stats;
}

/** Singleton "on-demand URLs" source row. Lazily created on first use. */
const ON_DEMAND_PATH = "on-demand://urls";
export function getOrCreateOnDemandSource(): DocumentSourceRow {
  const existing = getDocumentSourceByPath(ON_DEMAND_PATH);
  if (existing) return existing;
  return createDocumentSource({
    path: ON_DEMAND_PATH,
    label: "On-demand URLs",
    kind: "on_demand_url",
    config: null,
  });
}

/**
 * Resolve a free-form input (Jira issue key, Jira browse URL, Confluence
 * page URL, GitHub PR/issue/blob URL) to "fetch this one thing and index
 * it under the on-demand source". Surfaced via the `documents_index_url`
 * tool + HTTP API. ADR-0029 added the GitHub matchers.
 */
export async function indexOnDemand(input: string): Promise<{
  kind: "jira" | "confluence" | "github";
  identifier: string;
  result: UpsertResult;
  source_id: string;
}> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("input is required");
  const source = getOrCreateOnDemandSource();

  // Bare Jira key.
  const bareKey = /^[A-Z][A-Z0-9_]+-\d+$/;
  if (bareKey.test(trimmed)) {
    const result = await indexJiraIssueByKey(source.id, trimmed);
    return { kind: "jira", identifier: trimmed, result, source_id: source.id };
  }
  // Jira /browse/<KEY>
  const browse = trimmed.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
  if (browse) {
    const result = await indexJiraIssueByKey(source.id, browse[1]);
    return { kind: "jira", identifier: browse[1], result, source_id: source.id };
  }
  // Confluence /wiki/spaces/.../pages/<id>
  const pages = trimmed.match(/\/wiki\/spaces\/[^/]+\/pages\/(\d+)/);
  if (pages) {
    const result = await indexConfluencePageById(source.id, pages[1]);
    return { kind: "confluence", identifier: pages[1], result, source_id: source.id };
  }
  // Confluence ?pageId=<id>
  const pageId = trimmed.match(/[?&]pageId=(\d+)/);
  if (pageId) {
    const result = await indexConfluencePageById(source.id, pageId[1]);
    return { kind: "confluence", identifier: pageId[1], result, source_id: source.id };
  }
  // GitHub PR /pull/<n>
  const ghPull = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (ghPull) {
    const [, owner, repo, n] = ghPull;
    const result = await indexGithubPullByUrl(source.id, owner, repo, Number(n));
    return { kind: "github", identifier: `${owner}/${repo}#${n}`, result, source_id: source.id };
  }
  // GitHub issue /issues/<n>
  const ghIssue = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (ghIssue) {
    const [, owner, repo, n] = ghIssue;
    const result = await indexGithubIssueByUrl(source.id, owner, repo, Number(n));
    return { kind: "github", identifier: `${owner}/${repo}#${n}`, result, source_id: source.id };
  }
  // GitHub file /blob/<ref>/<path>
  const ghBlob = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (ghBlob) {
    const [, owner, repo, ref, path] = ghBlob;
    const cleanPath = path.split("?")[0].split("#")[0];
    const result = await indexGithubFileByUrl(source.id, owner, repo, ref, cleanPath);
    return { kind: "github", identifier: `${owner}/${repo}@${ref}/${cleanPath}`, result, source_id: source.id };
  }

  throw new Error(
    "could not recognise input — expected a Jira issue key (ABC-123), a /browse/<KEY> URL, " +
    "a Confluence /wiki/spaces/.../pages/<id> URL, or a GitHub /pull/<n>, /issues/<n>, or " +
    "/blob/<ref>/<path> URL.",
  );
}
