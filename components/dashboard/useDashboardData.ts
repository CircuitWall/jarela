"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DashboardMetrics, DashboardPricingTaskStatus } from "@/api/types";
import type { WindowDays } from "./dashboard-constants";
import { errorMessage } from "@/lib/utils/error";

export interface UseDashboardDataResult {
  days: WindowDays;
  setDays: (d: WindowDays) => void;
  loading: boolean;
  error: string | null;
  data: DashboardMetrics | null;
  refreshingPricing: boolean;
  refreshHint: string | null;
  onRefreshPricing: () => Promise<void>;
  pricingTask: DashboardPricingTaskStatus | null;
  settingUpPricingTask: boolean;
  pricingTaskHint: string | null;
  onSetupPricingTask: () => Promise<void>;
}

export function useDashboardData(initialDays: WindowDays = 30): UseDashboardDataResult {
  const [days, setDays] = useState<WindowDays>(initialDays);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<DashboardMetrics | null>(null);
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const [refreshHint, setRefreshHint] = useState<string | null>(null);
  const [pricingTask, setPricingTask] = useState<DashboardPricingTaskStatus | null>(null);
  const [settingUpPricingTask, setSettingUpPricingTask] = useState(false);
  const [pricingTaskHint, setPricingTaskHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.dashboard.metrics(days)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err: unknown) => { if (!cancelled) setError(errorMessage(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    api.dashboard.pricingTask()
      .then((status) => { if (!cancelled) setPricingTask(status); })
      .catch((err: unknown) => { if (!cancelled) setPricingTaskHint(errorMessage(err)); });
    return () => { cancelled = true; };
  }, []);

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

  const onSetupPricingTask = async () => {
    setSettingUpPricingTask(true);
    setPricingTaskHint(null);
    try {
      const status = await api.dashboard.setupPricingTask();
      setPricingTask(status);
      const nextRun = status.next_run_at
        ? new Intl.DateTimeFormat(undefined, {
            weekday: "long",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: status.time_zone,
          }).format(new Date(status.next_run_at))
        : "next week";
      setPricingTaskHint(`Weekly pricing updates are scheduled for ${nextRun} (${status.time_zone}).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to set up weekly pricing updates.";
      setPricingTaskHint(message);
    } finally {
      setSettingUpPricingTask(false);
    }
  };

  return {
    days, setDays, loading, error, data, refreshingPricing, refreshHint, onRefreshPricing,
    pricingTask, settingUpPricingTask, pricingTaskHint, onSetupPricingTask,
  };
}
