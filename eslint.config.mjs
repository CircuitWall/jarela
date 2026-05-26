// eslint-config-next v16+ is already a flat-config array, so we can spread
// it directly. (FlatCompat-based wrapping triggers a circular-JSON crash
// because the package's `parser` field is an instance, not a serialisable
// config object.)
import nextConfig from "eslint-config-next";

// Node builtins that must be imported with the `node:` prefix. Next 16's
// edge-runtime bundler can't resolve bare specifiers like `"crypto"` or
// `"path"` — it errors at compile time on `instrumentation.ts` and any
// edge route handler that transitively imports them. Listing each
// builtin here lets the built-in `no-restricted-imports` rule fire
// without pulling in eslint-plugin-n / eslint-plugin-unicorn.
const NODE_BUILTINS = [
  "assert", "async_hooks", "buffer", "child_process", "cluster", "crypto",
  "dgram", "dns", "events", "fs", "fs/promises", "http", "https", "inspector",
  "module", "net", "os", "path", "perf_hooks", "process", "querystring",
  "readline", "repl", "stream", "stream/promises", "stream/web",
  "string_decoder", "timers", "timers/promises", "tls", "tty", "url", "util",
  "vm", "worker_threads", "zlib",
];

const config = [
  ...nextConfig,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "public/sw.js",
      "public/swe-worker-*.js",
      "public/workbox-*.js",
      // The browser extension is a separate artifact loaded unpacked into
      // Chrome — it is not part of the Next.js TypeScript project. It uses
      // chrome.* globals and module syntax (.mjs) that the Next eslint
      // config doesn't know about. Vitest covers the pure helpers; the
      // extension itself is exercised in the browser.
      "browser-extension/**",
    ],
  },
  {
    rules: {
      // eslint-plugin-react-hooks@6 ships new React-Compiler-aligned rules.
      // They flag valid React 19 idioms (mount-time fetches, ref shadowing of
      // state, impure render-time reads) which the runtime handles correctly
      // today. The React team's documented migration path is to keep these
      // as warnings during incremental adoption — see the package changelog.
      // We track them in CI output but don't gate builds on them.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: NODE_BUILTINS.map((name) => ({
            name,
            message: `Use "node:${name}" instead — Next.js edge runtime cannot resolve bare-specifier node builtins.`,
          })),
        },
      ],
    },
  },
];

export default config;

