// Renders every assembled prompt to .prompts/ for review.
//
//   npm run prompts:dump                 all prompts
//   npm run prompts:dump -- --changed    only prompts your uncommitted work touches
//   npm run prompts:dump -- --since origin/main
//
// See .github/skills/prompt-verification/SKILL.md.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const sinceIndex = args.indexOf("--since");
const since = sinceIndex >= 0 ? args[sinceIndex + 1] : null;
const narrow = args.includes("--changed") || since !== null;

function changedFiles() {
  const cmd = since
    ? ["diff", "--name-only", `${since}...HEAD`]
    : ["status", "--porcelain=1"];
  const out = spawnSync("git", cmd, { encoding: "utf8" });
  if (out.status !== 0) return [];
  return out.stdout
    .split("\n")
    .map((line) => (since ? line.trim() : line.slice(3).trim()))
    .filter(Boolean);
}

const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "lib/agents/prompt-registry.test.ts"],
  { stdio: "inherit", env: { ...process.env, JARELA_PROMPT_DUMP: "1" } },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const outDir = join(process.cwd(), ".prompts");
const mapPath = join(outDir, "SOURCE_MAP.json");
if (!narrow || !existsSync(mapPath)) {
  console.log("\nAssembled prompts written to .prompts/ — start with .prompts/INDEX.md");
  process.exit(0);
}

const map = JSON.parse(readFileSync(mapPath, "utf8"));
const changed = changedFiles().map((p) => p.replace(/\\/g, "/"));
const touchesSystemPrompt = changed.some((p) =>
  map.systemPromptSourcePrefixes.some((prefix) => p.startsWith(prefix)));
const touchedStatic = map.staticPrompts.filter((p) => changed.includes(p.source));

const label = since ? `changed since ${since}` : "uncommitted changes";
if (!touchesSystemPrompt && touchedStatic.length === 0) {
  console.log(`\nNo prompt sources in ${label}. Full dump is in .prompts/.`);
  process.exit(0);
}

console.log(`\nPrompts affected by ${label} — review these:`);
if (touchesSystemPrompt) {
  // One builder edit reaches every variant, so none of them can be skipped.
  for (const artifact of map.systemPromptArtifacts) console.log(`  .prompts/${artifact}`);
}
for (const p of touchedStatic) console.log(`  .prompts/${p.artifact}  (${p.source})`);
