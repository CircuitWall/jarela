import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test process; the threads + pending_actions tables
// are created by the migrations that run on first getDb() call.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-propose-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const { proposeConfigChangeTool, checkProposalTool } = await import("./propose");
const { createThread } = await import("@/lib/stores/threads");
const { setActionStatus, getPendingAction } = await import("@/lib/stores/pending-actions");
const { subscribe } = await import("@/lib/notifications/bus");

// invoke()'s return type is `string | ToolMessage` per LangChain's typings,
// even though our tools always return JSON strings. Coerce defensively so
// the callsites stay terse.
function parse(s: unknown) { return JSON.parse(String(s)) as Record<string, unknown>; }

type Kind = "install_mcp" | "toggle_mcp" | "update_agent_tools" | "update_agent" | "start_oauth" | "set_provider_key" | "enable_integration" | "upsert_harness";

// Capture the notification bus for the duration of each test so we can
// assert the propose tool publishes the user-visible toast as a side effect.
let captured: unknown[] = [];
let unsub: (() => void) | null = null;
beforeEach(() => {
  captured = [];
  if (unsub) unsub();
  unsub = subscribe((ev) => { captured.push(ev); });
});

// ── propose_config_change ───────────────────────────────────────────────────

describe("propose_config_change", () => {
  it("queues a proposal, returns proposal_id, and publishes a user-facing notification", async () => {
    const thread = createThread("agent-1");
    const out = parse(await proposeConfigChangeTool.invoke(
      {
        kind: "toggle_mcp",
        payload: { name: "github", enabled: true },
        reason: "user asked to enable github MCP",
      },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out.status).toBe("pending");
    expect(typeof out.proposal_id).toBe("string");
    expect(out.message).toMatch(/awaiting.*approval|approval/i);

    // The row landed in pending_actions with the right shape.
    const row = getPendingAction(out.proposal_id as string);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      agent_id: "agent-1",
      kind: "toggle_mcp",
      status: "pending",
      reason: "user asked to enable github MCP",
    });
    expect(JSON.parse(row!.payload)).toEqual({ name: "github", enabled: true });

    // The bus emitted exactly one event for this agent.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      type: "run_completed",
      agent_id: "agent-1",
      status: "done",
    });
    expect((captured[0] as { preview: string }).preview).toMatch(/Proposed config change.*toggle_mcp/);
    // Surprising-but-intentional: the published event hardcodes thread_id="".
    // useEventNotifications.ts:179 short-circuits the `jarela:thread-updated`
    // dispatch when thread_id is falsy, but the user-facing toast + the
    // `/api/v1/pending` poll in ApprovalsBanner handle the proposal anyway.
    // Pin this here so any change to that contract surfaces loudly.
    expect((captured[0] as { thread_id: string }).thread_id).toBe("");
  });

  it("returns 'no agent context' when invoked without a thread_id in config", async () => {
    const out = parse(await proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "x" }, reason: "r" },
      // no `configurable.thread_id`
    ));
    expect(out).toEqual({ error: "no agent context" });
    // No DB write, no notification.
    expect(captured).toHaveLength(0);
  });

  it("returns 'no agent context' when config is passed but `configurable` is missing", async () => {
    // Most likely production failure mode: a code path invokes the tool
    // through LangChain but the RunnableConfig is constructed without a
    // `configurable` block. We want the tool to return a structured error,
    // not throw.
    const out = parse(await proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "x" }, reason: "r" },
      {}, // empty config
    ));
    expect(out).toEqual({ error: "no agent context" });
    expect(captured).toHaveLength(0);
  });

  it("returns 'no agent context' when the thread_id doesn't exist in the threads table", async () => {
    const out = parse(await proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "x" }, reason: "r" },
      { configurable: { thread_id: "thread-that-was-never-created" } },
    ));
    expect(out).toEqual({ error: "no agent context" });
    expect(captured).toHaveLength(0);
  });

  it("preserves payload semantics across kinds (proposals are passthrough)", async () => {
    const thread = createThread("agent-2");
    const cases: Array<{ kind: Kind; payload: Record<string, unknown> }> = [
      { kind: "install_mcp", payload: { registry_id: "github" } },
      { kind: "install_mcp", payload: { name: "custom", transport: "stdio", spec: { command: "x" } } },
      { kind: "toggle_mcp", payload: { name: "github", enabled: true } },
      { kind: "update_agent_tools", payload: { agent_id: "agent-2", tools: ["web_search"] } },
      { kind: "start_oauth", payload: { integration_id: "gmail" } },
      { kind: "enable_integration", payload: { id: "gmail" } },
      { kind: "set_provider_key", payload: { name: "anthropic-default", provider: "anthropic", model_id: "claude-opus-4-7" } },
      { kind: "upsert_harness", payload: { name: "Strict Citations", sections: { citation: { enabled: true, body: "tightened" } } } },
      { kind: "update_agent", payload: { agent_id: "agent-2", harness_id: "custom:abc" } },
    ];
    for (const c of cases) {
      const out = parse(await proposeConfigChangeTool.invoke(
        { kind: c.kind, payload: c.payload, reason: "r" },
        { configurable: { thread_id: thread.thread_id } },
      ));
      const row = getPendingAction(out.proposal_id as string)!;
      expect(row.kind).toBe(c.kind);
      expect(JSON.parse(row.payload)).toEqual(c.payload);
    }
  });

  it("rejects invalid per-kind payloads before creating proposals", async () => {
    const thread = createThread("agent-invalid-proposal");
    const out = parse(await proposeConfigChangeTool.invoke(
      { kind: "install_mcp", payload: {}, reason: "install github mcp" },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(out).toMatchObject({
      error_code: "invalid_proposal_payload",
      error: "install_mcp requires registry_id or name + transport + spec",
    });
    expect(out.recovery_hint).toContain("required payload fields");
    expect(captured).toHaveLength(0);
  });

  it("rejects overlong proposal reasons at schema validation", async () => {
    const thread = createThread("agent-overlong-proposal");
    await expect(proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "github", enabled: true }, reason: "x".repeat(101) },
      { configurable: { thread_id: thread.thread_id } },
    )).rejects.toThrow(/100/);
  });
});

