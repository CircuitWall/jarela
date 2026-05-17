"use client";
import { useEffect, useRef } from "react";
import { api } from "@/api/client";

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
export function useLocationSharing(consent: boolean, opts?: { highAccuracy?: boolean }) {
  const lastPostedAt = useRef(0);

  useEffect(() => {
    if (!consent) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;

    const post = async (pos: GeolocationPosition) => {
      // Throttle: don't hammer the server faster than once every 30s.
      const t = Date.now();
      if (t - lastPostedAt.current < 30_000) return;
      lastPostedAt.current = t;
      try {
        await api.profile.updateLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
        });
      } catch (err) {
        console.warn("[location] post failed:", err);
      }
    };

    const onError = (err: GeolocationPositionError) => {
      console.warn("[location] geolocation error:", err.code, err.message);
    };

    // One-shot first fix (fast), then a watcher for updates.
    navigator.geolocation.getCurrentPosition(post, onError, {
      enableHighAccuracy: opts?.highAccuracy ?? false,
      maximumAge: 60_000,
      timeout: 15_000,
    });
    const watchId = navigator.geolocation.watchPosition(post, onError, {
      enableHighAccuracy: opts?.highAccuracy ?? false,
      maximumAge: 60_000,
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, [consent, opts?.highAccuracy]);
}
