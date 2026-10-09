import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-compact-context-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;

const moveMock = vi.fn();
vi.mock("@/lib/agents/context-boundary", () => ({
  moveThreadContextBoundary: (...args: unknown[]) => moveMock(...args),
}));

const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { addMessage, createThread, getMessages } = await import("@/lib/stores/threads");
const { compactContextTool } = await import("./compact-context");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  moveMock.mockReset();
  upsertAgentConfig({ id: "compact-agent", name: "Compact", identity: "helper", instructions: "Be useful.", tools: [] });
});

const parse = (raw: unknown) => JSON.parse(String(raw)) as Record<string, unknown>;

describe("compact_context tool", () => {
  it("anchors the boundary at the current user message and refreshes the summary", async () => {
    const thread = createThread("compact-agent");
    addMessage(thread.thread_id, "user", "old topic");
    addMessage(thread.thread_id, "assistant", "old answer");
    addMessage(thread.thread_id, "user", "new topic please");
    const latestUser = getMessages(thread.thread_id).filter((m) => m.role === "user").at(-1)!;

    const out = parse(await compactContextTool.invoke({}, { configurable: { thread_id: thread.thread_id } }));

    expect(out.ok).toBe(true);
    expect(moveMock).toHaveBeenCalledWith(thread.thread_id, latestUser.seq, { refreshWarmSummary: true });
  });

  it("refuses bridge conversations", async () => {
    const thread = createThread("compact-agent");
    addMessage(thread.thread_id, "user", "hi from bridge", undefined, "bridge", {
      bridge_conversation: { key: "b:1" },
    });

    const out = parse(await compactContextTool.invoke({}, { configurable: { thread_id: thread.thread_id } }));

    expect(out.ok).toBe(false);
    expect(moveMock).not.toHaveBeenCalled();
  });

  it("requires a thread context", async () => {
    const out = parse(await compactContextTool.invoke({}, { configurable: {} }));
    expect(out.ok).toBe(false);
  });
});
