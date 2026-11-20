import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-access-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { closeDb, getDb } = await import("@/lib/db");
const { __resetLastSeenThrottleForTests, addToWhitelist, touchLastSeen } = await import("./access");

afterEach(() => {
  __resetLastSeenThrottleForTests();
  vi.useRealTimers();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function lastSeen(identity: string): string | null {
  const row = getDb()
    .prepare("SELECT last_seen_at FROM access_whitelist WHERE identity=?")
    .get(identity) as { last_seen_at: string | null };
  return row.last_seen_at;
}

describe("touchLastSeen", () => {
  it("writes once per window and records a newer visit after it", () => {
    addToWhitelist("alice@example.com");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T19:00:00.000Z"));
    touchLastSeen("alice@example.com");
    expect(lastSeen("alice@example.com")).toBe("2026-11-20T19:00:00.000Z");

    // Requests repeat every few seconds; none of them may hit the writer.
    vi.setSystemTime(new Date("2026-11-20T19:04:59.000Z"));
    touchLastSeen("alice@example.com");
    expect(lastSeen("alice@example.com")).toBe("2026-11-20T19:00:00.000Z");

    vi.setSystemTime(new Date("2026-11-20T19:05:01.000Z"));
    touchLastSeen("alice@example.com");
    expect(lastSeen("alice@example.com")).toBe("2026-11-20T19:05:01.000Z");
  });

  it("throttles each identity separately and never throws for an unknown identity", () => {
    addToWhitelist("bob@example.com");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T19:00:00.000Z"));
    expect(() => touchLastSeen("ghost@example.com")).not.toThrow();
    touchLastSeen("bob@example.com");
    expect(lastSeen("bob@example.com")).toBe("2026-11-20T19:00:00.000Z");
  });
});
