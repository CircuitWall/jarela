/// <reference lib="webworker" />
// Service worker source for LangGUI. @serwist/next compiles this to
// public/sw.js during `next build`. Replaces the previous next-pwa setup
// (next-pwa is webpack-only and unmaintained for Next 16+ / Turbopack).

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { ExpirationPlugin, NetworkFirst, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    // Injected by Serwist at build time with the precache manifest.
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // Custom API caching — mirrors what next-pwa was configured with so the
    // installed PWA keeps a usable read-only view of recent threads / memory
    // / agents when the local server hasn't started yet.
    {
      matcher: /^\/api\/v1\/threads/,
      handler: new NetworkFirst({
        cacheName: "threads-cache",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 }),
        ],
      }),
    },
    {
      matcher: /^\/api\/v1\/memory/,
      handler: new NetworkFirst({
        cacheName: "memory-cache",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({ maxEntries: 500, maxAgeSeconds: 7 * 24 * 3600 }),
        ],
      }),
    },
    {
      matcher: /^\/api\/v1\/agents/,
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
