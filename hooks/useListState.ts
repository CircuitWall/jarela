"use client";
import { useCallback, useEffect, useState } from "react";

interface UseListStateOptions<T> {
  loader: () => Promise<T[]>;
  eventName?: string;
  enabled?: boolean;
  onDisabled?: () => void;
}

interface UseListStateResult<T> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Shared async list state primitive used by UI hooks.
 *
 * Keeps the command/query surface consistent:
 * - `items` for current list snapshot
 * - `loading` and `error` as explicit query state
 * - `refresh()` as the single reload command
 */
export function useListState<T>({
  loader,
  eventName,
  enabled = true,
  onDisabled,
}: UseListStateOptions<T>): UseListStateResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      onDisabled?.();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await loader());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load list");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [enabled, loader, onDisabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!eventName || typeof window === "undefined") return;
    const onChange = () => { void refresh(); };
    window.addEventListener(eventName, onChange);
    return () => window.removeEventListener(eventName, onChange);
  }, [eventName, refresh]);

  return { items, setItems, loading, error, refresh };
}
