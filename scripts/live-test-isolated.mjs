#!/usr/bin/env node
// Orchestrator for an isolated live-test run.
//
//  1. Picks an isolated DB dir (JARELA_DB_DIR -> %TEMP%/jarela-livetest by default).
//  2. Spawns `next dev --webpack -p <port>` with that dir.
//  3. Polls until the server is healthy.
//  4. Runs scripts/live-test.mjs against it, with JARELA_SEED_FROM_PROD=1 so
//     real provider credentials are copied from ~/.jarela (read-only).
//  5. Tears the server down on exit.
//
// Production data is never written; this only READS from prod via SQLite
// read-only mode.
//
// Usage:
//   node scripts/live-test-isolated.mjs            # infra + CRUD only
//   node scripts/live-test-isolated.mjs --llm      # also run agent flow tests
//   node scripts/live-test-isolated.mjs --keep-db  # don't wipe temp dir at start

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = Number(process.env.JARELA_TEST_PORT || 4313);
const DB_DIR = process.env.JARELA_TEST_DB_DIR || join(tmpdir(), "jarela-livetest");
const KEEP_DB = process.argv.includes("--keep-db");
const PASS_ARGS = process.argv.slice(2).filter((a) => a !== "--keep-db");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

function log(msg) { console.log(`${C.cyan}[isolated]${C.reset} ${msg}`); }

// 1. DB dir
if (!KEEP_DB && existsSync(DB_DIR)) {
  log(`wiping previous isolated DB at ${DB_DIR}`);
  rmSync(DB_DIR, { recursive: true, force: true });
}
mkdirSync(DB_DIR, { recursive: true });
log(`isolated DB dir: ${DB_DIR}`);

// 2. Start dev server
log(`starting next dev on :${PORT} (this won't touch ~/.jarela)`);
const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["next", "dev", "--webpack", "-p", String(PORT)],
  {
    env: { ...process.env, JARELA_DB_DIR: DB_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

let serverReady = false;
server.stdout.on("data", (buf) => {
  const s = buf.toString();
  if (process.env.JARELA_VERBOSE) process.stdout.write(`${C.dim}[server]${C.reset} ${s}`);
  if (!serverReady && /Ready in /.test(s)) serverReady = true;
});
server.stderr.on("data", (buf) => {
  if (process.env.JARELA_VERBOSE) process.stderr.write(`${C.dim}[server-err]${C.reset} ${buf}`);
});

function shutdown(code) {
  if (server.exitCode === null) {
    log(`shutting down dev server (pid=${server.pid})`);
    if (process.platform === "win32") {
      // On Windows, spawn was through cmd.exe (shell:true) so SIGTERM to the
      // shell wrapper does NOT cascade to the actual node/next.exe child.
      // Use taskkill /T to terminate the whole process tree.
      try {
        spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    } else {
      try { server.kill("SIGTERM"); } catch {}
    }
    setTimeout(() => { try { server.kill("SIGKILL"); } catch {} }, 2000).unref();
  }
  setTimeout(() => process.exit(code), 800).unref();
}

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));

// 3. Wait for healthy
const BASE = `http://localhost:${PORT}`;
const DEADLINE = Date.now() + 60_000;
while (Date.now() < DEADLINE) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const res = await fetch(`${BASE}/api/v1/agents`);
    if (res.ok) { log(`server healthy at ${BASE}`); break; }
  } catch { /* not up yet */ }
}
if (Date.now() >= DEADLINE) {
  log(`${C.red}server failed to come up within 60s${C.reset}`);
  shutdown(2);
}

// 4. Run live-test with prod-seed enabled
log(`running scripts/live-test.mjs ${PASS_ARGS.join(" ")} (with prod credential seed)`);
const runner = spawn(
  process.execPath,
  ["scripts/live-test.mjs", ...PASS_ARGS],
  {
    env: {
      ...process.env,
      JARELA_URL: BASE,
      JARELA_SEED_FROM_PROD: "1",
    },
    stdio: "inherit",
  },
);

runner.on("exit", (code) => {
  log(`live-test exited with code ${code}`);
  shutdown(code ?? 1);
});
