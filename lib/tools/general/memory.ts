import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getMemory, putMemory, listMemory, deleteMemory } from "@/lib/stores/memory";
import { recall } from "@/lib/embeddings";
import { CURRENT_STRUCTURED_MEMORY_VERSION, StructuredMemoryInputSchema } from "@/lib/memory/record";
import { registerLangChainPackage } from "../packages/langchain-package";

export const memoryReadTool = tool(
  async ({ namespace, key }) => {
    const row = getMemory(namespace, key);
    if (!row) return JSON.stringify(null);
    return row.value; // already stored as a JSON string
  },
  {
    name: "memory_read",
    description: "Read a value from long-term memory by namespace and key. Returns null if not found.",
    schema: z.object({
      namespace: z.string().describe("Memory namespace (e.g. 'user', 'facts', 'tasks')"),
      key: z.string().describe("Key within the namespace"),
    }),
  },
);

export const memoryWriteTool = tool(
  async ({ namespace, key, value }) => {
    putMemory(namespace, key, value);
    return JSON.stringify({ ok: true, namespace, key });
  },
  {
    name: "memory_write",
    description:
      "Write or update a value in long-term memory. Use this to remember facts, user preferences, or any information that should persist across conversations.",
    schema: z.object({
      namespace: z.string().describe("Memory namespace (e.g. 'user', 'facts', 'tasks')"),
      key: z.string().describe("Key within the namespace"),
      value: z.string().describe("Value to store (serialize objects to JSON before passing)"),
    }),
  },
);

export const memoryUpsertTool = tool(
  async ({ namespace, key, record }) => {
    const saved = putMemory(namespace, key, { version: CURRENT_STRUCTURED_MEMORY_VERSION, ...record });
    return JSON.stringify({ ok: true, namespace: saved.namespace, key: saved.key, kind: record.kind });
  },
  {
    name: "memory_upsert",
    description:
      "Store a durable, structured memory record for proactive semantic recall. Use namespace='facts' for information that should surface in future conversations. Store explicit user preferences, verified facts, decisions, constraints, and reusable project context; do not store transient chat details or secrets. Use an expiry for temporary facts, and status='archived' to soft-retire a record instead of deleting it.",
    schema: z.object({
      namespace: z.string().describe("Memory namespace. Use 'facts' for proactively recalled durable knowledge."),
      key: z.string().describe("Stable, descriptive key such as 'user-research-preference' or 'project-auth-decision'."),
      record: StructuredMemoryInputSchema.describe("Memory fields: subject, content, tags, confidence, source, optional summary/aliases/expiry, and status."),
    }),
  },
);

export const memoryListTool = tool(
  async ({ namespace, search, limit }) => {
    const rows = listMemory(namespace, search, limit ?? 20);
    const result = rows.map((r) => ({
      namespace: r.namespace,
      key: r.key,
      value: (() => {
        try {
          return JSON.parse(r.value);
        } catch {
          return r.value;
        }
      })(),
      updated_at: r.updated_at,
    }));
    return JSON.stringify(result);
  },
  {
    name: "memory_list",
    description: "List memory entries, optionally filtered by namespace or search term.",
    schema: z.object({
      namespace: z.string().optional().describe("Filter by namespace (optional)"),
      search: z.string().optional().describe("Search term to filter keys/values (optional)"),
      limit: z.number().optional().describe("Max results (default 20)"),
    }),
  },
);

export const memoryDeleteTool = tool(
  async ({ namespace, key }) => {
    const removed = deleteMemory(namespace, key);
    return JSON.stringify({ ok: true, namespace, key, removed });
  },
  {
    name: "memory_delete",
    description:
      "Delete a single memory entry by namespace and key. Returns { removed: true } if a row was removed, { removed: false } if no matching row existed. Bulk deletion by namespace is not supported by this tool — list-then-delete-loop if needed.",
    schema: z.object({
      namespace: z.string().describe("Memory namespace"),
      key: z.string().describe("Key within the namespace"),
    }),
  },
);

export const memorySearchTool = tool(
  async ({ query, namespace, limit }) => {
    const take = limit ?? 10;
    // recall() ranks across all namespaces + chat messages together; when the
    // caller wants one namespace, over-fetch first so the post-filter still
    // has enough candidates to reach `take`.
    const hits = await recall(query, namespace ? take * 4 : take);
    const filtered = hits
      .filter((h) => h.source === "memory" && (!namespace || h.namespace === namespace))
      .slice(0, take)
      .map((h) => ({ namespace: h.namespace, key: h.key, content: h.content, score: h.score, updated_at: h.created_at }));
    return JSON.stringify(filtered);
  },
  {
    name: "memory_search",
    description:
      "Semantically search long-term memory by meaning, not exact text (embeddings-based cosine similarity; falls back to keyword overlap when no embedding provider is configured). Prefer this over memory_list when your query is a paraphrase or concept rather than a literal substring you expect to find verbatim.",
    schema: z.object({
      query: z.string().describe("Natural-language query to search memory for"),
      namespace: z.string().optional().describe("Restrict results to this namespace (optional)"),
      limit: z.number().optional().describe("Max results (default 10)"),
    }),
  },
);

registerLangChainPackage({
  category: "Memory",
  tools: {
    read: [memoryReadTool, memoryListTool, memorySearchTool],
    write: [memoryWriteTool, memoryUpsertTool, memoryDeleteTool],
  },
});
