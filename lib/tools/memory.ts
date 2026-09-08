import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getMemory, putMemory, listMemory, deleteMemory } from "@/lib/stores/memory";
import { CURRENT_STRUCTURED_MEMORY_VERSION, StructuredMemoryInputSchema } from "@/lib/memory/record";
import { registerLangChainPackage } from "./packages/langchain-package";

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

registerLangChainPackage({
  category: "Memory",
  tools: {
    read: [memoryReadTool, memoryListTool],
    write: [memoryWriteTool, memoryUpsertTool, memoryDeleteTool],
  },
});
