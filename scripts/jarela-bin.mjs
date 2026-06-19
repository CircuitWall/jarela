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
const installedUnderNodeModules = /[\\/]node_modules[\\/]/i.test(root);

const cmd = process.argv[2];

function printHelp() {
  console.log(`Jarela — local LangGraph chat UI.

Usage:
  jarela [start]              start the server in the foreground (default)
  jarela update               upgrade Jarela to the latest published version
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
  JARELA_DISABLE_UPDATE_CHECK  — set to 1 to skip the npm update check
  JARELA_PREFLIGHT_OPTIMIZE_CLIENT
                               — set to 1 to run one-time local chunk
                                 optimization before server boot (default: 1
                                 for npm/global install, 0 for source checkout)
  JARELA_FORCE_PREFLIGHT_OPTIMIZE
                               — set to 1 to force re-running optimization
`);
}

if (cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
  process.exit(0);
}

if (cmd === "update") {
  const { runUpdate } = await import("./update.mjs");
  try { const code = await runUpdate({ root }); process.exit(code); }
  catch (e) { console.error(`[jarela] update failed: ${e?.message ?? e}`); process.exit(1); }
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

// Best-effort update check (non-blocking, short timeout). Disable with
// JARELA_DISABLE_UPDATE_CHECK=1.
if (process.env.JARELA_DISABLE_UPDATE_CHECK !== "1") {
  try {
    const { notifyIfBehind } = await import("./update.mjs");
    await notifyIfBehind({ root });
  } catch { /* never block boot on an update check */ }
}

// First-run convenience: if autostart isn't registered yet and the shell is
// interactive, offer to register it now. Inert in CI / non-TTY / sudo / when
// JARELA_NO_FIRST_RUN_PROMPT=1. If the user accepts, the autostart unit takes
// over the service port and the foreground process exits to avoid a collision.
try {
  const { maybePromptServiceInstall } = await import("./first-run-prompt.mjs");
  const installed = await maybePromptServiceInstall();
  if (installed) process.exit(0);
} catch { /* never block boot on the prompt */ }

// Default: start the bundled standalone server. Source checkouts can still
// build on demand; globally-installed npm packages must *not* try to run a
// Next build from inside node_modules because webpack excludes that path.
if (!existsSync(standalone)) {
  if (installedUnderNodeModules) {
    console.error(
      "[jarela] packaged standalone bundle missing. This npm install cannot build in-place from node_modules. Update to a release that ships the prebuilt standalone output.",
    );
    process.exit(1);
  }
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
if (installedUnderNodeModules) {
  process.env.JARELA_PREFLIGHT_OPTIMIZE_CLIENT ||= "1";
}
process.chdir(root);
await import(new URL("./start-prod.mjs", import.meta.url).href);
