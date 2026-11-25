"use client";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import type { DashboardCurrencyInfo, UserProfile } from "@/api/types";
import { readBrowserValue, writeBrowserValue } from "@/lib/ui/browser-store";
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
    const savedMode = readBrowserValue(CURRENCY_MODE_KEY);
    if (savedMode === "auto" || savedMode === "manual") setCurrencyMode(savedMode);
    const savedCurrency = readBrowserValue(CURRENCY_PICK_KEY);
    if (savedCurrency && /^[A-Z]{3}$/.test(savedCurrency)) setManualCurrency(savedCurrency);
  }, []);

  useEffect(() => {
    writeBrowserValue(CURRENCY_MODE_KEY, currencyMode);
    writeBrowserValue(CURRENCY_PICK_KEY, manualCurrency);
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
    const hasLocation = Number.isFinite(profileLocation.lat) && Number.isFinite(profileLocation.lng);
    const country = hasLocation ? null : detectBrowserCountry();
    api.dashboard.currency(
      hasLocation
        ? { lat: profileLocation.lat, lng: profileLocation.lng }
        : { country },
    )
      .then((resolved) => { if (!cancelled) setCurrencyInfo(resolved); })
      .catch(() => { if (!cancelled) setCurrencyInfo(USD_CURRENCY); });
    return () => { cancelled = true; };
  }, [currencyMode, manualCurrency, profileLocation.lat, profileLocation.lng]);

  return { currencyInfo, currencyMode, setCurrencyMode, manualCurrency, setManualCurrency };
}

function detectBrowserCountry(): string | null {
  if (typeof navigator === "undefined") return null;
  const candidates = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const tag of candidates) {
    try {
      const region = new Intl.Locale(tag).maximize().region;
      if (region && /^[A-Z]{2}$/.test(region)) return region;
    } catch {
      const match = /[-_]([A-Za-z]{2})\b/.exec(tag);
      if (match) return match[1].toUpperCase();
    }
  }
  return null;
}
