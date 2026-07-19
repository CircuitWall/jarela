import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the data-dir helper at a throwaway tmpdir before we import the
// module under test; getDataDir() caches on first call so this MUST
// happen before the dynamic import below.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-pidfile-test-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { acquirePidLock, releasePidLock } = await import("@/lib/lifecycle/pidfile");

const PID_PATH = join(tmpRoot, "jarela.pid");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
});

beforeEach(() => {
  try { if (existsSync(PID_PATH)) rmSync(PID_PATH); } catch { /* */ }
});

describe("pidfile lock", () => {
  it("acquires on empty directory and writes a JSON payload", () => {
    const r = acquirePidLock();
    expect(r.acquired).toBe(true);
    expect(r.path).toBe(PID_PATH);
    expect(existsSync(PID_PATH)).toBe(true);
    const raw = readFileSync(PID_PATH, "utf8");
    const parsed = JSON.parse(raw) as { pid: number; startedAt: string };
    expect(parsed.pid).toBe(process.pid);
    expect(typeof parsed.startedAt).toBe("string");
  });

  it("re-acquires when the existing file points at our own pid", () => {
    acquirePidLock();
    const r = acquirePidLock();
    expect(r.acquired).toBe(true);
  });

  it("refuses when the file points at a foreign live pid", () => {
    // The init process (pid 1) is guaranteed alive on POSIX and unmapped
    // on Windows — use process.ppid instead, which is a live process by
    // definition and is different from our own pid.
    const foreignPid = process.ppid;
    if (foreignPid === process.pid || foreignPid === 0) {
      // Extremely defensive: skip if we somehow have no parent to point at.
      return;
    }
    writeFileSync(
      PID_PATH,
      JSON.stringify({ pid: foreignPid, startedAt: "test" }),
      "utf8",
    );
    const r = acquirePidLock();
    expect(r.acquired).toBe(false);
    expect(r.existing?.pid).toBe(foreignPid);
  });

  it("clobbers a stale file pointing at a dead pid", () => {
    // PID 2^31 - 1 is exceedingly unlikely to be a live process.
    writeFileSync(
      PID_PATH,
      JSON.stringify({ pid: 2147483646, startedAt: "test" }),
      "utf8",
    );
    const r = acquirePidLock();
    expect(r.acquired).toBe(true);
  });

  it("release removes the lock file when it points at us", () => {
    acquirePidLock();
    expect(existsSync(PID_PATH)).toBe(true);
    releasePidLock();
    expect(existsSync(PID_PATH)).toBe(false);
  });

  it("release leaves a foreign lock file untouched", () => {
    writeFileSync(
      PID_PATH,
      JSON.stringify({ pid: process.ppid, startedAt: "test" }),
      "utf8",
    );
    releasePidLock();
    expect(existsSync(PID_PATH)).toBe(true);
  });
});
