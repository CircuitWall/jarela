// Imperative in-app confirmation. Replaces window.confirm so every
// destructive or discard prompt looks and behaves the same (and works in an
// installed PWA, where native dialogs are jarring or suppressed).
import { useSyncExternalStore } from "react";

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button; initial focus lands on Cancel. */
  destructive?: boolean;
}

export interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let nextId = 1;
let queue: PendingConfirm[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/** Resolves true on confirm, false on cancel / backdrop / Escape. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { ...options, id: nextId++, resolve }];
    emit();
  });
}

export function settleConfirm(id: number, ok: boolean): void {
  const item = queue.find((c) => c.id === id);
  if (!item) return;
  queue = queue.filter((c) => c.id !== id);
  emit();
  item.resolve(ok);
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const getSnapshot = () => queue[0] ?? null;

export function useActiveConfirm(): PendingConfirm | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
