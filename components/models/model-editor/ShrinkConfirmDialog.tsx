import { Loader2 } from "lucide-react";
import type { ModelEditorForm } from "./useModelEditorForm";

interface Props {
  form: ModelEditorForm;
  onConfirm: () => void;
  onSkip: () => void;
}

export function ShrinkConfirmDialog({ form, onConfirm, onSkip }: Props) {
  const pending = form.pendingShrinkConfirm;
  if (!pending) return null;
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
      <div className="bg-surface-2 border border-border rounded-2xl w-full max-w-md shadow-2xl p-5 space-y-3">
        <h4 className="text-sm font-semibold text-fg">Compact threads first?</h4>
        <p className="text-xs text-fg-muted leading-relaxed">
          You&apos;re switching <span className="font-mono">{pending.payloadName}</span> from{" "}
          <span className="font-mono">{pending.oldSnapshot.model_id}</span> to{" "}
          <span className="font-mono">{pending.payload.model_id}</span>. The new model may have a smaller
          context window. To avoid the next turn failing, Jarela can summarize older messages now using the
          previous model, then complete the swap.
        </p>
        <p className="text-[11px] text-fg-faint">Other actions are blocked while compaction runs.</p>
        <DialogActions form={form} onConfirm={onConfirm} onSkip={onSkip} />
      </div>
    </div>
  );
}

function DialogActions({ form, onConfirm, onSkip }: Props) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button
        onClick={() => form.setPendingShrinkConfirm(null)}
        disabled={form.compacting}
        className="px-3 py-1.5 text-xs text-fg-subtle hover:text-fg transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={onSkip}
        disabled={form.compacting || form.saving}
        className="px-3 py-1.5 text-xs text-fg-muted hover:text-fg transition-colors"
      >
        Skip &amp; save anyway
      </button>
      <button
        onClick={onConfirm}
        disabled={form.compacting}
        className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-xl shadow-sm transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
      >
        {form.compacting && <Loader2 size={12} className="animate-spin" />}
        {form.compacting ? "Compacting…" : "Compact & save"}
      </button>
    </div>
  );
}
