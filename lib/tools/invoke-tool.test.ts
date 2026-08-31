import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-invoke-tool-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { invokeToolTool } = await import("./invoke-tool");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig } = await import("@/lib/stores/agent-configs");

interface InvokeResult {
  ok: boolean;
  tool: string;
  status: "done" | "rejected" | "error";
  result?: unknown;
  error_code?: string;
  permission_reason?: string | null;
}

function parse(value: unknown): InvokeResult {
  return JSON.parse(String(value)) as InvokeResult;
}

describe("invoke_tool", () => {
  it("rejects recursive self-invocation", async () => {
    const out = parse(await invokeToolTool.invoke({ name: "invoke_tool", args: {} }));

    expect(out).toMatchObject({
      ok: false,
      tool: "invoke_tool",
      status: "rejected",
      error_code: "recursive_invoke_tool",
    });
  });

  it("rejects tools that are not enabled for the current agent", async () => {
    upsertAgentConfig({
      id: "invoke-denied-agent",
      name: "Invoke Denied",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-denied-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "gmail_search", args: { query: "from:anyone" } },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out).toMatchObject({
      ok: false,
      tool: "gmail_search",
      status: "rejected",
      error_code: "tool_not_allowed",
      permission_reason: "agent_not_allowed",
    });
  });

  it("executes an otherwise-enabled tool omitted only by the provider cap", async () => {
    upsertAgentConfig({
      id: "invoke-capped-agent",
      name: "Invoke Capped",
      identity: "test",
      instructions: "",
      tools: [],
    });
    const thread = createThread("invoke-capped-agent");

    const out = parse(await invokeToolTool.invoke(
      { name: "list_tools", args: { query: "invoke_tool" } },
      {
        configurable: {
          thread_id: thread.thread_id,
          agent_run_config: {
            tool_permission_map: [
              {
                name: "list_tools",
                permission: "disabled",
                permission_reason: "provider_tool_limit",
              },
            ],
          },
        },
      },
    ));

    expect(out).toMatchObject({
      ok: true,
      tool: "list_tools",
      status: "done",
    });
    expect(out.result).toMatchObject({
      counts: expect.objectContaining({ total: expect.any(Number) }),
    });
  });
});
