import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";

const mocks = vi.hoisted(() => ({ tools: [] as StructuredToolInterface[], operation: vi.fn((): string | null => "00000000-0000-4000-8000-000000000001") }));
vi.mock("../packages/langchain-package", () => ({ registerLangChainPackage: (value: { tools: { execute: StructuredToolInterface[] } }) => { mocks.tools.push(...value.tools.execute); } }));
vi.mock("@/lib/lifecycle/system-signals", () => ({ recordThreadSignal: vi.fn() }));
vi.mock("@/lib/stores/system-signals", () => ({ restartOperationIdForThread: mocks.operation }));
await import("./system_config");
const restart = mocks.tools.find((candidate) => candidate.name === "restart_server")!;
afterEach(() => { vi.unstubAllGlobals(); mocks.operation.mockReset().mockReturnValue("00000000-0000-4000-8000-000000000001"); });

describe("restart replay prevention", () => {
  it("blocks completion-triggered restarts before any network request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = JSON.parse(await restart.invoke({ reason: "old user request" }, { configurable: { thread_id: "thread-one", signal_continuation: true } }) as string);
    expect(result).toMatchObject({ ok: false, code: "restart_not_authorized" });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.operation).not.toHaveBeenCalled();
  });

  it("reuses the request's operation ID across repeated invocations", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 202, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetch);
    const config = { configurable: { thread_id: "thread-one" } };
    await restart.invoke({ reason: "restart" }, config);
    await restart.invoke({ reason: "retry restart" }, config);
    const bodies = fetch.mock.calls.map((call) => JSON.parse((call as unknown as [string, { body: string }])[1].body));
    expect(bodies[0].operation_id).toBe(bodies[1].operation_id);
  });

  it("blocks restart without a current user request", async () => {
    mocks.operation.mockReturnValue(null);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = JSON.parse(await restart.invoke({ reason: "restart" }, { configurable: { thread_id: "thread-one" } }) as string);
    expect(result.code).toBe("restart_not_authorized");
    expect(fetch).not.toHaveBeenCalled();
  });
});