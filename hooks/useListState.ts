"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseListStateOptions<T> {
  loader: () => Promise<T[]>;
  eventName?: string;
  eventLoader?: () => Promise<T[]>;
  enabled?: boolean;
  initialLoading?: boolean;
  onDisabled?: () => void;
}

export interface UseListStateResult<T> {
  items: T[];
  setItems: React.Dispatch<React.SetStateAction<T[]>>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export type UnifiedHookResult<TState extends object, TCommands extends object> = {
  state: TState;
  commands: TCommands;
} & TState & TCommands;

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
  const loaderRef = useRef(loader);
  const eventLoaderRef = useRef(eventLoader);
  const onDisabledRef = useRef(onDisabled);
  const requestIdRef = useRef(0);

  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  useEffect(() => {
    eventLoaderRef.current = eventLoader;
  }, [eventLoader]);

  useEffect(() => {
    onDisabledRef.current = onDisabled;
  }, [onDisabled]);

  const refresh = useCallback(async () => {
    if (!enabled) {
      requestIdRef.current += 1;
      onDisabledRef.current?.();
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextItems = await loaderRef.current();
      if (requestId === requestIdRef.current) setItems(nextItems);
    } catch (e) {
      if (requestId === requestIdRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load list");
        setItems([]);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshFromEvent = useCallback(async () => {
    if (!enabled) {
      requestIdRef.current += 1;
      onDisabledRef.current?.();
      return;
    }
    if (!eventLoaderRef.current) {
      await refresh();
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const nextItems = await eventLoaderRef.current();
      if (requestId === requestIdRef.current) setItems(nextItems);
    } catch (e) {
      if (requestId === requestIdRef.current) {
        setError(e instanceof Error ? e.message : "Failed to load list");
        setItems([]);
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [enabled, refresh]);

  useEffect(() => {
    if (!eventName || typeof window === "undefined") return;
    const hasEventLoader = Boolean(eventLoaderRef.current);
    const onChange = () => { void refresh(); };
    const onEvent = () => { void refreshFromEvent(); };
    window.addEventListener(eventName, hasEventLoader ? onEvent : onChange);
    return () => window.removeEventListener(eventName, hasEventLoader ? onEvent : onChange);
  }, [eventName, refresh, refreshFromEvent]);

  return { items, setItems, loading, error, refresh };
}
