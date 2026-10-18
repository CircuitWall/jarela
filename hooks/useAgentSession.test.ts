// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSession } from "@/hooks/useAgentSession";

const threadGetMock = vi.fn();
const agentGetThreadMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: {
    threads: {
      get: (...args: unknown[]) => threadGetMock(...args),
      metadata: (...args: unknown[]) => threadGetMock(...args),
    },
    agents: {
      getThread: (...args: unknown[]) => agentGetThreadMock(...args),
    },
  },
}));

describe("useAgentSession contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns unified and compatibility fields and prefers explicit thread", async () => {
    threadGetMock.mockResolvedValue({ agent_id: "agent-1" });
    agentGetThreadMock.mockResolvedValue({ thread_id: "fallback-thread" });

    const { result } = renderHook(() => useAgentSession("agent-1", "preferred-thread"));

    await waitFor(() => expect(result.current.state.threadId).toBe("preferred-thread"));

    expect(result.current.threadId).toBe("preferred-thread");
    expect(result.current.loading).toBe(result.current.state.loading);
    expect(result.current.refresh).toBe(result.current.commands.refresh);
    expect(agentGetThreadMock).not.toHaveBeenCalled();
    expect(threadGetMock).toHaveBeenCalledWith("preferred-thread", { startup: true });
  });

  it("uses the startup handoff initially but keeps explicit refreshes fresh", async () => {
    agentGetThreadMock.mockResolvedValue({ thread_id: "thread" });
    const { result } = renderHook(() => useAgentSession("agent"));
    await waitFor(() => expect(result.current.threadId).toBe("thread"));
    expect(agentGetThreadMock).toHaveBeenLastCalledWith("agent", { startup: true });
    await act(async () => { await result.current.refresh(); });
    expect(agentGetThreadMock).toHaveBeenLastCalledWith("agent", undefined);
  });
});
