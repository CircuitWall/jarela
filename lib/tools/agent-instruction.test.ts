import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-agent-instruction-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { readAgentInstructionTool, updateAgentInstructionTool } = await import("./agent-instruction");
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
