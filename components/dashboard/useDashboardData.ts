"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DashboardMetrics } from "@/api/types";
import type { WindowDays } from "./dashboard-constants";

export interface UseDashboardDataResult {
  days: WindowDays;
  setDays: (d: WindowDays) => void;
  loading: boolean;
  error: string | null;
  data: DashboardMetrics | null;
  refreshingPricing: boolean;
  refreshHint: string | null;
  onRefreshPricing: () => Promise<void>;
}

export function useDashboardData(initialDays: WindowDays = 30): UseDashboardDataResult {
  const [days, setDays] = useState<WindowDays>(initialDays);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const [refreshHint, setRefreshHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.dashboard.metrics(days)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const onRefreshPricing = async () => {
    setRefreshingPricing(true);
    setRefreshHint(null);
    try {
      const res = await api.dashboard.refreshPricing({ force: true });
      setRefreshHint(res.refreshed ? "Pricing snapshot refreshed." : "Pricing snapshot already fresh.");
      setLoading(true);
      setError(null);
      const metrics = await api.dashboard.metrics(days);
      setData(metrics);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to refresh pricing.";
      setRefreshHint(message);
      setError(message);
    } finally {
      setLoading(false);
      setRefreshingPricing(false);
    }
  };

  return { days, setDays, loading, error, data, refreshingPricing, refreshHint, onRefreshPricing };
}
