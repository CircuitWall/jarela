import { useCallback, useEffect, useState } from "react";
import { confirmAction } from "@/lib/ui/confirm";

/**
 * Tracks whether `value` differs from its first settled snapshot. Pass
 * `ready=false` while async data is still loading so the snapshot is taken
 * after it arrives rather than before. Change `baselineKey` (e.g. the saved
 * server copy) to re-take the snapshot after a successful save.
 */
export function useDirty(value: unknown, ready = true, baselineKey?: unknown): boolean {
  const json = JSON.stringify(value);
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => { setBase(null); }, [baselineKey]);
  useEffect(() => {
    if (ready && base === null) setBase(json);
  }, [ready, base, json]);
  return base !== null && base !== json;
}

/**
 * The one dismissal rule for modal editors. Backdrop click, Escape, the X
 * button and Cancel must all call the returned function: it ignores the
 * request while saving, closes immediately when clean, and asks before
 * discarding unsaved edits.
 */
export function useDismissGuard({ dirty, busy = false, onClose }: { dirty: boolean; busy?: boolean; onClose: () => void }): (after?: unknown) => void {
  return useCallback((after?: unknown) => {
    // Also used directly as an event handler, so ignore non-function arguments.
    const done = () => { onClose(); if (typeof after === "function") after(); };
    if (busy) return;
    if (!dirty) { done(); return; }
    void confirmAction({
      title: "Discard changes?",
      message: "Your edits have not been saved.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    }).then((ok) => { if (ok) done(); });
  }, [dirty, busy, onClose]);
}
