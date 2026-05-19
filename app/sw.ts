/// <reference lib="webworker" />
// Service worker source for Jarela. @serwist/next compiles this to
// public/sw.js during `next build`. Replaces the previous next-pwa setup
// (next-pwa is webpack-only and unmaintained for Next 16+ / Turbopack).

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injected by Serwist at build time with the precache manifest.
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Pathname-based matchers. IMPORTANT: serwist's RegExpRoute matches against
// `url.href`, so an anchored pattern like /^\/api\/.../ would never fire for
// the cross-origin-looking full URL (https://host/api/...). Using function
// matchers against `url.pathname` is unambiguous and works the same on
// loopback, tailnet, and PWA contexts.
const isExactPath = (...paths: string[]) => ({ url }: { url: URL }) =>
  paths.includes(url.pathname);

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Endpoints that MUST NEVER be cached. /api/v1/health is the liveness
    // probe. Everything under /api/v1/threads/<id>/run is a streaming
    // endpoint (POST submit returns 202 JSON, GET returns an SSE stream
    // consumed via EventSource — see ADR-0008) that must not be served
    // from cache; the per-thread/agents/etc. POSTs aren't cacheable either.
    {
      matcher: isExactPath("/api/v1/health"),
      handler: new NetworkOnly(),
    },
    {
      // All POSTs go straight to network. Browsers don't cache POST
      // responses by default, but we want serwist out of the way entirely
      // so streaming bodies aren't intercepted.
      matcher: ({ request, url }) =>
        url.pathname.startsWith("/api/") && request.method !== "GET",
      handler: new NetworkOnly(),
    },
    {
      // The run endpoint's GET path is an SSE stream — NetworkOnly so the
      // SW does not try to clone/cache a never-ending response.
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/v1/threads/") &&
        url.pathname.endsWith("/run"),
      handler: new NetworkOnly(),
    },
    // All API GETs go straight to network. We're not building an offline
    // experience: the app is useless without the local server anyway. The
    // previous NetworkFirst+5s setup caused Safari PWA (esp. over Tailscale,
    // where the first request can take >5s) to silently fall back to a
    // stale cached payload — e.g. an empty agent list pinned for up to 24h
    // after a transient auth glitch. NetworkOnly removes the whole class
    // of bug.
    {
      matcher: ({ request, url }) =>
        url.pathname.startsWith("/api/") && request.method === "GET",
      handler: new NetworkOnly(),
    },
    // Serwist defaults handle static assets, Next.js data, fonts, images, etc.
    ...defaultCache,
  ],
});

serwist.addEventListeners();

// On activate, purge stale runtime API caches. Earlier SW versions cached
// /api/v1/agents, /api/v1/threads, /api/v1/memory etc. with NetworkFirst —
// which on Safari PWA over Tailscale would pin installed clients to an
// empty/stale payload for up to 24h after a transient auth glitch. Also
// purge legacy cached entries for endpoints that should NEVER be cached
// (/api/v1/health, streaming run endpoints, and the now-removed
// /api/v1/ws WS-URL discovery endpoint — ADR-0008).
const STALE_RUNTIME_CACHES = ["agents-cache", "threads-cache", "memory-cache"];
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(async (name) => {
      if (STALE_RUNTIME_CACHES.includes(name)) {
        await caches.delete(name);
        return;
      }
      const cache = await caches.open(name);
      const requests = await cache.keys();
      await Promise.all(requests.map((req) => {
        try {
          const u = new URL(req.url);
          if (
            u.pathname.startsWith("/api/") ||
            u.pathname === "/api/v1/health" ||
            u.pathname === "/api/v1/ws" /* legacy, removed in ADR-0008 */ ||
            (u.pathname.startsWith("/api/v1/threads/") && u.pathname.endsWith("/run"))
          ) {
            return cache.delete(req);
          }
        } catch { /* ignore */ }
        return Promise.resolve(false);
      }));
    }));
  })());
});
