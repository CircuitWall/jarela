#!/usr/bin/env node
// Entry point for `npm install -g jarela` users (ADR-0011).
//
// On first invocation `.next/standalone/server.js` does not exist yet —
// build it. Subsequent invocations skip the build and start immediately.
// Runs from the install location (the npm global bin → package install
// dir, located via import.meta.url), not the user's CWD.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const standalone = join(root, ".next", "standalone", "server.js");

if (!existsSync(standalone)) {
  console.log("[jarela] first run — building production bundle (one-time, ~30–60 s)…");
  const r = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error("[jarela] build failed; refusing to start.");
    process.exit(r.status ?? 1);
  }
}

process.env.PORT ||= "4312";
process.env.HOSTNAME ||= "127.0.0.1";
process.chdir(root);
await import(new URL("./start-prod.mjs", import.meta.url).href);
