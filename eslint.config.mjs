// eslint-config-next v16+ is already a flat-config array, so we can spread
// it directly. (FlatCompat-based wrapping triggers a circular-JSON crash
// because the package's `parser` field is an instance, not a serialisable
// config object.)
import nextConfig from "eslint-config-next";

const config = [
  ...nextConfig,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "public/sw.js",
      "public/swe-worker-*.js",
      "public/workbox-*.js",
    ],
  },
  {
    // eslint-plugin-react-hooks@6 ships new React-Compiler-aligned rules.
    // They flag valid React 19 idioms (mount-time fetches, ref shadowing of
    // state, impure render-time reads) which the runtime handles correctly
    // today. The React team's documented migration path is to keep these
    // as warnings during incremental adoption — see the package changelog.
    // We track them in CI output but don't gate builds on them.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
    },
  },
];

export default config;

