#!/usr/bin/env node
// Entry point for `npm install -g jarela` users (ADR-0011).
//
// Subcommands:
//   jarela [start]         — build if needed, then run server (default)
//   jarela install-service — register OS-native autostart (per-user, no admin)
//   jarela uninstall-service
//   jarela --help | -h

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const standalone = join(root, ".next", "standalone", "server.js");

const cmd = process.argv[2];

function printHelp() {
  console.log(`Jarela — local LangGraph chat UI.

Usage:
  jarela [start]              start the server in the foreground (default)
  jarela install-service      register an OS-native autostart service for the
                              current user (Windows Scheduled Task / macOS
                              LaunchAgent / Linux systemd --user). No admin.
  jarela uninstall-service    undo install-service
  jarela --help, -h           show this help

Environment:
  JARELA_PORT      / PORT      — TCP port (default 4312)
  JARELA_HOSTNAME  / HOSTNAME  — bind address (default 127.0.0.1)
  JARELA_DB_DIR                — data dir (default ~/.jarela on Unix,
                                 %LOCALAPPDATA%\\Jarela on Windows)
  JARELA_RECURSION_LIMIT       — max LangGraph steps per run (default 200)
  JARELA_VOICE_TIMEOUT_MS      — Gemini voice request timeout (default 60000)
  JARELA_IMAGE_TIMEOUT_MS      — Gemini image request timeout (default 60000)
`);
}

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (cmd === "install-service") {
  const { install } = await import("./service-install.mjs");
  try { install(); process.exit(0); }
  catch (e) { console.error(`[jarela] install-service failed: ${e?.message ?? e}`); process.exit(1); }
}

if (cmd === "uninstall-service") {
  const { uninstall } = await import("./service-install.mjs");
  try { uninstall(); process.exit(0); }
  catch (e) { console.error(`[jarela] uninstall-service failed: ${e?.message ?? e}`); process.exit(1); }
}

if (cmd && cmd !== "start") {
  console.error(`[jarela] unknown command: ${cmd}`);
  printHelp();
  process.exit(2);
}

// Default: build if needed, then start.
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

// Honour JARELA_PORT / JARELA_HOSTNAME (start-prod.mjs does the same; we
// also set PORT/HOSTNAME here so the build step and any pre-server probes
// see the same values).
if (process.env.JARELA_PORT) process.env.PORT = process.env.JARELA_PORT;
if (process.env.JARELA_HOSTNAME) process.env.HOSTNAME = process.env.JARELA_HOSTNAME;
process.env.PORT ||= "4312";
process.env.HOSTNAME ||= "127.0.0.1";
process.chdir(root);
await import(new URL("./start-prod.mjs", import.meta.url).href);
