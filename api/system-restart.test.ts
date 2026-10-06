import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ begin: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/lifecycle/system-signals", () => ({ beginThreadOperation: mocks.begin }));
vi.mock("@/lib/stores/system-signals", () => ({ getSystemOperation: mocks.get }));
const { POST } = await import("@/app/api/v1/system/restart/route");
const operationId = "00000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.useFakeTimers(); mocks.begin.mockReset().mockReturnValue(operationId); mocks.get.mockReset().mockReturnValue(null); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const request = (body: unknown) => new NextRequest("http://localhost/api/v1/system/restart", { method: "POST", body: JSON.stringify(body) });

describe("restart operation receipts", () => {
  it("persists acceptance before scheduling exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const response = await POST(request({ thread_id: "thread-one", operation_id: operationId }));
    expect(response.status).toBe(202);
    expect(mocks.begin).toHaveBeenCalledWith("thread-one", "restart", operationId);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("does not restart again for a duplicate accepted operation", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    mocks.get.mockReturnValue({ id: operationId, kind: "restart", thread_id: "thread-one" });
    const response = await POST(request({ thread_id: "thread-one", operation_id: operationId }));
    expect((await response.json()).already_accepted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(exit).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects malformed or mismatched agent context without scheduling exit", async () => {
    expect((await POST(request({ thread_id: "thread-one", operation_id: "invalid" }))).status).toBe(400);
    mocks.get.mockReturnValue({ id: operationId, kind: "restart", thread_id: "different" });
    expect((await POST(request({ thread_id: "thread-one", operation_id: operationId }))).status).toBe(409);
    expect(vi.getTimerCount()).toBe(0);
  });
});