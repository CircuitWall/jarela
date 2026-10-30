import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-execute-mcp-"));
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");

const mcpInvoke = vi.hoisted(() => vi.fn(async (args: unknown, config?: unknown) => {
  const cfg = config as { configurable?: { thread_id?: string } } | undefined;
  return JSON.stringify({
    args,
    thread_id: cfg?.configurable?.thread_id ?? null,
  });
}));

vi.mock("@/lib/mcp/client", () => ({
  getMcpTools: vi.fn(async () => [
    {
      name: "mcp_echo",
      description: "Echo via MCP",
      schema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      invoke: mcpInvoke,
    },
  ]),
  getMcpToolMeta: vi.fn((name: string) => name === "mcp_echo"
    ? { category: "MCP", group: "MCP", server_name: "test-server", credentials_required: [] }
    : undefined),
}));

const { executeTool } = await import("../index");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");
const { createThread } = await import("@/lib/stores/threads");

describe("executeTool MCP routing", () => {
  it("can invoke MCP tools and preserve thread context", async () => {
    const out = await executeTool("mcp_echo", { value: "hello" }, { thread_id: "thread-mcp" });

    expect(out).toEqual({
      args: { value: "hello" },
      thread_id: "thread-mcp",
    });
    expect(mcpInvoke).toHaveBeenCalledOnce();
  });

  it("can proxy an MCP tool without stripping trusted execution context", async () => {
    const writer = vi.fn();
    upsertAgentConfig({ id: "mcp-proxy-agent", name: "MCP Proxy", identity: "test", instructions: "", tools: ["mcp_echo"] });
    const thread = createThread("mcp-proxy-agent");
    const out = await executeTool("invoke_tool", {
      name: "mcp_echo", args_json: JSON.stringify({ value: "proxied" }),
    }, { thread_id: thread.thread_id }, {
      writer,
      configurable: { workspace: { root: tmpRoot, scoped: true, opened_at: 1 }, custom_run_value: "preserved" },
    });
    expect(out).toMatchObject({ status: "done", result: { args: { value: "proxied" }, thread_id: thread.thread_id } });
    expect(mcpInvoke).toHaveBeenLastCalledWith({ value: "proxied" }, expect.objectContaining({
      writer: expect.any(Function),
      configurable: expect.objectContaining({
        workspace: { root: tmpRoot, scoped: true, opened_at: 1 }, custom_run_value: "preserved",
      }),
    }));
  });
});
