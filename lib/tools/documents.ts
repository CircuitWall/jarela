// documents_search — semantic recall over folders the user indexed under
// Documents (ADR-0024). Cosine over embedded chunks; substring fallback
// when no embedding provider is configured or chunks haven't been
// embedded yet.

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerTools } from "./registry";
import { searchDocuments } from "@/lib/documents/search";
import { listDocumentSources } from "@/lib/stores/document-sources";

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

registerTools("Documents", [documentsSearch, documentsListSources]);
