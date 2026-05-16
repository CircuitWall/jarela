import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

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
  // `ws` ships a conditional require of the optional native addons
  // (bufferutil / utf-8-validate). Webpack-bundling `ws` mangles that
  // conditional and ends up calling a half-bundled bufferutil at runtime —
  // throws `b.unmask is not a function` on the first WS frame. Marking the
  // whole package as external keeps ws resolved at runtime against the
  // traced node_modules, where its JS fallback works correctly.
  serverExternalPackages: ["ws", "bufferutil", "utf-8-validate"],
};

// Serwist replaces the abandoned next-pwa. It compiles app/sw.ts into
// public/sw.js as part of `next build` and is compatible with Next 15+ and
// Turbopack (next-pwa is webpack-only).
const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
});

export default withSerwist(nextConfig);

