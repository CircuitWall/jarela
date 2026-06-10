"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DashboardCurrencyInfo, UserProfile } from "@/api/types";
import { CURRENCY_MODE_KEY, CURRENCY_PICK_KEY, USD_CURRENCY, type CurrencyMode } from "./dashboard-constants";

export interface UseCurrencyPreferenceResult {
  currencyInfo: DashboardCurrencyInfo;
  currencyMode: CurrencyMode;
  setCurrencyMode: (m: CurrencyMode) => void;
  manualCurrency: string;
  setManualCurrency: (c: string) => void;
}

export function useCurrencyPreference(): UseCurrencyPreferenceResult {
  const [currencyInfo, setCurrencyInfo] = useState<DashboardCurrencyInfo>(USD_CURRENCY);
  const [currencyMode, setCurrencyMode] = useState<CurrencyMode>("auto");
  const [manualCurrency, setManualCurrency] = useState<string>("USD");
  const [profileLocation, setProfileLocation] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });

  useEffect(() => {
    try {
      const savedMode = window.localStorage.getItem(CURRENCY_MODE_KEY);
      if (savedMode === "auto" || savedMode === "manual") setCurrencyMode(savedMode);
      const savedCurrency = window.localStorage.getItem(CURRENCY_PICK_KEY);
      if (savedCurrency && /^[A-Z]{3}$/.test(savedCurrency)) setManualCurrency(savedCurrency);
    } catch { /* ignore storage failures */ }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CURRENCY_MODE_KEY, currencyMode);
      window.localStorage.setItem(CURRENCY_PICK_KEY, manualCurrency);
    } catch { /* ignore storage failures */ }
  }, [currencyMode, manualCurrency]);

  useEffect(() => {
    let cancelled = false;
    api.profile.get()
      .then((profile: UserProfile) => {
        if (cancelled) return;
        setProfileLocation({
          lat: Number.isFinite(profile.location_lat) ? (profile.location_lat as number) : null,
          lng: Number.isFinite(profile.location_lng) ? (profile.location_lng as number) : null,
        });
      })
      .catch(() => { if (!cancelled) setProfileLocation({ lat: null, lng: null }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (currencyMode === "manual") {
      api.dashboard.currency({ currency: manualCurrency })
        .then((resolved) => { if (!cancelled) setCurrencyInfo(resolved); })
        .catch(() => { if (!cancelled) setCurrencyInfo(USD_CURRENCY); });
      return () => { cancelled = true; };
    }
    if (!Number.isFinite(profileLocation.lat) || !Number.isFinite(profileLocation.lng)) {
      setCurrencyInfo(USD_CURRENCY);
      return () => { cancelled = true; };
    }
    api.dashboard.currency({ lat: profileLocation.lat, lng: profileLocation.lng })
      .then((resolved) => { if (!cancelled) setCurrencyInfo(resolved); })
      .catch(() => { if (!cancelled) setCurrencyInfo(USD_CURRENCY); });
    return () => { cancelled = true; };
  }, [currencyMode, manualCurrency, profileLocation.lat, profileLocation.lng]);

  return { currencyInfo, currencyMode, setCurrencyMode, manualCurrency, setManualCurrency };
}
