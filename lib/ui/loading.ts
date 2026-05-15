"use client";
// Tiny global loading-state store. Any component can register itself as
// "currently busy"; the top-level progress bar reads the aggregate count and
// shows itself whenever count > 0. Module-level state is fine here — all
// usage is client-side and there's exactly one progress bar per page.
import { useEffect, useState } from "react";

let activeCount = 0;
const listeners = new Set<(n: number) => void>();

function notify() {
  for (const l of listeners) l(activeCount);
}

// Returns a cleanup function — call it when work finishes (or on effect unmount).
export function startLoading(): () => void {
  activeCount += 1;
  notify();
  let cleared = false;
  return () => {
    if (cleared) return;
    cleared = true;
    activeCount = Math.max(0, activeCount - 1);
    notify();
  };
}

// Subscribe to the aggregate count. Re-renders the caller when it changes.
export function useLoadingCount(): number {
  const [n, setN] = useState(activeCount);
  useEffect(() => {
    const fn = (v: number) => setN(v);
    listeners.add(fn);
    setN(activeCount);
    return () => { listeners.delete(fn); };
  }, []);
  return n;
}

// Convenience: tracks `active` automatically. When `active` flips true, register;
// when it flips false (or component unmounts), unregister.
export function useTrackLoading(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return startLoading();
  }, [active]);
}
