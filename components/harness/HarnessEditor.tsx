"use client";
import { ChevronDown, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEscapeKey } from "@/hooks/useEscapeKey";
import {
  DEFAULT_HARNESS_ID,
  HARNESS_SECTION_KEYS,
  SECTION_DISPLAY,
  type Harness,
  type HarnessIn,
  type HarnessPatch,
  type HarnessSection,
  type HarnessSectionKey,
} from "@/api/types";

interface Props {
  /** Undefined when creating a new custom harness. */
  harness?: Harness;
  /** Built-in harnesses, used as the source for the per-section "reset" button. */
  builtins: Harness[];
  onSave: (input: HarnessIn | HarnessPatch, id?: string) => Promise<void>;
  onClose: () => void;
}

function emptySections(): Record<HarnessSectionKey, HarnessSection> {
  return Object.fromEntries(
    HARNESS_SECTION_KEYS.map((k) => [k, { enabled: true, body: "" }]),
  ) as Record<HarnessSectionKey, HarnessSection>;
}

export function HarnessEditor({ harness, builtins, onSave, onClose }: Props) {
  const isEdit = !!harness;
  const [name, setName] = useState(harness?.name ?? "");
  const [description, setDescription] = useState(harness?.description ?? "");
  const [sections, setSections] = useState<Record<HarnessSectionKey, HarnessSection>>(() => {
    if (!harness) {
      // Seed a new harness from the built-in default so users see something to edit.
      const seed = builtins.find((b) => b.id === DEFAULT_HARNESS_ID) ?? builtins[0];
      if (seed) {
        return Object.fromEntries(
          HARNESS_SECTION_KEYS.map((k) => [k, { ...seed.sections[k] }]),
        ) as Record<HarnessSectionKey, HarnessSection>;
      }
      return emptySections();
    }
    return Object.fromEntries(
      HARNESS_SECTION_KEYS.map((k) => [k, { ...harness.sections[k] }]),
    ) as Record<HarnessSectionKey, HarnessSection>;
  });
  const [openSection, setOpenSection] = useState<HarnessSectionKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const builtinDefault = useMemo(
    () => builtins.find((b) => b.id === DEFAULT_HARNESS_ID),
    [builtins],
  );

  useEscapeKey(onClose);

  function patchSection(key: HarnessSectionKey, patch: Partial<HarnessSection>) {
    setSections((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function resetSection(key: HarnessSectionKey) {
    if (!builtinDefault) return;
    patchSection(key, { ...builtinDefault.sections[key] });
  }

  async function handleSave() {
    setError(null);
    if (!name.trim()) { setError("Name is required"); return; }
    setSaving(true);
    try {
      const payload: HarnessIn | HarnessPatch = {
        name: name.trim(),
        description: description.trim() || undefined,
        sections,
      };
      await onSave(payload, harness?.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-2 sm:p-4 overflow-y-auto">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-2xl shadow-xl my-2 sm:my-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-fg">
            {isEdit ? `Edit harness — ${harness?.name}` : "New harness"}
          </h3>
          <button onClick={onClose} className="text-fg-subtle hover:text-fg transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-1 gap-3">
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Name</span>
              <input
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. strict-citation"
                maxLength={120}
              />
            </label>
            <label className="block">
              <span className="text-xs text-fg-subtle mb-1 block">Description</span>
              <input
                className="w-full bg-surface-3 text-fg text-sm rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Shown in the picker"
                maxLength={500}
              />
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-xs text-fg-subtle">Sections</p>
            {HARNESS_SECTION_KEYS.map((key) => {
              const section = sections[key];
              const display = SECTION_DISPLAY[key];
              const isOpen = openSection === key;
              return (
                <div key={key} className="border border-border rounded-lg bg-surface-3 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <input
                      type="checkbox"
                      className="rounded border-border"
                      checked={section.enabled}
                      onChange={(e) => patchSection(key, { enabled: e.target.checked })}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <button
                      type="button"
                      onClick={() => setOpenSection(isOpen ? null : key)}
                      className="flex-1 flex items-center gap-2 text-left min-w-0"
                    >
                      <ChevronDown
                        size={12}
                        className={`shrink-0 transition-transform ${isOpen ? "rotate-0" : "-rotate-90"}`}
                      />
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-fg truncate">{display.title}</p>
                        <p className="text-[11px] text-fg-faint truncate">{display.hint}</p>
                      </div>
                    </button>
                    {builtinDefault && (
                      <button
                        type="button"
                        onClick={() => resetSection(key)}
                        title="Reset to built-in default"
                        className="p-1 text-fg-subtle hover:text-fg transition-colors shrink-0"
                      >
                        <RotateCcw size={11} />
                      </button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="px-3 pb-3">
                      <textarea
                        className="w-full bg-surface text-fg text-xs rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent font-mono resize-y"
                        value={section.body}
                        onChange={(e) => patchSection(key, { body: e.target.value })}
                        rows={10}
                        placeholder="Section body…"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 px-4 pb-4">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">
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
