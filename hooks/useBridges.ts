"use client";
import { useCallback } from "react";
import { api } from "@/api/client";
import type {
  Bridge,
  BridgeIn,
  BridgePatch,
  BridgeRoute,
  BridgeRouteIn,
  BridgeRoutePatch,
  BridgeIgnore,
  BridgeIgnoreIn,
} from "@/api/types";
import { useListState, type UnifiedHookResult } from "@/hooks/useListState";

export function useBridges(): UnifiedHookResult<
  { bridges: Bridge[]; loading: boolean; error: string | null },
  {
    refresh: () => Promise<void>;
    create: (data: BridgeIn) => Promise<Bridge>;
    update: (id: string, patch: BridgePatch) => Promise<Bridge>;
    remove: (id: string) => Promise<void>;
    pair: (id: string) => Promise<void>;
  }
> {
  const {
    items: bridges,
    setItems: setBridges,
    loading,
    error,
    refresh,
  } = useListState<Bridge>({
    loader: () => api.bridges.list(),
  });

  const create = useCallback(async (data: BridgeIn) => {
    const b = await api.bridges.create(data);
    setBridges((p) => [...p, b]);
    return b;
  }, [setBridges]);

  const update = useCallback(async (id: string, patch: BridgePatch) => {
    const b = await api.bridges.update(id, patch);
    setBridges((p) => p.map((x) => (x.id === id ? b : x)));
    return b;
  }, [setBridges]);

  const remove = useCallback(async (id: string) => {
    await api.bridges.delete(id);
    setBridges((p) => p.filter((x) => x.id !== id));
  }, [setBridges]);

  const pair = useCallback(async (id: string) => {
    await api.bridges.pair(id);
  }, []);

  const state = { bridges, loading, error };
  const commands = { refresh, create, update, remove, pair };

  return { state, commands, bridges, loading, error, refresh, create, update, remove, pair };
}

export function useBridgeRoutes(bridge_id: string | null): UnifiedHookResult<
  { routes: BridgeRoute[]; loading: boolean; error: string | null },
  {
    refresh: () => Promise<void>;
    create: (data: BridgeRouteIn) => Promise<BridgeRoute>;
    update: (route_id: string, patch: BridgeRoutePatch) => Promise<BridgeRoute>;
    remove: (route_id: string) => Promise<void>;
  }
> {
  const {
    items: routes,
    setItems: setRoutes,
    loading,
    error,
    refresh,
  } = useListState<BridgeRoute>({
    loader: () => api.bridges.routes.list(bridge_id!),
    enabled: !!bridge_id,
    onDisabled: () => setRoutes([]),
  });

  const create = useCallback(async (data: BridgeRouteIn) => {
    if (!bridge_id) throw new Error("No bridge selected");
    const r = await api.bridges.routes.create(bridge_id, data);
    setRoutes((p) => [...p, r]);
    return r;
  }, [bridge_id, setRoutes]);

  const update = useCallback(async (route_id: string, patch: BridgeRoutePatch) => {
    if (!bridge_id) throw new Error("No bridge selected");
    const r = await api.bridges.routes.update(bridge_id, route_id, patch);
    setRoutes((p) => p.map((x) => (x.id === route_id ? r : x)));
    return r;
  }, [bridge_id, setRoutes]);

  const remove = useCallback(async (route_id: string) => {
    if (!bridge_id) throw new Error("No bridge selected");
    await api.bridges.routes.delete(bridge_id, route_id);
    setRoutes((p) => p.filter((x) => x.id !== route_id));
  }, [bridge_id, setRoutes]);

  const state = { routes, loading, error };
  const commands = { refresh, create, update, remove };

  return { state, commands, routes, loading, error, refresh, create, update, remove };
}

/**
 * Per-bridge chat blocklist (see `BridgeIgnore` in api/types.ts). Chats
 * on this list are dropped by the router before any agent runs, so the
 * catch-all route effectively becomes "everything except these chats".
 */
export function useBridgeIgnores(bridge_id: string | null): UnifiedHookResult<
  { ignores: BridgeIgnore[]; loading: boolean; error: string | null },
  {
    refresh: () => Promise<void>;
    add: (data: BridgeIgnoreIn) => Promise<BridgeIgnore>;
    remove: (remote_jid: string) => Promise<void>;
  }
> {
  const {
    items: ignores,
    setItems: setIgnores,
    loading,
    error,
    refresh,
  } = useListState<BridgeIgnore>({
    loader: () => api.bridges.ignores.list(bridge_id!),
    enabled: !!bridge_id,
    onDisabled: () => setIgnores([]),
  });

  const add = useCallback(async (data: BridgeIgnoreIn) => {
    if (!bridge_id) throw new Error("No bridge selected");
    const r = await api.bridges.ignores.add(bridge_id, data);
    setIgnores((p) => (p.some((x) => x.remote_jid === r.remote_jid) ? p : [...p, r]));
    return r;
  }, [bridge_id, setIgnores]);

  const remove = useCallback(async (remote_jid: string) => {
    if (!bridge_id) throw new Error("No bridge selected");
    await api.bridges.ignores.remove(bridge_id, remote_jid);
    setIgnores((p) => p.filter((x) => x.remote_jid !== remote_jid));
  }, [bridge_id, setIgnores]);

  const state = { ignores, loading, error };
  const commands = { refresh, add, remove };

  return { state, commands, ignores, loading, error, refresh, add, remove };
}
