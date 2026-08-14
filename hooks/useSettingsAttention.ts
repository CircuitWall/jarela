"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import type { UnifiedHookResult } from "@/hooks/useListState";

// Bare-bones signal for "the operator has a critical gap in Settings".
// Drives a small red dot on the Settings menu tab and on individual
// sub-tab labels so first-time users can see at a glance where they
// still need to go — without having to read the toast banner.
//
// Critical = "the agent can't actually run yet". We intentionally do
// NOT probe per-credential health here (expensive, N HTTP calls every
// render). The deeper "this credential's last test failed" badge lives
// inside CredentialsListPanel where the probe data is already loaded.
export type SettingsAttention = {
  any: boolean;
  models: boolean;
  credentials: boolean;
};

const EMPTY: SettingsAttention = { any: false, models: false, credentials: false };

export function useSettingsAttention(): UnifiedHookResult<
  SettingsAttention,
  { refresh: () => Promise<void> }
> {
  const [state, setState] = useState<SettingsAttention>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      const [models, integrations] = await Promise.all([
        api.models.list(),
        api.integrations.list(),
      ]);
      const noModels = models.length === 0;
      const noCreds = !integrations.statuses.some((s) => s.configured);
      setState({
        any: noModels || noCreds,
        models: noModels,
        credentials: noCreds,
      });
    } catch {
      // Server unreachable — leave the indicator off rather than
      // flashing a false-positive every reconnect cycle.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChange = () => { void refresh(); };
    window.addEventListener("jarela:models-changed", onChange);
    window.addEventListener("jarela:credentials-changed", onChange);
    return () => {
      window.removeEventListener("jarela:models-changed", onChange);
      window.removeEventListener("jarela:credentials-changed", onChange);
    };
  }, [refresh]);

  const commands = { refresh };
  return { state, commands, ...state, refresh };
}
