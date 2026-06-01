// documents_search — semantic recall over folders the user indexed under
// Documents (ADR-0024). Cosine over embedded chunks; substring fallback
// when no embedding provider is configured or chunks haven't been
// embedded yet.

import { tool } from "@langchain/core/tools";
import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { registerTools } from "./registry";
import { searchDocuments } from "@/lib/documents/search";
import {
  createDocumentSource,
  deleteDocumentSource,
  getDocumentSource,
  getDocumentSourceByPath,
  listDocumentSources,
  type DocumentSourceKind,
} from "@/lib/stores/document-sources";
import { indexOnDemand, runRemoteSource } from "@/lib/documents/remote";
import { notifyTriggerHandlers } from "@/lib/triggers";

export const documentsSearch = tool(
  async ({ query, limit, source_id }) => {
    const hits = await searchDocuments(query, { limit, sourceId: source_id });
    return JSON.stringify({
      query,
      hits: hits.map((h) => ({
        source: h.source_label ?? h.source_id,
        path: h.rel_path,
        chunk_index: h.chunk_index,
        score: Number(h.score.toFixed(4)),
        match: h.match,
        text: h.text,
      })),
    });
  },
  {
    name: "documents_search",
    description:
      "Search indexed local documents (notes, READMEs, code, configs) by semantic similarity. " +
      "Use when the user references files in folders they've added under Documents, or when " +
      "you need facts from project-specific text the model wouldn't otherwise know. Returns " +
      "the top matching text chunks with their source path.",
    schema: z.object({
      query: z.string().describe("Natural-language question or keywords to look up."),
      limit: z.number().int().min(1).max(25).optional()
        .describe("Max results to return (default 8)."),
      source_id: z.string().optional()
        .describe("Restrict the search to a single document_source id. Omit to search all."),
    }),
  },
);

export const documentsListSources = tool(
  async () => {
    const rows = listDocumentSources();
    return JSON.stringify({
      sources: rows.map((r) => ({
        id: r.id,
        path: r.path,
        label: r.label,
        enabled: r.enabled === 1,
        last_scan_at: r.last_scan_at,
      })),
    });
  },
  {
    name: "documents_list_sources",
    description:
      "List the folders Jarela is indexing for document search. Useful before calling " +
      "documents_search with a source_id filter.",
    schema: z.object({}),
  },
);

