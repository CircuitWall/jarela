import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { MemoryItem } from "../../api/types";

interface Props {
  item?: MemoryItem;
  onSave: (namespace: string, key: string, value: unknown) => Promise<void>;
  onClose: () => void;
}

export function MemoryEditor({ item, onSave, onClose }: Props) {
  const [namespace, setNamespace] = useState(item?.namespace ?? "");
  const [key, setKey] = useState(item?.key ?? "");
  const [valueStr, setValueStr] = useState(
    item ? JSON.stringify(item.value, null, 2) : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(valueStr);
    } catch {
      setError("Value must be valid JSON");
      return;
    }
    if (!namespace.trim() || !key.trim()) {
      setError("Namespace and key are required");
      return;
    }
    setSaving(true);
    try {
      await onSave(namespace.trim(), key.trim(), parsed);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const isEdit = !!item;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-md shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-zinc-100">
            {isEdit ? "Edit memory" : "New memory"}
          </h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <label className="block">
            <span className="text-xs text-zinc-400 mb-1 block">Namespace</span>
            <input
              className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              placeholder="e.g. user/preferences"
              disabled={isEdit}
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400 mb-1 block">Key</span>
            <input
              className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g. theme"
              disabled={isEdit}
            />
          </label>
          <label className="block">
            <span className="text-xs text-zinc-400 mb-1 block">Value (JSON)</span>
            <textarea
              className="w-full bg-surface-3 text-zinc-100 text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono h-28 resize-none"
              value={valueStr}
              onChange={(e) => setValueStr(e.target.value)}
              placeholder='{"key": "value"}'
            />
          </label>
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
