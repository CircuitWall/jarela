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
      "backend-archived/**",
      "frontend/**",
    ],
  },
];

export default config;

