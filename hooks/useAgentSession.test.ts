// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentSession } from "@/hooks/useAgentSession";

const threadGetMock = vi.fn();
const agentGetThreadMock = vi.fn();

vi.mock("@/api/client", () => ({
  api: {
    threads: {
      get: (...args: unknown[]) => threadGetMock(...args),
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
  });
});
