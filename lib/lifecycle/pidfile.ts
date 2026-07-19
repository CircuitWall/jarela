// Single-instance guard via PID file.
//
// Written at boot to `<dataDir>/jarela.pid` and unlinked on graceful
// shutdown. If a live PID is already present at boot, `acquirePidLock`
// returns `{ acquired: false }` and the caller exits with a diagnostic
// pointing at the running instance.
//
// This is a best-effort guard: two launchers racing on the exact same
// millisecond are still possible, but the window is narrow and the
// failure mode (two processes writing to the same SQLite DB) is noisy
// enough that operators notice immediately.
//
// Liveness test uses `process.kill(pid, 0)` — a no-op that just probes
// whether the target process exists and is signalable. Works on both
// POSIX and Windows (Node maps it to OpenProcess).

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "@/lib/db/data-dir";

const FILENAME = "jarela.pid";

export interface PidFilePayload {
  pid: number;
  startedAt: string;
  version?: string;
}

export interface AcquireResult {
  acquired: boolean;
  path: string;
  /** Populated only when acquired=false — details about the running instance. */
  existing?: PidFilePayload;
}

function pidFilePath(): string {
  return join(getDataDir(), FILENAME);
}

function readPidFile(path: string): PidFilePayload | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    // Support both JSON payloads (current format) and a bare integer
    // (lets an operator hand-edit the file to unstick a stale lock).
    if (/^\d+$/.test(raw)) {
      return { pid: Number(raw), startedAt: "unknown" };
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { pid?: unknown }).pid === "number"
    ) {
      return parsed as PidFilePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true; // it's us
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal
    // it — still counts as alive from our perspective.
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function acquirePidLock(): AcquireResult {
  const path = pidFilePath();

  if (existsSync(path)) {
    const existing = readPidFile(path);
    if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
      return { acquired: false, path, existing };
    }
    // Stale (unreadable, ours, or points at a dead PID) — fall through
    // and overwrite.
  }

  const payload: PidFilePayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: process.env.npm_package_version,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return { acquired: true, path };
}

export function releasePidLock(): void {
  const path = pidFilePath();
  try {
    if (!existsSync(path)) return;
    const existing = readPidFile(path);
    // Only unlink if the file is ours. Refuse to remove another
    // process's lock even if we somehow raced past acquire.
    if (existing && existing.pid !== process.pid) return;
    unlinkSync(path);
  } catch {
    /* best-effort */
  }
}
