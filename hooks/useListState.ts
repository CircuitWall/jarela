"use client";
import { useCallback, useEffect, useState } from "react";

interface UseListStateOptions<T> {
  loader: () => Promise<T[]>;
  eventName?: string;
  eventLoader?: () => Promise<T[]>;
  enabled?: boolean;
  initialLoading?: boolean;
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
  eventLoader,
  enabled = true,
  initialLoading = false,
  onDisabled,
}: UseListStateOptions<T>): UseListStateResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(initialLoading);
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

  const refreshFromEvent = useCallback(async () => {
    if (!enabled) {
      onDisabled?.();
      return;
    }
    if (!eventLoader) {
      await refresh();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setItems(await eventLoader());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load list");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [enabled, eventLoader, onDisabled, refresh]);

  useEffect(() => {
    if (!eventName || typeof window === "undefined") return;
    const onChange = () => { void refresh(); };
    const onEvent = () => { void refreshFromEvent(); };
    window.addEventListener(eventName, eventLoader ? onEvent : onChange);
    return () => window.removeEventListener(eventName, eventLoader ? onEvent : onChange);
  }, [eventLoader, eventName, refresh, refreshFromEvent]);

  return { items, setItems, loading, error, refresh };
}
