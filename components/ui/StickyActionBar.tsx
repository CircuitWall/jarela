import type { ReactNode } from "react";
import { Button } from "./Button";

// Pinned Save/Discard bar for inline (non-modal) forms. Sticks to the bottom
// of the nearest scroll container and only appears once there is something to
// save, so edits made at the top never require scrolling down to commit them.
export function StickyActionBar({
  dirty,
  saving = false,
  canSave = true,
  onSave,
  onDiscard,
  saveLabel = "Save",
  message,
}: {
  dirty: boolean;
  saving?: boolean;
  canSave?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  message?: ReactNode;
}) {
  if (!dirty && !saving) return null;
  return (
    <div
      className="sticky bottom-0 z-10 -mx-4 mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface-2/95 px-4 py-2.5 backdrop-blur"
      style={{ paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))" }}
    >
      <span role="status" className="text-[11px] text-amber-700 dark:text-amber-300">
        {message ?? "Unsaved changes"}
      </span>
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>Discard</Button>
        <Button onClick={onSave} disabled={saving || !canSave}>{saving ? "Saving…" : saveLabel}</Button>
      </div>
    </div>
  );
}
