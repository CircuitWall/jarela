import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  resolveDependencies: vi.fn(),
  installDependencies: vi.fn(),
}));

vi.mock("@/lib/dependencies/plan", async () => {
  const actual = await vi.importActual<typeof import("@/lib/dependencies/plan")>("@/lib/dependencies/plan");
  return { ...actual, resolveDependencies: mocks.resolveDependencies };
});
vi.mock("@/lib/dependencies/install", () => ({ installDependencies: mocks.installDependencies }));

import { GET } from "./route";
import { POST } from "./install/route";

const target = { kind: "tool" as const, id: "web_search" };

function get(url: string): Request {
  return new Request(url);
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/dependencies/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const resolution = {
  target,
  status: "install_required" as const,
  dependencies: [],
  missing: [],
  steps: [],
  manual: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/dependencies", () => {
  it("rejects a malformed target", async () => {
    const response = await GET(get("http://localhost/api/v1/dependencies?target=nope"));
    expect(response.status).toBe(400);
    expect(mocks.resolveDependencies).not.toHaveBeenCalled();
  });

  it("404s an unknown target", async () => {
    mocks.resolveDependencies.mockResolvedValue({ ...resolution, status: "unknown_target" });
    const response = await GET(get("http://localhost/api/v1/dependencies?target=tool:missing"));
    expect(response.status).toBe(404);
  });

  it("returns the plan for a known target", async () => {
    mocks.resolveDependencies.mockResolvedValue(resolution);
    const response = await GET(get("http://localhost/api/v1/dependencies?target=tool:web_search"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "install_required" });
    expect(mocks.resolveDependencies).toHaveBeenCalledWith(target);
  });
});

describe("POST /api/v1/dependencies/install", () => {
  it("rejects a malformed target before installing", async () => {
    const response = await POST(post({ target: "nope" }));
    expect(response.status).toBe(400);
    expect(mocks.installDependencies).not.toHaveBeenCalled();
  });

  it("404s an unknown target", async () => {
    mocks.installDependencies.mockResolvedValue({
      target: { kind: "tool", id: "missing" },
      status: "failed",
      plan: { ...resolution, status: "unknown_target" },
      result: { ...resolution, status: "unknown_target" },
      ran: [],
      pending: [],
      blocked: [],
      error: "unknown dependency target",
    });
    const response = await POST(post({ target: "tool:missing" }));
    expect(response.status).toBe(404);
  });

  it("returns 200 when the install succeeds", async () => {
    mocks.installDependencies.mockResolvedValue({
      target,
      status: "installed",
      plan: resolution,
      result: { ...resolution, status: "ready" },
      ran: [{ command: ["npm", "install"], cwd: "/tmp" }],
      pending: [],
      blocked: [],
      error: null,
    });
    const response = await POST(post({ target: "tool:web_search" }));
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("installed");
  });

  it("returns 202 when an approval is pending", async () => {
    mocks.installDependencies.mockResolvedValue({
      target,
      status: "pending_approval",
      plan: resolution,
      result: resolution,
      ran: [],
      pending: [{ id: "p1", spec: "some-pkg", publisher: "some-pkg", reason: "approve", createdAt: "now" }],
      blocked: [],
      error: null,
    });
    const response = await POST(post({ target: "tool:web_search" }));
    expect(response.status).toBe(202);
  });
});
