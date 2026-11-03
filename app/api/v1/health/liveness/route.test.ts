import { describe, expect, it, vi } from "vitest";

const getActiveRunCount = vi.hoisted(() => vi.fn(() => 2));
const getDb = vi.hoisted(() => vi.fn());
const listAgentConfigs = vi.hoisted(() => vi.fn());
const getMasterKeySource = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/run-registry", () => ({ getActiveRunCount }));
vi.mock("@/lib/db", () => ({ getDb }));
vi.mock("@/lib/stores/agent-configs", () => ({ listAgentConfigs }));
vi.mock("@/lib/crypto/master-key", () => ({ getMasterKeySource }));

import { GET } from "./route";

describe("GET /api/v1/health/liveness", () => {
  it("returns process liveness and active-run state without touching diagnostics", async () => {
    const response = GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      activity: { active_runs: 2 },
    });
    expect(getActiveRunCount).toHaveBeenCalledOnce();
    expect(getDb).not.toHaveBeenCalled();
    expect(listAgentConfigs).not.toHaveBeenCalled();
    expect(getMasterKeySource).not.toHaveBeenCalled();
  });
});
