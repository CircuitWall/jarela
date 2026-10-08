import type { ReactNode } from "react";
import { Button } from "./Button";

// Standard editor footer, pinned by Dialog so it never scrolls away.
// Clean: [start ...... Cancel Save]. Dirty: an "Unsaved changes" note appears
// and Cancel becomes Discard (explicit intent, so no second prompt).
export function DialogFooter({
  onCancel,
  onSave,
  onDiscard,
  dirty = false,
  saving = false,
  canSave = true,
  saveLabel = "Save",
  start,
}: {
  /** Guarded close (see useDismissGuard). */
  onCancel: () => void;
  onSave: () => void;
  /** Raw close, used by the Discard button while dirty. */
  onDiscard?: () => void;
  dirty?: boolean;
  saving?: boolean;
  canSave?: boolean;
  saveLabel?: string;
  start?: ReactNode;
}) {
  const discarding = dirty && !!onDiscard;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-4">
      {start && <div className="min-w-0">{start}</div>}
      {dirty && <span role="status" className="text-[11px] text-amber-700 dark:text-amber-300">Unsaved changes</span>}
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" onClick={discarding ? onDiscard : onCancel} disabled={saving}>
          {discarding ? "Discard" : "Cancel"}
        </Button>
        <Button onClick={onSave} disabled={saving || !canSave}>
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </div>
  );
}

// Inline save error, shown at the bottom of the dialog body.
export function DialogError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="text-red-700 dark:text-red-400 text-xs">{message}</p>;
}
