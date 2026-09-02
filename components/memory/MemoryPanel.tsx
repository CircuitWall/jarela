"use client";
import { Loader2, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryItem } from "@/api/types";
import { useMemory } from "@/hooks/useMemory";
import { useDeepLinkScroll } from "@/hooks/useDeepLinkScroll";
import { MemoryEditor } from "./MemoryEditor";
import { MemoryValuePreview } from "./MemoryValuePreview";
import { Select } from "@/components/ui/Select";
import { TextInput } from "@/components/ui/TextField";
import { pushToast } from "@/lib/ui/toasts";

function useDebounce<T>(value: T, ms: number): T {
  const [d, setD] = useState(value);
  useEffect(() => { const id = setTimeout(() => setD(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return d;
}

export function MemoryPanel() {
  const [nsFilter, setNsFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounce(searchInput, 300);
  const { items, loading, create, update, remove, refresh } = useMemory(nsFilter || undefined, search || undefined);
  const [editing, setEditing] = useState<MemoryItem | null | "new">(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useDeepLinkScroll("memory", "memory", containerRef);

  const handleSave = useCallback(async (namespace: string, key: string, value: unknown) => {
    if (editing === "new") await create(namespace, key, value);
    else if (editing) await update(namespace, key, value);
  }, [editing, create, update]);

  const namespaces = [...new Set(items.map((i) => i.namespace))].sort();

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg mr-auto">Memory Store</h2>
        <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors">
          <Plus size={14} /> New
        </button>
      </div>
      <div className="px-4 py-2 space-y-2 border-b border-border">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" />
            <TextInput className="pl-7"
              placeholder="Search…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
          </div>
          <Select full={false} value={nsFilter} onChange={(e) => setNsFilter(e.target.value)}>
            <option value="">All namespaces</option>
            {namespaces.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
          </Select>
        </div>
      </div>
      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar px-4 py-2">
        {loading && items.length === 0 && <p className="text-fg-faint text-sm text-center py-8">Loading…</p>}
        {!loading && items.length === 0 && <p className="text-fg-faint text-sm text-center py-8">No memory items yet</p>}
        {items.map((item) => (
          <MemoryRow
            key={`${item.namespace}/${item.key}`}
            item={item}
            onEdit={() => setEditing(item)}
            onRemove={async () => {
              await remove(item.namespace, item.key);
              pushToast({
                kind: "info",
                source: "system",
                sourceLabel: "Memory",
                title: "Memory item deleted",
                body: `${item.namespace}/${item.key}`,
                agent_id: null,
                thread_id: null,
                ttl: 3000,
              });
            }}
          />
        ))}
      </div>
      {editing !== null && (
        <MemoryEditor item={editing === "new" ? undefined : editing} onSave={handleSave} onClose={() => { setEditing(null); refresh(); }} />
      )}
    </div>
  );
}

function MemoryRow({
  item,
  onEdit,
  onRemove,
}: {
  item: MemoryItem;
  onEdit: () => void;
  onRemove: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      data-deep-link-id={`${item.namespace}/${item.key}`}
      onClick={onEdit}
      className="flex items-start gap-2 py-2.5 border-b border-border/60 group cursor-pointer hover:bg-surface-3/30 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[10px] uppercase tracking-wide text-fg-faint">{item.namespace}</span>
          <span className="text-fg-faint">/</span>
          <span className="text-xs font-medium text-fg truncate">{item.key}</span>
        </div>
        <MemoryValuePreview value={item.value} />
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity shrink-0">
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (deleting) return;
            setDeleting(true);
            try {
              await onRemove();
            } finally {
              setDeleting(false);
            }
          }}
          disabled={deleting}
          className="p-1 text-fg-subtle hover:text-red-700 dark:hover:text-red-400 transition-colors disabled:opacity-50"
          title={deleting ? "Deleting…" : "Delete"}
        >
          {deleting ? <Loader2 size={13} className="animate-spin text-red-600 dark:text-red-400" /> : <Trash2 size={13} />}
        </button>
      </div>
    </div>
  );
}
