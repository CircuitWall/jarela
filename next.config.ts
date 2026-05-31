import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const releaseReadableClientBundles =
  process.env.JARELA_DISABLE_CLIENT_MINIFICATION === "1";

const nextConfig: NextConfig = {
  // Pin the workspace root to *this* project. Without this, Next walks up
  // looking for a lockfile and trips over the parent ../package-lock.json,
  // emitting a "multiple lockfiles detected" warning every build.
  outputFileTracingRoot: __dirname,
  // Emit a self-contained .next/standalone/ tree (server.js + the minimum
  // node_modules subset Next traced as required). This is what we copy into
  // %LOCALAPPDATA%\Programs\Jarela for the installed app — no repo or
  // `npm install` needed at runtime.
  output: "standalone",
  // `ws` ships a conditional require of the optional native addons
  // (bufferutil / utf-8-validate). Webpack-bundling `ws` mangles that
  // conditional and ends up calling a half-bundled bufferutil at runtime —
  // throws `b.unmask is not a function` on the first WS frame. Marking the
  // whole package as external keeps ws resolved at runtime against the
  // traced node_modules, where its JS fallback works correctly.
  //
  // `@napi-rs/keyring` is invoked from a child node process via
  // `execFileSync` (see lib/crypto/master-key.ts) with a static
  // `require('@napi-rs/keyring/keytar')` inside a script string that nft
  // cannot see. Marking it external + explicitly tracing its node_modules
  // directory ensures the standalone bundle ships the native binding so
  // the installed app can use the OS keychain.
  serverExternalPackages: [
    "ws",
    "bufferutil",
    "utf-8-validate",
    "@napi-rs/keyring",
    "@whiskeysockets/baileys",
    "baileys",
    "undici",
    // MCP stdio client and its transitive shell-resolver pull in
    // `child_process`/`fs` via cross-spawn/which/isexe. Keep them external
    // so Next's dev compiler doesn't try to trace them into the browser
    // bundle (which can't resolve node-builtins).
    "@modelcontextprotocol/sdk",
    "@langchain/mcp-adapters",
    "cross-spawn",
    "which",
    "isexe",
    // sharp + detect-libc reach for `fs`/`child_process` via the WhatsApp
    // bridge's media helpers.
    "sharp",
    "detect-libc",
  ],
  outputFileTracingIncludes: {
    "/**": ["./node_modules/@napi-rs/keyring/**/*"],
  },
  // Optional release-mode knob for supply-chain scanners like Socket that
  // flag heavily minified browser chunks as potential obfuscation.
  productionBrowserSourceMaps: releaseReadableClientBundles,
  webpack: (config, { dev, isServer }) => {
    if (!dev && !isServer && releaseReadableClientBundles) {
      // Keep browser chunks readable in the published npm tarball.
      if (config.optimization) {
        config.optimization.minimize = false;
      }
    }
    return config;
  },
  experimental: {
    // Keep server route bundles readable for supply-chain scanners and
    // incident-response review. This reduces false positives from
    // obfuscated/minified App Router route.js artifacts.
    serverMinification: false,
    serverSourceMaps: true,
  },
};

// Serwist replaces the abandoned next-pwa. It compiles app/sw.ts into
// public/sw.js as part of `next build` and is compatible with Next 15+ and
// Turbopack (next-pwa is webpack-only).
const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  cacheOnNavigation: true,
  // Hard-reload on the browser's `online` event flaps when the network
  // does — Tailscale/VPN reconnects, Wi-Fi suspend/resume, captive portals.
  // Our SW serves all /api/* with NetworkOnly so a reload buys nothing
  // here; leaving it on caused the installed app to refresh repeatedly.
  reloadOnOnline: false,
  disable: process.env.NODE_ENV === "development",
});

export default withSerwist(nextConfig);

