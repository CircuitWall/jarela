// Renders every assembled prompt to .prompts/ for human review.
// See .github/skills/prompt-verification/SKILL.md.
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "lib/agents/prompt-registry.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, JARELA_PROMPT_DUMP: "1" },
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);
console.log("\nAssembled prompts written to .prompts/ — start with .prompts/INDEX.md");
