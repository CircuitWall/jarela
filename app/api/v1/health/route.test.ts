import { describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn());
const listAgentConfigs = vi.hoisted(() => vi.fn(() => [{ id: "agent-a" }, { id: "agent-b" }]));
const getMasterKeySource = vi.hoisted(() => vi.fn(() => "keychain"));
const isLoopbackRequest = vi.hoisted(() => vi.fn((req: Request) => new URL(req.url).hostname === "localhost"));
vi.mock("@/lib/db", () => ({ DB_PATH: "C:\\private\\jarela.sqlite", getDb }));
vi.mock("@/lib/stores/agent-configs", () => ({ listAgentConfigs }));
vi.mock("@/lib/crypto/master-key", () => ({ getMasterKeySource }));
vi.mock("@/lib/auth/access", () => ({ isLoopbackRequest }));

import { GET } from "./route";

describe("GET /api/v1/health", () => {
  it("preserves readiness diagnostics and limits the database path to loopback", async () => {
    const response = GET(new Request("http://localhost/api/v1/health"));
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      agents: ["agent-a", "agent-b"],
      crypto: { source: "keychain" },
      db_path: "C:\\private\\jarela.sqlite",
    });
    expect(getDb).toHaveBeenCalledOnce();
    expect(listAgentConfigs).toHaveBeenCalledOnce();
    expect(getMasterKeySource).toHaveBeenCalledOnce();
  });

  it("omits the filesystem path for non-loopback callers", async () => {
    const response = GET(new Request("https://jarela.example/api/v1/health"));
    const body = await response.json() as { db_path?: string };
    expect(body.db_path).toBeUndefined();
  });
});
