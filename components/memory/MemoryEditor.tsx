"use client";
import { useState } from "react";
import type { MemoryItem } from "@/api/types";
import { pushErrorToast } from "@/lib/ui/error-report";
import { Dialog } from "@/components/ui/Dialog";

interface Props {
  item?: MemoryItem;
  onSave: (namespace: string, key: string, value: unknown) => Promise<void>;
  onClose: () => void;
}

export function MemoryEditor({ item, onSave, onClose }: Props) {
  const [namespace, setNamespace] = useState(item?.namespace ?? "");
  const [key, setKey] = useState(item?.key ?? "");
  const [valueStr, setValueStr] = useState(item ? JSON.stringify(item.value, null, 2) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isEdit = !!item;

  async function handleSave() {
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(valueStr); } catch { setError("Value must be valid JSON"); return; }
    if (!namespace.trim() || !key.trim()) { setError("Namespace and key are required"); return; }
    setSaving(true);
    try { await onSave(namespace.trim(), key.trim(), parsed); onClose(); }
    catch (e) {
      pushErrorToast({
        title: "Couldn't save memory entry",
        error: e,
        context: { panel: "memory", action: "memory.save", namespace: namespace.trim(), key: key.trim() },
      });
    }
    finally { setSaving(false); }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? "Edit memory" : "New memory"}
      size="sm"
      align="center"
      footer={
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-4 py-1.5 text-sm bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      }
    >
      {(["Namespace", "Key"] as const).map((label) => (
        <label key={label} className="block">
          <span className="text-xs text-fg-subtle mb-1 block">{label}</span>
          <input
            className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            value={label === "Namespace" ? namespace : key}
            onChange={(e) => label === "Namespace" ? setNamespace(e.target.value) : setKey(e.target.value)}
            placeholder={label === "Namespace" ? "e.g. user/preferences" : "e.g. theme"}
            disabled={isEdit}
          />
        </label>
      ))}
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Value (JSON)</span>
        <textarea
          className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono h-28 resize-none"
          value={valueStr}
          onChange={(e) => setValueStr(e.target.value)}
          placeholder='{"key": "value"}'
        />
      </label>
      {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
    </Dialog>
  );
}
