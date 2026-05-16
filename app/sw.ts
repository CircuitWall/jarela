/// <reference lib="webworker" />
// Service worker source for LangGUI. @serwist/next compiles this to
// public/sw.js during `next build`. Replaces the previous next-pwa setup
// (next-pwa is webpack-only and unmaintained for Next 16+ / Turbopack).

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist } from "serwist";

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
const startsWith = (prefix: string) => ({ url }: { url: URL }) =>
  url.pathname.startsWith(prefix);
const isExactPath = (...paths: string[]) => ({ url }: { url: URL }) =>
  paths.includes(url.pathname);

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Endpoints that MUST NEVER be cached. /api/v1/ws returns the live WS
    // upgrade URL — a stale cached response can wedge an installed PWA on a
    // previous deploy's endpoint. /api/v1/health is the liveness probe.
    // Everything under /api/v1/threads/<id>/run is a streaming response
    // (SSE POST or attach GET) that absolutely must not be served from
    // cache, and the per-thread/agents/etc. POSTs aren't cacheable either.
    {
      matcher: isExactPath("/api/v1/ws", "/api/v1/health"),
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
      // Any streaming run endpoint (SSE) — NetworkOnly so the SW does not
      // try to clone/cache a never-ending response.
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/v1/threads/") &&
        url.pathname.endsWith("/run"),
      handler: new NetworkOnly(),
    },
    // Read-only API GETs we want to keep usable offline for the PWA.
    {
      matcher: startsWith("/api/v1/threads"),
      handler: new NetworkFirst({
        cacheName: "threads-cache",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 }),
        ],
      }),
    },
    {
      matcher: startsWith("/api/v1/memory"),
      handler: new NetworkFirst({
        cacheName: "memory-cache",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 7 * 24 * 3600 }),
        ],
      }),
    },
    {
      matcher: startsWith("/api/v1/agents"),
      handler: new NetworkFirst({
        cacheName: "agents-cache",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 20, maxAgeSeconds: 24 * 3600 }),
        ],
      }),
    },
    // Serwist defaults handle static assets, Next.js data, fonts, images, etc.
    ...defaultCache,
  ],
});

serwist.addEventListeners();

// On activate, purge any cached entries for endpoints that should NEVER be
// cached. Earlier SW versions had a broken regex matcher that let serwist's
// defaultCache (apis-cache) capture /api/v1/ws responses, which then pinned
// installed PWAs to a stale WS URL even after redeploys. Iterate every
// cache once and evict matching entries.
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(async (name) => {
      const cache = await caches.open(name);
      const requests = await cache.keys();
      await Promise.all(requests.map((req) => {
        try {
          const u = new URL(req.url);
          if (
            u.pathname === "/api/v1/ws" ||
            u.pathname === "/api/v1/health" ||
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
