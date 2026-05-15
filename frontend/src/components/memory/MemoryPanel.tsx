import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { MemoryItem } from "../../api/types";
import { useMemory } from "../../hooks/useMemory";
import { MemoryEditor } from "./MemoryEditor";

function useDebounce<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

export function MemoryPanel() {
  const [nsFilter, setNsFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 300);
  const { items, loading, create, update, remove, refresh } = useMemory(
    nsFilter || undefined,
    search || undefined
  );
  const [editing, setEditing] = useState<MemoryItem | null | "new">(null);

  const handleSave = useCallback(
    async (namespace: string, key: string, value: unknown) => {
      if (editing === "new") {
        await create(namespace, key, value);
      } else if (editing) {
        await update(namespace, key, value);
      }
    },
    [editing, create, update]
  );

  const namespaces = [...new Set(items.map((i) => i.namespace))].sort();

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-zinc-100 mr-auto">Memory Store</h2>
        <button
          onClick={() => setEditing("new")}
          className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          <Plus size={14} /> New
        </button>
      </div>

      <div className="px-4 py-2 space-y-2 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input
              className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 pl-7 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
              placeholder="Search…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <select
            className="bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
          >
            <option value="">All namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>{ns}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loading && items.length === 0 && (
          <p className="text-zinc-500 text-sm text-center py-8">Loading…</p>
        )}
        {!loading && items.length === 0 && (
          <p className="text-zinc-500 text-sm text-center py-8">No memory items yet</p>
        )}
        {items.map((item) => (
          <div
            key={`${item.namespace}/${item.key}`}
            className="flex items-start gap-2 py-2.5 border-b border-border/60 group"
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-xs text-zinc-500">{item.namespace}</span>
                <span className="text-xs text-zinc-600">/</span>
                <span className="text-xs font-medium text-zinc-200">{item.key}</span>
              </div>
              <p className="text-xs text-zinc-400 truncate">
                {JSON.stringify(item.value)}
              </p>
            </div>
            <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              <button
                onClick={() => setEditing(item)}
                className="p-1 text-zinc-400 hover:text-zinc-100 transition-colors"
                title="Edit"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={async () => { await remove(item.namespace, item.key); }}
                className="p-1 text-zinc-400 hover:text-red-400 transition-colors"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing !== null && (
        <MemoryEditor
          item={editing === "new" ? undefined : editing}
          onSave={handleSave}
          onClose={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}
