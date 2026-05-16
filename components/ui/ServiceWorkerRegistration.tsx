"use client";

import { useEffect } from "react";

/**
 * Registers the Serwist-generated service worker. Replaces the auto-injected
 * registration script that next-pwa used to emit. Only runs in production
 * (the SW is disabled in dev by withSerwist).
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    // Defer to idle so we don't compete with the first paint.
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .catch((err) => {
          // Swallow — SW failures should never break the app.
          console.warn("[sw] registration failed:", err);
        });
    };
    if ("requestIdleCallback" in window) {
      (window as Window & { requestIdleCallback: (cb: () => void) => void })
        .requestIdleCallback(register);
    } else {
      setTimeout(register, 1000);
    }
  }, []);
  return null;
}
