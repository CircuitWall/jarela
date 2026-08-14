"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import type { UnifiedHookResult } from "@/hooks/useListState";

// When the user has opted in to location sharing, this hook acquires a
// browser geolocation fix and posts it to the server. It also watches for
// movement while the tab is open (watchPosition), so the agent's view of
// the user's location stays roughly fresh without manual refresh.
//
// Privacy:
//   - Nothing is requested or sent unless `consent` is true.
//   - Disabling consent clears stored coordinates server-side.
//   - We avoid high-accuracy mode by default — saves battery and is plenty
//     for "what's nearby" / weather use-cases. Caller can opt in.
export function useLocationSharing(
  consent: boolean,
  opts?: { highAccuracy?: boolean },
): UnifiedHookResult<
  { consent: boolean; watching: boolean; lastPostedAt: number | null; lastError: string | null },
  { clearSharedLocation: () => Promise<void> }
> {
  const lastPostedAt = useRef(0);
  const [watching, setWatching] = useState(false);
  const [lastPostedAtMs, setLastPostedAtMs] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const clearSharedLocation = useCallback(async () => {
    try {
      await api.profile.clearLocation();
      setLastError(null);
    } catch (err) {
      setLastError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!consent) {
      setWatching(false);
      void clearSharedLocation();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    const post = async (pos: GeolocationPosition) => {
      // Throttle: don't hammer the server faster than once every 30s.
      const t = Date.now();
      if (t - lastPostedAt.current < 30_000) return;
      lastPostedAt.current = t;
      setLastPostedAtMs(t);
      try {
        await api.profile.updateLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
        });
        setLastError(null);
      } catch (err) {
        setLastError(String(err));
        console.warn("[location] post failed:", err);
      }
    };

    const onError = (err: GeolocationPositionError) => {
      setLastError(err.message);
      console.warn("[location] geolocation error:", err.code, err.message);
    };

    // One-shot first fix (fast), then a watcher for updates.
    navigator.geolocation.getCurrentPosition(post, onError, {
      enableHighAccuracy: opts?.highAccuracy ?? false,
      maximumAge: 60_000,
      timeout: 15_000,
    });
    setWatching(true);
    const watchId = navigator.geolocation.watchPosition(post, onError, {
      enableHighAccuracy: opts?.highAccuracy ?? false,
      maximumAge: 60_000,
    });
    return () => {
      setWatching(false);
      navigator.geolocation.clearWatch(watchId);
    };
  }, [clearSharedLocation, consent, opts?.highAccuracy]);

  const state = {
    consent,
    watching,
    lastPostedAt: lastPostedAtMs,
    lastError,
  };
  const commands = { clearSharedLocation };

  return {
    state,
    commands,
    consent,
    watching,
    lastPostedAt: lastPostedAtMs,
    lastError,
    clearSharedLocation,
  };
}
