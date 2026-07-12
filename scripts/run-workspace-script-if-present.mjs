#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.JARELA_WORKSPACE_SCRIPT_ROOT
  ? resolve(process.env.JARELA_WORKSPACE_SCRIPT_ROOT)
  : resolve(__dirname, "..");
const packagesDir = join(repoRoot, "packages");
const scriptName = process.argv[2];

if (!scriptName) {
  console.error("Usage: node scripts/run-workspace-script-if-present.mjs <script>");
  process.exit(2);
}

function hasWorkspacePackages() {
  if (!existsSync(packagesDir)) return false;
  for (const entry of readdirSync(packagesDir)) {
    const pkgJson = join(packagesDir, entry, "package.json");
    try {
      if (statSync(pkgJson).isFile()) return true;
    } catch {
      // Ignore non-package entries.
    }
  }
  return false;
}

if (!hasWorkspacePackages()) {
  console.log(`[workspace-script] no packages/* workspaces found; skipping npm run ${scriptName}`);
  process.exit(0);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", scriptName, "--workspaces", "--if-present"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);