import type { NextConfig } from "next";
// @ts-expect-error next-pwa has no types
import withPWA from "next-pwa";

const nextConfig: NextConfig = {
  // Pin the workspace root to *this* project. Without this, Next walks up
  // looking for a lockfile and trips over the parent ../package-lock.json,
  // emitting a "multiple lockfiles detected" warning every build.
  outputFileTracingRoot: __dirname,
  // Emit a self-contained .next/standalone/ tree (server.js + the minimum
  // node_modules subset Next traced as required). This is what we copy into
  // %LOCALAPPDATA%\Programs\LangGUI for the installed app — no repo or
  // `npm install` needed at runtime.
  output: "standalone",
  webpack(config, { isServer }) {
    if (isServer) {
      // ws native addons (bufferutil, utf-8-validate) must not be bundled by webpack
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        "bufferutil",
        "utf-8-validate",
      ];
    }
    return config;
  },
};

const pwaConfig = withPWA({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development",
  runtimeCaching: [
    {
      urlPattern: /^\/api\/v1\/threads/,
      handler: "NetworkFirst",
      options: {
        cacheName: "threads-cache",
        expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 3600 },
        networkTimeoutSeconds: 5,
      },
    },
    {
      urlPattern: /^\/api\/v1\/memory/,
      handler: "NetworkFirst",
      options: {
        cacheName: "memory-cache",
        expiration: { maxEntries: 500, maxAgeSeconds: 7 * 24 * 3600 },
        networkTimeoutSeconds: 5,
      },
    },
    {
      urlPattern: /^\/api\/v1\/agents/,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "agents-cache",
        expiration: { maxEntries: 20, maxAgeSeconds: 24 * 3600 },
      },
    },
  ],
});

export default pwaConfig(nextConfig);
