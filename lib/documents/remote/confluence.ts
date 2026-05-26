// Confluence remote indexer (ADR-0026).
//
// Source kinds handled:
//   - confluence_space  → CQL `space = "<key>" AND type = page`
//   - confluence_cql    → user-supplied CQL (still scoped to `type = page`)
//
// Incremental: uses `last_cursor` to avoid re-fetching pages whose
// `lastmodified` is older than the previous run's high-water mark.

import {
  _atlassianFetch,
  _resolveAtlassianAuth,
  type AtlassianAuth,
} from "@/lib/tools/atlassian";
import {
  parseSourceConfig,
  updateDocumentSourceCursor,
  type DocumentSourceRow,
} from "@/lib/stores/document-sources";
import { htmlToText } from "./flatten";
import { upsertRemoteDocument, type UpsertResult } from "./upsert";

const PAGE_LIMIT = 25;
const MAX_PAGES_PER_RUN = 200;

interface ConfluencePage {
  id: string;
  title: string;
  version?: { when?: string };
  history?: { lastUpdated?: { when?: string }; createdDate?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}
interface ConfluenceSearchResp {
  results?: ConfluencePage[];
  start?: number;
  size?: number;
  limit?: number;
}

function buildCql(source: DocumentSourceRow, since: string | null): string {
  const cfg = parseSourceConfig<{ space_key?: string; cql?: string; recency_days?: number }>(source) ?? {};
  const clauses: string[] = ["type = page"];
  if (source.kind === "confluence_space") {
    if (!cfg.space_key) throw new Error("confluence_space requires config.space_key");
    clauses.push(`space = "${cfg.space_key}"`);
  } else if (source.kind === "confluence_cql") {
    if (!cfg.cql) throw new Error("confluence_cql requires config.cql");
    clauses.push(`(${cfg.cql})`);
  }
  if (since) clauses.push(`lastmodified > "${since.slice(0, 10)}"`);
  if (cfg.recency_days && cfg.recency_days > 0) {
    clauses.push(`lastmodified > now("-${cfg.recency_days}d")`);
  }
  return clauses.join(" AND ");
}

function pageUpdatedAt(p: ConfluencePage): string {
  return (
    p.version?.when ??
    p.history?.lastUpdated?.when ??
    p.history?.createdDate ??
    new Date().toISOString()
  );
}

async function fetchPage(auth: AtlassianAuth, pageId: string): Promise<ConfluencePage | null> {
  const data = await _atlassianFetch(
    auth,
    `/wiki/rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage,version,history.lastUpdated`,
  ) as ConfluencePage & { error?: string };
  if (!data || (data as { error?: string }).error) return null;
  return data;
}

export interface ConfluenceIndexStats {
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  errors: number;
  cursor: string | null;
}

export async function runConfluenceIndexer(source: DocumentSourceRow): Promise<ConfluenceIndexStats> {
  const stats: ConfluenceIndexStats = {
    scanned: 0, added: 0, updated: 0, unchanged: 0, errors: 0,
    cursor: source.last_cursor,
  };
  const auth = _resolveAtlassianAuth();
  if ("error" in auth) throw new Error(auth.error);

  const cql = buildCql(source, source.last_cursor);
  let start = 0;
  let highWater = source.last_cursor;

  while (stats.scanned < MAX_PAGES_PER_RUN) {
    const url = `/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}` +
      `&expand=body.storage,version,history.lastUpdated&limit=${PAGE_LIMIT}&start=${start}`;
    const data = await _atlassianFetch(auth, url) as ConfluenceSearchResp & { error?: string };
    if ((data as { error?: string }).error) throw new Error((data as { error?: string }).error);
    const results = data.results ?? [];
    if (results.length === 0) break;

    for (const page of results) {
      stats.scanned++;
      try {
        const text = `${page.title}\n\n${htmlToText(page.body?.storage?.value ?? "")}`.trim();
        const updatedAt = pageUpdatedAt(page);
        const res: UpsertResult = await upsertRemoteDocument(source.id, {
          path: `confluence://${page.id}`,
          title: page.title,
          externalUpdatedAt: updatedAt,
          text,
        });
        if (res.status === "added") stats.added++;
        else if (res.status === "updated") stats.updated++;
        else stats.unchanged++;
        if (!highWater || updatedAt > highWater) highWater = updatedAt;
      } catch {
        stats.errors++;
      }
    }
    start += results.length;
    if (results.length < PAGE_LIMIT) break;
  }

  if (highWater && highWater !== source.last_cursor) {
    updateDocumentSourceCursor(source.id, highWater);
    stats.cursor = highWater;
  }
  return stats;
}

/**
 * On-demand: fetch a single Confluence page by id and index it under the
 * shared "on_demand_url" source row. Used by the `documents_index_url` tool
 * for "just pull THIS one page".
 */
export async function indexConfluencePageById(
  sourceId: string,
  pageId: string,
): Promise<UpsertResult> {
  const auth = _resolveAtlassianAuth();
  if ("error" in auth) throw new Error(auth.error);
  const page = await fetchPage(auth, pageId);
  if (!page) throw new Error(`confluence page ${pageId} not found`);
  const text = `${page.title}\n\n${htmlToText(page.body?.storage?.value ?? "")}`.trim();
  return upsertRemoteDocument(sourceId, {
    path: `confluence://${page.id}`,
    title: page.title,
    externalUpdatedAt: pageUpdatedAt(page),
    text,
  });
}
