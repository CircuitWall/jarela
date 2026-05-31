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

    if (process.env.NODE_ENV !== "production") {
      // Dev mode safety: if a previous production build registered a SW,
      // it can keep serving stale assets even though SW is disabled now.
      // Purge registrations + caches once per tab session.
      const key = "jarela.dev.sw-cleaned";
      if (!window.sessionStorage.getItem(key)) {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((r) => r.unregister())))
          .catch(() => {
            /* ignore */
          });
        if ("caches" in window) {
          caches
            .keys()
            .then((names) => Promise.all(names.map((name) => caches.delete(name))))
            .catch(() => {
              /* ignore */
            });
        }
        window.sessionStorage.setItem(key, "1");
      }
      return;
    }

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
