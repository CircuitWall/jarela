#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function runGit(args) {
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  }).trim();
}

try {
  // No-op outside a git checkout (e.g. npm package consumers).
  runGit(["rev-parse", "--git-dir"]);
} catch {
  process.stdout.write("[hooks] skipping: not a git repository\n");
  process.exit(0);
}

try {
  runGit(["config", "core.hooksPath", ".githooks"]);
  process.stdout.write("[hooks] configured core.hooksPath -> .githooks\n");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[hooks] failed to configure git hooks: ${msg}\n`);
  process.exit(1);
}
