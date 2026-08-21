"use client";
import { FolderOpen, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";
import type { SkillRepo } from "@/api/types";
import { FolderPickerDialog } from "@/components/documents/FolderPickerDialog";
import { errorMessage } from "@/lib/utils/error";

interface Props {
  repos: SkillRepo[];
  onChanged: () => void;
}

export function SkillRepoSection({ repos, onChanged }: Props) {
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const trimmedPath = path.trim();
    if (!trimmedPath) return;
    setError(null);
    try {
      await api.skills.repos.create({ path: trimmedPath, label: label.trim() || null });
      setPath("");
      setLabel("");
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [id]: true }));
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function remove(repo: SkillRepo) {
    if (!confirm(`Remove skill repo "${repo.label ?? repo.path}"? Files on disk are left untouched.`)) return;
    await withBusy(repo.id, () => api.skills.repos.delete(repo.id).then(() => undefined));
  }

  return (
    <section className="space-y-2">
      <label className="text-xs font-semibold text-fg-muted uppercase tracking-wide">Skill repos</label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex flex-1 min-w-0 gap-1">
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="Pick or paste an absolute path"
            className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg font-mono"
          />
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            title="Browse for a folder"
            className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-surface-3 border border-border text-xs text-fg hover:bg-surface-2 transition-colors"
          >
            <FolderOpen size={13} /> Browse
          </button>
        </div>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          className="sm:w-40 px-2.5 py-1.5 rounded-md bg-surface-2 border border-border text-sm text-fg"
        />
        <button
          onClick={() => void add()}
          disabled={!path.trim()}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50 hover:bg-accent-hover transition-colors"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      {pickerOpen && (
        <FolderPickerDialog
          initialPath={path.trim() || undefined}
          onClose={() => setPickerOpen(false)}
          onSelect={(picked) => { setPath(picked); setPickerOpen(false); }}
        />
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      {repos.length === 0 && (
        <p className="text-fg-faint text-xs italic">
          No skill repos yet. Add one above to write your own skills — the first repo you add becomes writable automatically.
        </p>
      )}

      {repos.map((r) => (
        <div key={r.id} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5 flex items-center gap-2">
          <FolderOpen size={13} className="text-fg-subtle shrink-0" />
          <span className="font-mono text-xs text-fg break-all flex-1">
            {r.label ? <strong>{r.label}</strong> : null}
            {r.label ? <span className="text-fg-faint"> — </span> : null}
            {r.path}
          </span>
          <button
            onClick={() => void withBusy(r.id, () => api.skills.repos.update(r.id, { writable: true }).then(() => undefined))}
            disabled={busy[r.id] || r.writable}
            title={r.writable ? "This is the writable repo — new/edited skills save here" : "Make this the writable repo"}
            className={r.writable
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-fg-faint hover:text-fg-subtle disabled:opacity-40"}
          >
            {r.writable ? <Pin size={13} /> : <PinOff size={13} />}
          </button>
          <label className="text-[11px] text-fg-faint flex items-center gap-1 select-none">
            <input
              type="checkbox"
              checked={r.enabled}
              disabled={busy[r.id]}
              onChange={() => void withBusy(r.id, () => api.skills.repos.update(r.id, { enabled: !r.enabled }).then(() => undefined))}
            />
            enabled
          </label>
          <button
            onClick={() => void remove(r)}
            disabled={busy[r.id]}
            title="Remove repo"
            className="p-1 text-fg-faint hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
    </section>
  );
}
