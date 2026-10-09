import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getMemory, putMemory, listMemory, deleteMemory, searchMemoryRows } from "@/lib/stores/memory";
import { getDefaultChatMinSimilarity, searchMemory } from "@/lib/embeddings";
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
    const take = limit ?? 20;
    const rows = search ? await searchMemoryRows(namespace, search, take) : listMemory(namespace, undefined, take);
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
    description: "List memory entries, optionally filtered by namespace. With a search term, matches by meaning and by exact text in keys and values; without one, lists newest first.",
    schema: z.object({
      namespace: z.string().optional().describe("Filter by namespace (optional)"),
      search: z.string().optional().describe("Search term matched by meaning and by exact text in keys and values (optional)"),
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
  async ({ query, namespace, limit, include_chats, min_similarity, min_chat_similarity }) => {
    const hits = await searchMemory(query, {
      limit: limit ?? 10,
      namespace,
      sources: include_chats ? "all" : "memory",
      literal: true,
      minSimilarity: min_similarity,
      minMessageSimilarity: include_chats ? min_chat_similarity ?? getDefaultChatMinSimilarity() : undefined,
    });
    return JSON.stringify(hits.map((h) => h.source === "memory"
      ? { source: "memory", namespace: h.namespace, key: h.key, content: h.content, score: h.score, match: h.match, updated_at: h.created_at }
      : { source: "chat", thread_id: h.thread_id, role: h.role, content: h.content, score: h.score, match: h.match, created_at: h.created_at }));
  },
  {
    name: "memory_search",
    description:
      "Search long-term memory by meaning and by exact text (embedding similarity plus literal key/value matches; falls back to keyword overlap when no embedding model is configured). Prefer this over memory_list for paraphrases or concepts. Set include_chats to also search past conversations, including archived turns.",
    schema: z.object({
      query: z.string().describe("Natural-language query to search memory for"),
      namespace: z.string().optional().describe("Restrict results to this namespace (optional; excludes chat history)"),
      limit: z.number().optional().describe("Max results (default 10)"),
      include_chats: z.boolean().optional().describe("Also search past conversations (default false)"),
      min_similarity: z.number().min(0).max(1).optional()
        .describe("Minimum cosine similarity for saved-memory hits (default 0.25). Lower toward 0 to widen semantic results; literal/keyword matches are unaffected."),
      min_chat_similarity: z.number().min(0).max(1).optional()
        .describe("When include_chats is true, minimum cosine similarity for chat hits (bundled local default 0.84; other providers 0.25). Lower toward 0 to widen chat results."),
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
