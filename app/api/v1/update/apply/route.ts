// Self-update endpoint.
//
// POST /api/v1/update/apply
//   Kicks off `npm i -g @circuitwall/jarela@latest` (or `#main` if the
//   user opted into the experimental channel) in a detached child, then
//   returns 202 immediately. The child's stdout/stderr is streamed into
//   an in-memory ring so the UI can show progress.
//
//   When the install succeeds the route schedules `process.exit(0)` so
//   the supervisor (Task Scheduler / systemd / launchd / installed
//   launcher script) relaunches and picks up the new bundle. On failure
//   the process keeps running so the user can inspect the captured log
//   in the banner.
//
// GET /api/v1/update/apply
//   Returns the current job state so the UI can poll for completion.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PACKAGE_NAME = "@circuitwall/jarela";
const REPO = "CircuitWall/jarela";
const MAX_LINES = 200;
const RESTART_DELAY_MS = 1500;

type UpdateState =
  | { state: "idle" }
  | { state: "running"; startedAt: number; lines: string[] }
  | {
      state: "completed";
      startedAt: number;
      finishedAt: number;
      lines: string[];
      willExitAt: number;
    }
  | {
      state: "failed";
      startedAt: number;
      finishedAt: number;
      lines: string[];
      exitCode: number;
    };

// Module-level state. Next runs one Node process per build under the
// supervisor, so this is the only writer.
let current: UpdateState = { state: "idle" };

function isFromSource(): boolean {
  return existsSync(join(process.cwd(), ".git"));
}

function resolveChannel(): "main" | "stable" {
  return (process.env.JARELA_UPDATE_CHANNEL ?? "").trim().toLowerCase() === "main"
    ? "main"
    : "stable";
}

function buildCommand(): { cmd: string; args: string[] } | { error: string } {
  if (isFromSource()) {
    return {
      error:
        "Self-update is disabled for source checkouts. Run `git pull && npm i && npm run build` manually.",
    };
  }
  const target =
    resolveChannel() === "main"
      ? `github:${REPO}#main`
      : `${PACKAGE_NAME}@latest`;
  return { cmd: "npm", args: ["i", "-g", target] };
}

function appendLine(buf: string[], chunk: Buffer): void {
  const text = chunk.toString("utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    buf.push(line);
    if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
  }
}

export function GET() {
  return NextResponse.json(current);
}

export function POST() {
  if (current.state === "running") {
    return NextResponse.json(
      { ...current, alreadyRunning: true },
      { status: 409 },
    );
  }

  const built = buildCommand();
  if ("error" in built) {
    return NextResponse.json({ error: built.error }, { status: 400 });
  }

  const startedAt = Date.now();
  const lines: string[] = [];
  current = { state: "running", startedAt, lines };

  console.warn(`[update/apply] starting: ${built.cmd} ${built.args.join(" ")}`);

  const child = spawn(built.cmd, built.args, {
    cwd: process.cwd(),
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout?.on("data", (b: Buffer) => appendLine(lines, b));
  child.stderr?.on("data", (b: Buffer) => appendLine(lines, b));
  child.on("error", (err) => {
    appendLine(lines, Buffer.from(`spawn error: ${err.message}`));
  });
  child.on("exit", (code) => {
    const finishedAt = Date.now();
    if (code === 0) {
      const willExitAt = finishedAt + RESTART_DELAY_MS;
      current = { state: "completed", startedAt, finishedAt, lines, willExitAt };
      console.warn(
        `[update/apply] install succeeded; exiting in ${RESTART_DELAY_MS}ms for supervisor restart`,
      );
      setTimeout(() => {
        console.warn("[update/apply] exit(0) — supervisor should relaunch");
        process.exit(0);
      }, RESTART_DELAY_MS).unref?.();
    } else {
      current = {
        state: "failed",
        startedAt,
        finishedAt,
        lines,
        exitCode: code ?? 1,
      };
      console.error(`[update/apply] install failed (exit ${code})`);
    }
  });

  return NextResponse.json({ ...current, accepted: true }, { status: 202 });
}
