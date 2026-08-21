"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Dialog } from "@/components/ui/Dialog";
import { TextInput } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { MarkdownTextarea } from "@/components/ui/MarkdownTextarea";
import { errorMessage } from "@/lib/utils/error";

const ID_RE = /^[\w-]+$/;

export type SkillEditState =
  | { mode: "new" }
  | { mode: "edit"; id: string }
  | { mode: "clone"; sourceId: string };

interface Props {
  state: SkillEditState;
  onClose: () => void;
  onSaved: () => void;
}

export function SkillEditor({ state, onClose, onSaved }: Props) {
  const isEdit = state.mode === "edit";
  const [id, setId] = useState(state.mode === "clone" ? state.sourceId : state.mode === "edit" ? state.id : "");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(state.mode !== "new");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.mode === "new") return;
    const fetchId = state.mode === "clone" ? state.sourceId : state.id;
    setLoading(true);
    api.skills.get(fetchId)
      .then((skill) => setContent(skill.content))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  // Only re-run if the identity of what we're loading changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const idValid = ID_RE.test(id.trim());
  const canSave = idValid && content.trim().length > 0 && !loading && !saving;

  async function handleSave() {
    if (!canSave) return;
    setError(null);
    setSaving(true);
    try {
      if (isEdit) {
        await api.skills.update(id, content);
      } else {
        await api.skills.create({ id: id.trim(), content });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!isEdit) return;
    if (!confirm(`Delete skill "${id}"? This removes the file from the writable repo.`)) return;
    setSaving(true);
    try {
      await api.skills.delete(id);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={isEdit ? `Edit skill — ${id}` : state.mode === "clone" ? `Clone skill — ${state.sourceId}` : "New skill"}
      size="xl"
      align="top"
      footer={
        <div className="flex justify-between gap-2 px-4 pb-4">
          {isEdit ? (
            <button
              onClick={() => void handleDelete()}
              disabled={saving}
              className="px-3 py-1.5 text-sm text-red-700 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 transition-colors disabled:opacity-50"
            >
              Delete
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">
              Cancel
            </button>
            <Button onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3">
        <label className="block">
          <span className="text-xs text-fg-subtle mb-1 block">Skill ID (directory name)</span>
          <TextInput
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. code-review"
            maxLength={80}
            disabled={isEdit}
            className="font-mono"
          />
          {!isEdit && id.trim() && !idValid && (
            <span className="text-[11px] text-red-600 dark:text-red-400">Letters, digits, and hyphens only</span>
          )}
          {state.mode === "clone" && (
            <span className="text-[11px] text-fg-faint">
              Same id overrides the built-in in your writable repo; change it to keep both.
            </span>
          )}
        </label>
        <label className="block">
          <span className="text-xs text-fg-subtle mb-1 block">Content</span>
          {loading ? (
            <p className="text-fg-faint text-sm py-6 text-center">Loading…</p>
          ) : (
            <MarkdownTextarea
              className="w-full bg-surface text-fg text-xs rounded px-2 py-1.5 border border-border focus:outline-none focus:ring-1 focus:ring-accent resize-y"
              value={content}
              onChange={setContent}
              rows={18}
              monospace
              placeholder={"# Skill name\n\nDescription line(s), then the playbook body…"}
            />
          )}
        </label>
      </div>

      {error && <p className="text-red-700 dark:text-red-400 text-xs">{error}</p>}
    </Dialog>
  );
}