export const documentsAddLocalSource = tool(
  async ({ path: inputPath, label }) => {
    const abs = path.resolve(inputPath);
    try {
      const st = await fs.stat(abs);
      if (!st.isDirectory()) {
        return JSON.stringify({ error: "path is not a directory" });
      }
    } catch {
      return JSON.stringify({ error: "path does not exist or is unreadable" });
    }
    if (getDocumentSourceByPath(abs)) {
      return JSON.stringify({ error: "source already exists for this path" });
    }
    try {
      const row = createDocumentSource({ path: abs, label: label ?? null, kind: "local_folder" });
      await notifyTriggerHandlers("source_changed");
      return JSON.stringify({
        ok: true,
        id: row.id,
        kind: row.kind,
        path: row.path,
        label: row.label,
        note: "Local folders auto-reindex on file changes (fs-watch on macOS/Windows; periodic sweep fallback on Linux).",
      });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  {
    name: "documents_add_local_source",
    description:
      "Add a local folder as a Documents source so its files become searchable via documents_search. " +
      "Pass any relative or absolute path; the tool resolves it to an absolute directory and validates it.",
    schema: z.object({
      path: z.string().min(1).describe("Local folder path to index (relative or absolute)."),
      label: z.string().optional().describe("Optional source label shown in the Documents panel."),
    }),
  },
);

registerTools("Documents", "read", [documentsSearch, documentsListSources]);
registerTools("Documents", "write", [documentsAddLocalSource]);

// ── Remote document sources (ADR-0026) ──────────────────────────────────────
//
// These tools let agents add Jira projects, JQL queries, Confluence spaces,
// and CQL queries as document sources, so a single retrieval surface
// (`documents_search`) covers both local files and Atlassian content.

const REMOTE_KINDS = [
  "confluence_space",
  "confluence_cql",
  "jira_project",
  "jira_jql",
  "github_pulls",
  "github_repo",
] as const;

function syntheticPath(kind: DocumentSourceKind, config: Record<string, unknown>): string {
  switch (kind) {
    case "confluence_space": return `confluence-space://${String(config.space_key ?? "").trim()}`;
    case "confluence_cql":   return `confluence-cql://${Buffer.from(String(config.cql ?? "")).toString("base64").slice(0, 32)}`;
    case "jira_project":     return `jira-project://${String(config.project_key ?? "").trim()}`;
    case "jira_jql":         return `jira-jql://${Buffer.from(String(config.jql ?? "")).toString("base64").slice(0, 32)}`;
    case "github_pulls":     return `github-pulls://${String(config.owner ?? "").trim()}/${String(config.repo ?? "").trim()}`;
    case "github_repo":      return `github-repo://${String(config.owner ?? "").trim()}/${String(config.repo ?? "").trim()}`;
    default:                 return `remote://${kind}/${Date.now()}`;
  }
}

function validateRemoteConfig(kind: typeof REMOTE_KINDS[number], cfg: Record<string, unknown>): string | null {
  if (kind === "confluence_space" && !cfg.space_key)   return "config.space_key is required for confluence_space";
  if (kind === "confluence_cql"   && !cfg.cql)         return "config.cql is required for confluence_cql";
  if (kind === "jira_project"     && !cfg.project_key) return "config.project_key is required for jira_project";
  if (kind === "jira_jql"         && !cfg.jql)         return "config.jql is required for jira_jql";
  if (kind === "github_pulls"     && (!cfg.owner || !cfg.repo)) return "config.owner and config.repo are required for github_pulls";
  if (kind === "github_repo"      && (!cfg.owner || !cfg.repo)) return "config.owner and config.repo are required for github_repo";
  return null;
}

export const documentsAddRemoteSource = tool(
  async ({ kind, label, config }) => {
    const err = validateRemoteConfig(kind, config);
    if (err) return JSON.stringify({ error: err });
    const path = syntheticPath(kind, config);
    try {
      const row = createDocumentSource({ path, label, kind, config });
      return JSON.stringify({
        ok: true,
        id: row.id,
        kind: row.kind,
        label: row.label,
        note: "Remote sources index on the scheduler sweep (~10 min). Call documents_reindex_source with this id to force an immediate sync. Local folders auto-reindex on file changes.",
      });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  {
    name: "documents_add_remote_source",
    description:
      "Add a Jira project / JQL query / Confluence space / CQL query / GitHub repo as a document source. " +
      "Indexed content becomes searchable via documents_search alongside local folders. " +
      "Examples: kind='confluence_space' config={space_key:'ENG'}; kind='jira_project' " +
      "config={project_key:'ABC', recency_days:90}; kind='jira_jql' config={jql:'project = ABC AND status != Done'}; " +
      "kind='github_pulls' config={owner:'octocat', repo:'hello-world', state:'all', recency_days:60}; " +
      "kind='github_repo' config={owner:'octocat', repo:'hello-world', ref:'main', path_prefix:'docs'}.",
    schema: z.object({
      kind: z.enum(REMOTE_KINDS),
      label: z.string().describe("Human-readable label shown in the Documents panel."),
      config: z.record(z.string(), z.unknown())
        .describe("Per-kind config. confluence_space: {space_key}. confluence_cql: {cql}. " +
                  "jira_project: {project_key}. jira_jql: {jql}. " +
                  "github_pulls: {owner, repo, state?, recency_days?}. " +
                  "github_repo: {owner, repo, ref?, path_prefix?}. Optional everywhere: recency_days (int)."),
    }),
  },
);

export const documentsRemoveSource = tool(
  async ({ source_id, confirm }) => {
    if (confirm !== source_id) {
      return JSON.stringify({ error: "pass confirm equal to source_id to actually delete" });
    }
    const row = getDocumentSource(source_id);
    if (!row) return JSON.stringify({ error: "source not found" });
    const ok = deleteDocumentSource(source_id);
    return JSON.stringify({ ok, id: source_id, label: row.label });
  },
  {
    name: "documents_remove_source",
    description:
      "Delete a document source and all its indexed chunks. Destructive — requires `confirm` to equal `source_id`.",
    schema: z.object({
      source_id: z.string(),
      confirm: z.string().describe("Must equal source_id to proceed."),
    }),
  },
);

export const documentsReindexSource = tool(
  async ({ source_id }) => {
    const row = getDocumentSource(source_id);
    if (!row) return JSON.stringify({ error: "source not found" });
    if (row.kind === "local_folder") {
      return JSON.stringify({
        error: "documents_reindex_source is only for remote sources (Jira/Confluence). " +
               "Local folders auto-reindex on file changes (fs-watch on macOS/Windows; periodic sweep fallback on Linux).",
      });
    }
    try {
      const stats = await runRemoteSource(row);
      return JSON.stringify({ ok: true, id: source_id, stats });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  {
    name: "documents_reindex_source",
    description:
      "Force an immediate incremental sync of a remote document source. Returns counts of added / updated / unchanged docs.",
    schema: z.object({ source_id: z.string() }),
  },
);

export const documentsIndexUrl = tool(
  async ({ input }) => {
    try {
      const res = await indexOnDemand(input);
      return JSON.stringify({ ok: true, ...res });
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  {
    name: "documents_index_url",
    description:
      "Fetch and index a single Jira issue, Confluence page, or GitHub PR/issue/file on demand, " +
      "stored under a shared 'On-demand URLs' source. Accepts a bare Jira key (ABC-123), a " +
      "/browse/<KEY> URL, a Confluence /wiki/spaces/.../pages/<id> URL, or a GitHub /pull/<n>, " +
      "/issues/<n>, or /blob/<ref>/<path> URL.",
    schema: z.object({
      input: z.string().describe("Jira key, Jira URL, Confluence page URL, or GitHub PR/issue/blob URL"),
    }),
  },
);

registerTools("Documents", "write", [
  documentsAddRemoteSource,
  documentsRemoveSource,
  documentsReindexSource,
  documentsIndexUrl,
]);
