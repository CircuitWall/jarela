"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { Bridge, BridgeIn, BridgePatch, BridgeRoute, BridgeRouteIn, BridgeRoutePatch } from "@/api/types";

export function useBridges() {
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setBridges(await api.bridges.list()); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (data: BridgeIn) => {
    const b = await api.bridges.create(data);
    setBridges((p) => [...p, b]);
    return b;
  }, []);

  const update = useCallback(async (id: string, patch: BridgePatch) => {
    const b = await api.bridges.update(id, patch);
    setBridges((p) => p.map((x) => (x.id === id ? b : x)));
    return b;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.bridges.delete(id);
    setBridges((p) => p.filter((x) => x.id !== id));
  }, []);

  const pair = useCallback(async (id: string) => {
    await api.bridges.pair(id);
  }, []);

  return { bridges, loading, refresh, create, update, remove, pair };
}

export function useBridgeRoutes(bridge_id: string | null) {
  const [routes, setRoutes] = useState<BridgeRoute[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!bridge_id) { setRoutes([]); return; }
    setLoading(true);
    try { setRoutes(await api.bridges.routes.list(bridge_id)); }
    finally { setLoading(false); }
  }, [bridge_id]);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback(async (data: BridgeRouteIn) => {
    if (!bridge_id) throw new Error("No bridge selected");
    const r = await api.bridges.routes.create(bridge_id, data);
    setRoutes((p) => [...p, r]);
    return r;
  }, [bridge_id]);

  const update = useCallback(async (route_id: string, patch: BridgeRoutePatch) => {
    if (!bridge_id) throw new Error("No bridge selected");
    const r = await api.bridges.routes.update(bridge_id, route_id, patch);
    setRoutes((p) => p.map((x) => (x.id === route_id ? r : x)));
    return r;
  }, [bridge_id]);

  const remove = useCallback(async (route_id: string) => {
    if (!bridge_id) throw new Error("No bridge selected");
    await api.bridges.routes.delete(bridge_id, route_id);
    setRoutes((p) => p.filter((x) => x.id !== route_id));
  }, [bridge_id]);

  return { routes, loading, refresh, create, update, remove };
}
