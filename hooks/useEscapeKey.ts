import { useEffect } from "react";

/**
 * Listen for the Escape key at window scope and invoke `onEscape`.
 *
 * Used by modal/dialog editors that need a "press Escape to close" affordance.
 * Skip this when the dismiss should be focus-scoped — wire a local
 * `onKeyDown` on the element instead.
 */
export function useEscapeKey(onEscape: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape, enabled]);
}
