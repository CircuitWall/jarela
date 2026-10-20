import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getMcpServer: vi.fn(),
  listMcpServers: vi.fn(),
  upsertMcpServer: vi.fn(),
  invalidateMcpTools: vi.fn(),
  mcpServerToResponse: vi.fn((row: unknown) => row),
}));

vi.mock("@/lib/stores/mcp-servers", () => ({
  getMcpServer: mocks.getMcpServer,
  listMcpServers: mocks.listMcpServers,
  upsertMcpServer: mocks.upsertMcpServer,
}));
vi.mock("@/lib/mcp/client", () => ({ invalidateMcpTools: mocks.invalidateMcpTools }));
vi.mock("@/lib/api/serializers", () => ({ mcpServerToResponse: mocks.mcpServerToResponse }));

import { POST } from "./route";

function createRequest(name: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/mcp-servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, transport: "stdio", spec: { command: "node", args: [] } }),
  });
}

describe("POST /api/v1/mcp-servers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMcpServer.mockReturnValue(null);
    mocks.upsertMcpServer.mockImplementation((input) => ({ ...input, created_at: "now" }));
  });

  it("rejects an existing name instead of replacing its saved configuration", async () => {
    mocks.getMcpServer.mockReturnValue({ name: "weather" });

    const response = await POST(createRequest("weather"));

    expect(response.status).toBe(409);
    expect(mocks.upsertMcpServer).not.toHaveBeenCalled();
    expect(mocks.invalidateMcpTools).not.toHaveBeenCalled();
  });

  it("creates a new server", async () => {
    const response = await POST(createRequest("weather"));

    expect(response.status).toBe(201);
    expect(mocks.upsertMcpServer).toHaveBeenCalledWith(expect.objectContaining({ name: "weather" }));
    expect(mocks.invalidateMcpTools).toHaveBeenCalledOnce();
  });
});