// ── check_proposal ──────────────────────────────────────────────────────────

describe("check_proposal", () => {
  it("returns the full proposal envelope while pending (result null)", async () => {
    const thread = createThread("agent-3");
    const proposed = parse(await proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "x", enabled: true }, reason: "r" },
      { configurable: { thread_id: thread.thread_id } },
    ));
    const out = parse(await checkProposalTool.invoke({ proposal_id: proposed.proposal_id as string }));
    expect(out).toMatchObject({
      id: proposed.proposal_id,
      kind: "toggle_mcp",
      status: "pending",
      result: null,
    });
    expect(typeof out.created_at).toBe("string");
    expect(out.decided_at).toBeNull();
  });

  it("reflects the user's decision and decodes JSON results", async () => {
    const thread = createThread("agent-4");
    const proposed = parse(await proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "y", enabled: true }, reason: "r" },
      { configurable: { thread_id: thread.thread_id } },
    ));
    setActionStatus(proposed.proposal_id as string, "approved", { applied: true, server: "y" });

    const out = parse(await checkProposalTool.invoke({ proposal_id: proposed.proposal_id as string }));
    expect(out.status).toBe("approved");
    expect(out.result).toEqual({ applied: true, server: "y" });
    expect(typeof out.decided_at).toBe("string");
  });

  it("falls back to the raw string when result isn't valid JSON (safeParse)", async () => {
    const thread = createThread("agent-5");
    const proposed = parse(await proposeConfigChangeTool.invoke(
      { kind: "toggle_mcp", payload: { name: "z", enabled: true }, reason: "r" },
      { configurable: { thread_id: thread.thread_id } },
    ));
    // setActionStatus JSON-encodes its result arg, but a string is valid JSON
    // (becomes "\"...\"" on the wire). To test the safeParse fallback we
    // bypass via a direct DB write of a non-JSON marker.
    const { getDb } = await import("@/lib/db");
    getDb()
      .prepare("UPDATE pending_actions SET status='failed', result=? WHERE id=?")
      .run("not valid json {{{", proposed.proposal_id as string);
    const out = parse(await checkProposalTool.invoke({ proposal_id: proposed.proposal_id as string }));
    expect(out.status).toBe("failed");
    expect(out.result).toBe("not valid json {{{");
  });

  it("returns a not-found error for unknown proposal ids", async () => {
    const out = parse(await checkProposalTool.invoke({ proposal_id: "nope-doesnt-exist" }));
    expect(out).toEqual({ error: "proposal nope-doesnt-exist not found" });
  });
});
