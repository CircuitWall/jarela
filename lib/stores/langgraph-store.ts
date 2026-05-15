import { BaseStore } from "@langchain/langgraph-checkpoint";
import type { Operation, OperationResults, Item } from "@langchain/langgraph-checkpoint";
import { getMemory, putMemory, deleteMemory, listMemory } from "@/lib/stores/memory";

export class SqliteMemoryStore extends BaseStore {
  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const results = await Promise.all(
      operations.map(async (op): Promise<Item | null | Item[] | void> => {
        // GetOperation: { namespace, key } — no "value" or "namespacePrefix"
        if ("key" in op && "namespace" in op && !("value" in op) && !("namespacePrefix" in op)) {
          const ns = op.namespace.join("/");
          const row = getMemory(ns, op.key);
          if (!row) return null;
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(row.value) as Record<string, unknown>;
          } catch {
            value = { _raw: row.value };
          }
          return {
            namespace: op.namespace,
            key: op.key,
            value,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
          };
        }

        // PutOperation: { namespace, key, value }
        if ("value" in op && "namespace" in op && "key" in op) {
          const ns = op.namespace.join("/");
          if (op.value === null) {
            deleteMemory(ns, op.key);
          } else {
            putMemory(ns, op.key, op.value);
          }
          return undefined;
        }

        // SearchOperation: { namespacePrefix, ... }
        if ("namespacePrefix" in op) {
          const prefix = (op.namespacePrefix as string[]).join("/");
          const limit = "limit" in op && typeof op.limit === "number" ? op.limit : 10;
          const rows = listMemory(prefix || undefined, undefined, limit);
          return rows.map((r) => {
            let value: Record<string, unknown>;
            try {
              value = JSON.parse(r.value) as Record<string, unknown>;
            } catch {
              value = { _raw: r.value };
            }
            return {
              namespace: r.namespace.split("/"),
              key: r.key,
              value,
              createdAt: new Date(r.created_at),
              updatedAt: new Date(r.updated_at),
            };
          });
        }

        return undefined;
      }),
    );
    return results as unknown as OperationResults<Op>;
  }
}
