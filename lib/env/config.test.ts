import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the data-dir resolver so the test doesn't touch the real filesystem.
vi.mock("@/lib/db/data-dir", () => ({
  getDataDir: () => "/tmp/jarela-test-data",
}));

import { getConfig, resetConfigCache } from "./config";

const KEYS = [
  "JARELA_PORT",
  "PORT",
  "JARELA_HOSTNAME",
  "HOSTNAME",
  "JARELA_RECURSION_LIMIT",
  "JARELA_VOICE_TIMEOUT_MS",
  "JARELA_IMAGE_TIMEOUT_MS",
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_APP_DESCRIPTION",
  "NEXT_PUBLIC_APP_ISSUE_URL",
] as const;

describe("getConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetConfigCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetConfigCache();
  });

  it("returns defaults when nothing is set", () => {
    const c = getConfig();
    expect(c.port).toBe(4312);
    expect(c.hostname).toBe("127.0.0.1");
    expect(c.recursionLimit).toBe(200);
    expect(c.voiceTimeoutMs).toBe(60_000);
    expect(c.imageTimeoutMs).toBe(60_000);
    expect(c.dataDir).toBe("/tmp/jarela-test-data");
    expect(c.appName).toBe("Jarela");
    expect(c.appDescription).toBe("Jarela — local chat interface for LangGraph agents");
    expect(c.issueUrl).toBe("https://github.com/CircuitWall/jarela/issues/new");
  });

  it("honours NEXT_PUBLIC_APP_NAME override", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "vClaw";
    resetConfigCache();
    expect(getConfig().appName).toBe("vClaw");
  });

  it("honours NEXT_PUBLIC_APP_DESCRIPTION override", () => {
    process.env.NEXT_PUBLIC_APP_DESCRIPTION = "vClaw — Visa-flavored fork";
    resetConfigCache();
    expect(getConfig().appDescription).toBe("vClaw — Visa-flavored fork");
  });

  it("honours NEXT_PUBLIC_APP_ISSUE_URL override", () => {
    process.env.NEXT_PUBLIC_APP_ISSUE_URL = "https://example.com/issues/new";
    resetConfigCache();
    expect(getConfig().issueUrl).toBe("https://example.com/issues/new");
  });

  it("prefers JARELA_PORT over PORT", () => {
    process.env.PORT = "5000";
    process.env.JARELA_PORT = "6000";
    resetConfigCache();
    expect(getConfig().port).toBe(6000);
  });

  it("falls back to PORT when JARELA_PORT is unset", () => {
    process.env.PORT = "5000";
    resetConfigCache();
    expect(getConfig().port).toBe(5000);
  });

  it("rejects invalid ports and falls back to the default", () => {
    process.env.JARELA_PORT = "not-a-number";
    resetConfigCache();
    expect(getConfig().port).toBe(4312);

    process.env.JARELA_PORT = "99999";
    resetConfigCache();
    expect(getConfig().port).toBe(4312);
  });

  it("honours JARELA_HOSTNAME and JARELA_RECURSION_LIMIT", () => {
    process.env.JARELA_HOSTNAME = "0.0.0.0";
    process.env.JARELA_RECURSION_LIMIT = "50";
    resetConfigCache();
    const c = getConfig();
    expect(c.hostname).toBe("0.0.0.0");
    expect(c.recursionLimit).toBe(50);
  });

  it("memoises results across calls", () => {
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
  });
});
