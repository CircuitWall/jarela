"use client";
import { useCallback, useEffect, useState } from "react";

// Category keys the chat-panel filter toolbar exposes. The first three map
// 1:1 to the persisted `messages.category` column. The last two are pure
// UI toggles that hide already-rendered sub-content (tool-event panels and
// the in-flight `thinking` line) without touching persistence.
export const MESSAGE_FILTER_KEYS = [
  "scheduled_task",
  "bridge",
  "synthetic",
  "tool_use",
  "thinking",
] as const;
export type MessageFilterKey = (typeof MESSAGE_FILTER_KEYS)[number];

export type MessageFilters = Record<MessageFilterKey, boolean>;

const STORAGE_KEY = "jarela:msg-category-filters";
const DEFAULTS: MessageFilters = {
  scheduled_task: true,
  bridge: true,
  synthetic: true,
  tool_use: true,
  thinking: true,
};

function readInitial(): MessageFilters {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<MessageFilters>;
    // Merge over defaults so newly-added keys in future builds stay visible
    // for users who already have a stored preference object.
    return { ...DEFAULTS, ...parsed };
  } catch {
    return DEFAULTS;
  }
}

// Hook: returns the current per-category visibility map plus a toggle.
// Persists to localStorage so the user's preference survives reloads and
// is shared across threads (this is a global chat-panel preference, not a
// per-thread one — same as message-density / theme).
export function useMessageFilters() {
  const [filters, setFilters] = useState<MessageFilters>(DEFAULTS);

  // Read after mount to avoid SSR/CSR hydration mismatches.
  useEffect(() => {
    setFilters(readInitial());
  }, []);

  const toggle = useCallback((key: MessageFilterKey) => {
    setFilters((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* private-mode quota or disabled storage — toggle still works in-session */
      }
      return next;
    });
  }, []);

  return { filters, toggle };
}
