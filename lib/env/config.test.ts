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
  "JARELA_PROVIDER_TOOL_LIMIT",
  "JARELA_PROVIDER_RATE_LIMITS",
  "JARELA_MODEL_ROUTER_MODE",
  "JARELA_MODEL_ROUTER_POLICY",
  "JARELA_USAGE_STRATEGY",
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
    expect(c.providerToolLimit).toBe(512);
    expect(c.providerRateLimits).toBe("");
    expect(c.modelRouterMode).toBe("off");
    expect(c.modelRouterPolicy).toBe("balanced");
    expect(c.usageStrategy).toBe("balanced");
    expect(c.dataDir).toBe("/tmp/jarela-test-data");
    expect(c.appName).toBe("Jarela");
    expect(c.appDescription).toBe("Jarela — local chat interface for LangGraph agents");
    expect(c.issueUrl).toBe("https://github.com/CircuitWall/jarela/issues/new");
  });

  it("honours NEXT_PUBLIC_APP_NAME override", () => {
    process.env.NEXT_PUBLIC_APP_NAME = "MyFork";
    resetConfigCache();
    expect(getConfig().appName).toBe("MyFork");
  });

  it("honours NEXT_PUBLIC_APP_DESCRIPTION override", () => {
    process.env.NEXT_PUBLIC_APP_DESCRIPTION = "MyFork — internal fork";
    resetConfigCache();
    expect(getConfig().appDescription).toBe("MyFork — internal fork");
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

  it("invalidates every route-bundle snapshot when one module resets config", async () => {
    expect(getConfig().providerToolLimit).toBe(512);
    vi.resetModules();
    const other = await import("./config");
    process.env.JARELA_PROVIDER_TOOL_LIMIT = "64";
    other.resetConfigCache();
    expect(getConfig().providerToolLimit).toBe(64);
    expect(other.getConfig()).toBe(getConfig());
  });

  it("parses model router settings", () => {
    process.env.JARELA_MODEL_ROUTER_MODE = "heuristic";
    process.env.JARELA_MODEL_ROUTER_POLICY = "cheap";
    resetConfigCache();
    const c = getConfig();
    expect(c.modelRouterMode).toBe("heuristic");
    expect(c.modelRouterPolicy).toBe("cheap");
  });

  it("parses valid usage strategies and falls back for invalid values", () => {
    process.env.JARELA_USAGE_STRATEGY = "fast";
    resetConfigCache();
    expect(getConfig().usageStrategy).toBe("fast");

    process.env.JARELA_USAGE_STRATEGY = "high_reasoning";
    resetConfigCache();
    expect(getConfig().usageStrategy).toBe("high_reasoning");

    process.env.JARELA_USAGE_STRATEGY = "unknown";
    resetConfigCache();
    expect(getConfig().usageStrategy).toBe("balanced");
  });

  it("honours JARELA_PROVIDER_TOOL_LIMIT", () => {
    process.env.JARELA_PROVIDER_TOOL_LIMIT = "768";
    resetConfigCache();
    expect(getConfig().providerToolLimit).toBe(768);
  });

  it("honours JARELA_PROVIDER_RATE_LIMITS", () => {
    process.env.JARELA_PROVIDER_RATE_LIMITS = ' {"gemini":{"requestsPerMinute":10}} ';
    resetConfigCache();
    expect(getConfig().providerRateLimits).toBe('{"gemini":{"requestsPerMinute":10}}');
  });
});
