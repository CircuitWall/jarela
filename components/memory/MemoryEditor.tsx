"use client";
import { useState } from "react";
import type { MemoryItem } from "@/api/types";
import { errorMessage } from "@/lib/utils/error";
import { Dialog } from "@/components/ui/Dialog";
import { DialogError, DialogFooter } from "@/components/ui/DialogFooter";
import { TextInput, TextArea } from "@/components/ui/TextField";
import { useDirty, useDismissGuard } from "@/hooks/useDismissGuard";

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
  const dirty = useDirty({ namespace, key, valueStr });
  const requestClose = useDismissGuard({ dirty, busy: saving, onClose });

  async function handleSave() {
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(valueStr); } catch { setError("Value must be valid JSON"); return; }
    if (!namespace.trim() || !key.trim()) { setError("Namespace and key are required"); return; }
    setSaving(true);
    try { await onSave(namespace.trim(), key.trim(), parsed); onClose(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  }

  return (
    <Dialog
      open
      onClose={requestClose}
      title={isEdit ? "Edit memory" : "New memory"}
      size="sm"
      align="center"
      footer={<DialogFooter onCancel={requestClose} onDiscard={onClose} dirty={dirty} canSave={!isEdit || dirty} onSave={handleSave} saving={saving} />}
    >
      {(["Namespace", "Key"] as const).map((label) => (
        <label key={label} className="block">
          <span className="text-xs text-fg-subtle mb-1 block">{label}</span>
          <TextInput
            value={label === "Namespace" ? namespace : key}
            onChange={(e) => label === "Namespace" ? setNamespace(e.target.value) : setKey(e.target.value)}
            placeholder={label === "Namespace" ? "e.g. user/preferences" : "e.g. theme"}
            disabled={isEdit}
          />
        </label>
      ))}
      <label className="block">
        <span className="text-xs text-fg-subtle mb-1 block">Value (JSON)</span>
        <TextArea
          className="font-mono h-28 resize-none"
          value={valueStr}
          onChange={(e) => setValueStr(e.target.value)}
          placeholder='{"key": "value"}'
        />
      </label>
      <DialogError message={error} />
    </Dialog>
  );
}
