import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["lib/**/*.test.ts", "api/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["lib/**/*.ts", "api/**/*.ts"],
      exclude: [
        "lib/**/*.d.ts",
        "lib/**/*.test.ts",
        "lib/db/migrations/**",
        "lib/integrations/**/manifest.ts",
        "lib/proxy/**",
        // Exclude the modules we deliberately don't test (network/SDK boundaries).
        // Coverage report still scans them but won't penalize us.
        "lib/providers/**",
        "lib/tools/**",
        "lib/mcp/**",
        "lib/agents/**",
        "lib/voice/**",
        "lib/embeddings/**",
        "lib/integrations/gmail-oauth.ts",
        "lib/integrations/microsoft-oauth.ts",
        "lib/bridges/whatsapp.ts",
        "lib/bridges/dispatcher.ts",
        "**/index.ts",
      ],
      // Target — not a hard gate. Print numbers, let humans read them.
      thresholds: undefined,
    },
  },
});
