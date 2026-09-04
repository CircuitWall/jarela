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

// Convenience: tracks `active` automatically. When `active` flips true, register;
// when it flips false (or component unmounts), unregister.
export function useTrackLoading(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return startLoading();
  }, [active]);
}

// ---------------------------------------------------------------------------
// Activity label channel. Independent of the loading count: callers that
// want to surface a human-readable "what's happening right now" string
// (e.g. "thinking…", "using web_search") push onto a small stack. The
// header reads the top of the stack and renders it inline.
// ---------------------------------------------------------------------------

let activitySeq = 0;
const activityStack: Array<{ id: number; label: string; inflightTools: number }> = [];
const activityListeners = new Set<(state: ActivityState) => void>();

export interface ActivityState {
  label: string | null;
  // Tools currently executing. The header ring pauses its drain while this
  // is non-zero, mirroring the wall-clock accounting in run-registry.
  inflightTools: number;
}

const IDLE: ActivityState = { label: null, inflightTools: 0 };

function currentActivity(): ActivityState {
  const top = activityStack[activityStack.length - 1];
  return top ? { label: top.label, inflightTools: top.inflightTools } : IDLE;
}

function notifyActivity() {
  const top = currentActivity();
  for (const l of activityListeners) l(top);
}

// Push a label and return a setter+clearer for the same slot. The setter
// keeps the same stack id so updating a label (e.g. tool name changing
// mid-run) doesn't reorder layered activities. `clear` removes the slot.
export function pushActivity(label: string): {
  set: (next: string) => void;
  setInflightTools: (n: number) => void;
  clear: () => void;
} {
  const id = ++activitySeq;
  activityStack.push({ id, label, inflightTools: 0 });
  notifyActivity();
  return {
    set(next: string) {
      const slot = activityStack.find((s) => s.id === id);
      if (slot && slot.label !== next) {
        slot.label = next;
        notifyActivity();
      }
    },
    setInflightTools(n: number) {
      const slot = activityStack.find((s) => s.id === id);
      if (slot && slot.inflightTools !== n) {
        slot.inflightTools = n;
        notifyActivity();
      }
    },
    clear() {
      const idx = activityStack.findIndex((s) => s.id === id);
      if (idx >= 0) {
        activityStack.splice(idx, 1);
        notifyActivity();
      }
    },
  };
}

export function useActivity(): ActivityState {
  const [state, setState] = useState<ActivityState>(currentActivity);
  useEffect(() => {
    const fn = (v: ActivityState) => setState(v);
    activityListeners.add(fn);
    setState(currentActivity());
    return () => { activityListeners.delete(fn); };
  }, []);
  return state;
}

// Surface a labelled activity for as long as `active` holds. Lets load states
// (history, agent config, profile) report in the header rather than squatting
// in the composer placeholder, which should describe what typing will do.
export function useActivityWhile(active: boolean, label: string): void {
  useEffect(() => {
    if (!active) return;
    const slot = pushActivity(label);
    return () => slot.clear();
  }, [active, label]);
}
