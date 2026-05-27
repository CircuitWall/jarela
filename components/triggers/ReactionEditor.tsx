"use client";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { pushErrorToast } from "@/lib/ui/error-report";

// Shared reaction-discriminator UI for triggers (ADR-0031 + ADR-0032).
// - `KindPill`             — small pill button used for the agent_prompt /
//                            script toggle.
// - `ReactionScriptEditor` — kind='script' editor: pick a registered
//                            reaction.* script + edit JSON args. Pass
//                            `diffContext={true}` for watchers (where
//                            previous/current are auto-merged) and
//                            `false` for scheduled tasks.
//
// The agent_prompt branch differs per target (watchers use a dedicated
// reaction_prompt column; scheduled tasks reuse their existing prompt
// field), so each caller still renders its own prompt editor inline. This
// module only owns the parts that genuinely repeat: the kind toggle and
// the script editor.

const REACTION_SCRIPT_ARGS_MAX = 4000;

export function KindPill({
  active, onClick, disabled, title, children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={
        "px-2 py-0.5 text-[10px] rounded border transition-colors disabled:opacity-50 " +
        (active
          ? "border-fg-muted bg-surface-3 text-fg"
          : "border-border text-fg-faint hover:text-fg hover:border-fg-muted")
      }
    >
      {children}
    </button>
  );
}

export interface ReactionScriptEditorProps {
  initialScript: string | null;
  initialArgs: unknown | null;
  /** Called when the user saves a valid script + args. */
  onSave: (next: { script: string; args: Record<string, unknown> | null }) => Promise<void>;
  /** Context tag forwarded to error toasts so the reporter can identify the panel. */
  errorContext: Record<string, unknown>;
  /** True for watchers (diff context auto-merged); false for scheduled tasks. */
  diffContext: boolean;
}

export function ReactionScriptEditor({
  initialScript, initialArgs, onSave, errorContext, diffContext,
}: ReactionScriptEditorProps) {
  const [scripts, setScripts] = useState<string[] | null>(null);
  const initialArgsText = useMemo(() => {
    if (initialArgs === null || initialArgs === undefined) return "";
    try { return JSON.stringify(initialArgs, null, 2); } catch { return ""; }
  }, [initialArgs]);

  const [script, setScript] = useState(initialScript ?? "");
  const [argsText, setArgsText] = useState(initialArgsText);
  const [saving, setSaving] = useState(false);
  const [argsError, setArgsError] = useState<string | null>(null);

  useEffect(() => { setScript(initialScript ?? ""); }, [initialScript]);
  useEffect(() => { setArgsText(initialArgsText); }, [initialArgsText]);

  useEffect(() => {
    let alive = true;
    api.watchers.listReactionScripts()
      .then((r) => { if (alive) setScripts(r.scripts); })
      .catch((e) => {
        if (!alive) return;
        console.error(e);
        setScripts([]);
      });
    return () => { alive = false; };
  }, []);

  function validateArgs(text: string): { value: Record<string, unknown> | null; error: string | null } {
    const trimmed = text.trim();
    if (!trimmed) return { value: null, error: null };
    if (trimmed.length > REACTION_SCRIPT_ARGS_MAX) {
      return { value: null, error: `Args JSON too long (${trimmed.length}/${REACTION_SCRIPT_ARGS_MAX} chars)` };
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { value: null, error: "Args must be a JSON object" };
      }
      return { value: parsed as Record<string, unknown>, error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : "Invalid JSON" };
    }
  }

  const dirty = script !== (initialScript ?? "") || argsText.trim() !== initialArgsText.trim();

  async function save() {
    const { value, error } = validateArgs(argsText);
    if (error) { setArgsError(error); return; }
    setArgsError(null);
    if (!script.trim()) {
      setArgsError("Pick a reaction script first.");
      return;
    }
    setSaving(true);
    try {
      await onSave({ script, args: value });
    } catch (e) {
      pushErrorToast({
        title: "Couldn't save reaction script",
        error: e,
        context: { ...errorContext, script },
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1">
      <select
        value={script}
        onChange={(e) => setScript(e.target.value)}
        className="w-full text-[11px] font-mono rounded border border-border bg-surface-1 px-2 py-1 text-fg-muted focus:outline-none focus:border-fg-muted"
      >
        <option value="">— pick a reaction script —</option>
        {scripts?.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>
      <textarea
        value={argsText}
        onChange={(e) => { setArgsText(e.target.value); if (argsError) setArgsError(null); }}
        rows={3}
        placeholder='Optional args JSON, e.g. { "title": "Trigger fired", "level": "warning" }'
        className="w-full text-[11px] font-mono rounded border border-border bg-surface-1 px-2 py-1 text-fg-muted focus:outline-none focus:border-fg-muted resize-y"
      />
      <div className="flex items-center gap-2 text-[10px] text-fg-faint">
        {argsError ? (
          <span className="text-rose-700 dark:text-rose-400">{argsError}</span>
        ) : diffContext ? (
          <span>
            Diff context (<code>watcher</code>, <code>previous</code>, <code>current</code>) is auto-merged.
          </span>
        ) : (
          <span>
            A <code>task</code> descriptor is auto-merged. Diff context (<code>previous</code>/<code>current</code>) is watcher-only.
          </span>
        )}
        <button
          onClick={() => void save()}
          disabled={saving || !dirty}
          className="ml-auto px-2 py-0.5 rounded border border-border hover:text-emerald-700 dark:hover:text-emerald-400 hover:border-emerald-700 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
