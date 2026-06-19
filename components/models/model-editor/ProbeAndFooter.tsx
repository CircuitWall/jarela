import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { ModelEditorForm } from "./useModelEditorForm";

export function ProbeBanner({ result }: { result: ModelEditorForm["probeResult"] }) {
  if (!result) return null;
  const ok = result.ok;
  return (
    <div className={`text-xs flex items-start gap-1.5 px-2 py-1.5 rounded border ${
      ok
        ? "bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800 text-green-700 dark:text-green-300"
        : "bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800 text-red-700 dark:text-red-300"
    }`}>
      {ok ? <CheckCircle2 size={13} className="shrink-0 mt-0.5" /> : <XCircle size={13} className="shrink-0 mt-0.5" />}
      <span className="min-w-0 break-words">
        {ok ? "Connection OK — the model responded to a probe." : `Probe failed: ${result.error || "unknown error"}`}
      </span>
    </div>
  );
}

interface FooterProps {
  form: ModelEditorForm;
  onTest: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function EditorFooter({ form, onTest, onSave, onClose }: FooterProps) {
  return (
    <div className="flex flex-wrap justify-end gap-2 px-4 pb-4 pt-1 border-t border-border/60">
      <button
        onClick={onTest}
        disabled={form.probing || !form.modelId.trim()}
        className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg transition-colors inline-flex items-center gap-1.5 disabled:opacity-40"
      >
        {form.probing && <Loader2 size={13} className="animate-spin" />}
        {form.probing ? "Testing…" : "Test connection"}
      </button>
      <div className="flex-1" />
      <button onClick={onClose} className="px-3 py-1.5 text-sm text-fg-subtle hover:text-fg transition-colors">Cancel</button>
      <Button
        onClick={onSave}
        disabled={form.saving}
        size="lg"
      >
        {form.saving ? "Saving…" : form.allowSaveAnyway ? "Save anyway" : "Save"}
      </Button>
    </div>
  );
}
