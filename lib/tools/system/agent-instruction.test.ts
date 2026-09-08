import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-agent-instruction-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { readAgentConfigTool, readAgentInstructionTool, updateAgentInstructionTool } = await import("./agent-instruction");
const { createThread } = await import("@/lib/stores/threads");
const { upsertAgentConfig, getAgentConfig } = await import("@/lib/stores/agent-configs");

function parse(s: unknown) {
  return JSON.parse(String(s)) as Record<string, unknown>;
}

describe("agent instruction tools", () => {
  it("reads the current agent instruction", async () => {
    upsertAgentConfig({
      id: "agent-self-read",
      name: "Self Read",
      identity: "reader",
      instructions: "line one\nline two",
      tools: [],
    });
    const thread = createThread("agent-self-read");

    const out = parse(await readAgentInstructionTool.invoke({}, { configurable: { thread_id: thread.thread_id } }));
    expect(out.agent_id).toBe("agent-self-read");
    expect(out.instruction_line_count).toBe(2);
    expect(out.instructions).toBe("line one\nline two");
  });

  it("reads the current agent config without returning instruction text or secrets", async () => {
    upsertAgentConfig({
      id: "agent-self-config",
      name: "Self Config",
      icon: "data:image/png;base64," + "a".repeat(1024),
      identity: "reader",
      instructions: "private standing rule",
      tools: ["file_read", "list_tools"],
      model_config_name: "workhorse",
      history_limit: 12,
      history_window_hours: 2,
      harness_id: "builtin:default",
      delegate_targets: ["delegate-a"],
      tool_credentials: { github_search: "cred-1" },
      router_policy: "quality",
      router_enabled: true,
    });
    const thread = createThread("agent-self-config");

    const out = parse(await readAgentConfigTool.invoke({}, { configurable: { thread_id: thread.thread_id } }));

    expect(out.agent_id).toBe("agent-self-config");
    expect(out.tools).toEqual(["file_read", "list_tools"]);
    expect(out.model_config_name).toBe("workhorse");
    expect(out.history_limit).toBe(12);
    expect(out.harness_id).toBe("builtin:default");
    expect(out.delegate_targets).toEqual(["delegate-a"]);
    expect(out.tool_credential_overrides).toEqual(["github_search"]);
    expect(out.router_policy).toBe("quality");
    expect(out.router_enabled).toBe(true);
    expect(out.instructions).toBeUndefined();
    expect(out.icon).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("data:image/png;base64");
  });

  it("updates instructions directly without proposals", async () => {
    upsertAgentConfig({
      id: "agent-self-update",
      name: "Self Update",
      identity: "writer",
      instructions: "A\nA\nB",
      tools: [],
    });
    const thread = createThread("agent-self-update");

    const out = parse(await updateAgentInstructionTool.invoke(
      { instructions_edits: [{ op: "dedupe_lines" }, { op: "append", text: "\nC" }] },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out.changed).toBe(true);
    expect(out.dry_run).toBe(false);
    expect(getAgentConfig("agent-self-update")!.instructions).toBe("A\nB\nC");
  });

  it("supports dry_run preview without persisting", async () => {
    upsertAgentConfig({
      id: "agent-self-dryrun",
      name: "Self Dryrun",
      identity: "writer",
      instructions: "Rule old",
      tools: [],
    });
    const thread = createThread("agent-self-dryrun");

    const out = parse(await updateAgentInstructionTool.invoke(
      { instructions_edits: [{ op: "replace", find: "old", replace: "new" }], dry_run: true },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out.dry_run).toBe(true);
    expect(out.instructions).toBe("Rule new");
    expect(getAgentConfig("agent-self-dryrun")!.instructions).toBe("Rule old");
  });

  it("rejects cross-agent updates", async () => {
    upsertAgentConfig({
      id: "agent-owner",
      name: "Owner",
      identity: "x",
      instructions: "owner text",
      tools: [],
    });
    upsertAgentConfig({
      id: "agent-other",
      name: "Other",
      identity: "y",
      instructions: "other text",
      tools: [],
    });
    const thread = createThread("agent-owner");

    const out = parse(await updateAgentInstructionTool.invoke(
      { agent_id: "agent-other", instructions: "hijack" },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(String(out.error)).toMatch(/cross-agent instruction updates are not allowed/);
    expect(getAgentConfig("agent-other")!.instructions).toBe("other text");
  });
});
