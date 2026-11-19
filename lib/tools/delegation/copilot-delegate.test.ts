import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "jarela-copilot-delegate-"));
process.env.JARELA_DB_DIR = root;
process.env.JARELA_TOOL_SAFETY = "mostly_safe";

vi.mock("@/lib/stores/integrations", () => ({
  getIntegrationRaw: (id: string) => id === "github" ? { token: "github_pat_synthetic" } : null,
}));
vi.mock("../support/git-probe", () => ({ gitDiffSummary: async (cwd: string) => ({ cwd, files: [] }) }));

const { getDb, closeDb } = await import("@/lib/db");
const adapter = await import("./copilot-sdk-adapter");
const jobs = await import("./claude-delegate-jobs");
const { copilotDelegateTool, copilotDelegateStatusTool, getCopilotConfig } = await import("./copilot-delegate");
const { getCopilotDelegateJobStatus } = await import("./copilot-delegate-status");

interface FakeSessionOptions {
  sessionId?: string;
  model?: string;
  workingDirectory: string;
  onPermission: (prompt: { kind: string; detail: string }) => "approve" | "deny";
  onStep: (step: string) => void;
}

const created: FakeSessionOptions[] = [];
const resumed: string[] = [];
const aborted: string[] = [];
let sessions = 0;
let behaviour: { content: string; steps?: string[]; onTurn?: () => Promise<void> } = { content: "done" };

adapter._setCopilotRuntimeFactoryForTests(async () => ({
  async createSession(options) {
    sessions += 1;
    created.push(options);
    return makeSession(`session-${sessions}`, options);
  },
  async resumeSession(sessionId, options) {
    resumed.push(sessionId);
    return makeSession(sessionId, options);
  },
  async stop() { /* nothing to clean up */ },
}));

function makeSession(sessionId: string, options: FakeSessionOptions) {
  return {
    sessionId,
    async turn({ prompt }: { prompt: string; timeoutMs: number }) {
      for (const step of behaviour.steps ?? []) options.onStep(step);
      // Approve one request so the transcript's approval counters are exercised.
      options.onPermission({ detail: "npm test", kind: "commands" });
      void prompt;
      if (behaviour.onTurn) await behaviour.onTurn();
      return { content: behaviour.content };
    },
    async abort() { aborted.push(sessionId); },
    async disconnect() { /* keep the fake reusable */ },
  };
}

async function run(input: Record<string, unknown>) {
  const raw = await copilotDelegateTool.invoke(input as never) as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(async () => {
  created.length = 0; resumed.length = 0; aborted.length = 0; sessions = 0;
  behaviour = { content: "done", steps: ["→ read_file: src/index.ts", "✓ read_file"] };
  jobs._resetDelegateJobs();
  await adapter.stopCopilotRuntime();
  getDb().prepare("DELETE FROM memory_store").run();
});
afterEach(() => { vi.useRealTimers(); });
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe("copilot_delegate", () => {
  it("reuses the GitHub integration credential instead of asking for a second token", () => {
    expect(getCopilotConfig()).toMatchObject({ token: "github_pat_synthetic", timeoutSeconds: 600 });
  });

  it("runs one turn, reports approvals and keeps the session for follow-up calls", async () => {
    const result = await run({ task: "Add a test", cwd: root });
    expect(result.ok).toBe(true);
    expect(result.result).toBe("done");
    expect(result.session_id).toBe("session-1");
    expect(result.resumed).toBe(false);
    expect(result.permissions).toMatchObject({ mode: "approve-once", approved: 1, rejected: 0 });
    expect((result.transcript as { steps: string[] }).steps).toEqual(["→ read_file: src/index.ts", "✓ read_file"]);
    expect(result.changes).toMatchObject({ cwd: root });

    const followUp = await run({ task: "Continue", cwd: root });
    expect(resumed).toEqual(["session-1"]);
    expect(followUp.resumed).toBe(true);
    expect(created).toHaveLength(1);
  });

  it("starts a new session when fresh is requested", async () => {
    await run({ task: "First", cwd: root });
    const fresh = await run({ task: "Again", cwd: root, fresh: true });
    expect(resumed).toEqual([]);
    expect(fresh.session_id).toBe("session-2");
    expect(fresh.resumed).toBe(false);
  });

  it("falls back to a new session when the stored one can no longer be resumed", async () => {
    await adapter.stopCopilotRuntime();
    adapter._setCopilotRuntimeFactoryForTests(async () => ({
      async createSession(options) { sessions += 1; created.push(options); return makeSession(`new-${sessions}`, options); },
      async resumeSession() { throw new Error("session missing"); },
      async stop() { /* noop */ },
    }));
    await run({ task: "First", cwd: root });
    const second = await run({ task: "Second", cwd: root });
    expect(second.session_id).toBe("new-2");
    expect((second.transcript as { steps: string[] }).steps).toContain("↺ previous Copilot session unavailable; started a new one");
    adapter._setCopilotRuntimeFactoryForTests(async () => ({
      async createSession(options) { sessions += 1; created.push(options); return makeSession(`session-${sessions}`, options); },
      async resumeSession(sessionId, options) { resumed.push(sessionId); return makeSession(sessionId, options); },
      async stop() { /* noop */ },
    }));
  });

  it("requires a workspace and refuses to run in the safe tier", async () => {
    const missing = await run({ task: "Do work" });
    expect(missing).toMatchObject({ ok: false, code: "WORKSPACE_REQUIRED" });

    process.env.JARELA_TOOL_SAFETY = "safe";
    const blocked = await run({ task: "Do work", cwd: root });
    expect(blocked).toMatchObject({ ok: false, code: "SAFETY_BLOCKED" });
    process.env.JARELA_TOOL_SAFETY = "mostly_safe";
  });

  it("surfaces a turn failure instead of reporting success", async () => {
    behaviour = { content: "", onTurn: async () => { throw new Error("runtime exploded"); } };
    await expect(copilotDelegateTool.invoke({ task: "Break", cwd: root } as never)).rejects.toThrow("runtime exploded");
  });

  it("runs in the background, reports steps, and completes the job", async () => {
    const started = await run({ task: "Background work", cwd: root, background: true });
    const jobId = started.job_id as string;
    expect(started.status).toBe("running");
    await vi.waitFor(() => expect(jobs.getJob(jobId, "copilot")?.status).toBe("done"));
    const status = getCopilotDelegateJobStatus(jobId);
    expect(status?.status).toBe("done");
    expect(status?.steps).toEqual(["→ read_file: src/index.ts", "✓ read_file"]);
    expect((status?.result as { result?: string })?.result).toBe("done");
  });

  it("cancels a running background job through the status tool and aborts the turn", async () => {
    const gate = Promise.withResolvers<void>();
    behaviour = { content: "late", onTurn: () => gate.promise };
    const started = await run({ task: "Long work", cwd: root, background: true });
    const jobId = started.job_id as string;
    await vi.waitFor(() => expect(jobs.getJob(jobId, "copilot")?.status).toBe("running"));
    const cancelled = JSON.parse(await copilotDelegateStatusTool.invoke({ job_id: jobId, action: "cancel" } as never) as string);
    expect(cancelled).toMatchObject({ job_id: jobId, status: "cancelled" });
    expect(aborted).toEqual(["session-1"]);
    gate.resolve();
    await vi.waitFor(() => expect(jobs.getJob(jobId, "copilot")?.status).toBe("cancelled"));
  });

  it("scopes job ids to the copilot provider", async () => {
    const started = await run({ task: "Background work", cwd: root, background: true });
    const jobId = started.job_id as string;
    expect(jobs.getJob(jobId, "codex")).toBeNull();
    await expect(copilotDelegateStatusTool.invoke({ job_id: "missing" } as never)).rejects.toThrow("No job found");
  });
});

describe("copilot adapter helpers", () => {
  it("summarises tool arguments and completion outcomes", () => {
    expect(adapter.describeToolStart({ toolName: "bash", toolCallId: "c1", arguments: { command: "npm test" } }))
      .toEqual({ step: "→ bash: npm test", toolCallId: "c1", toolName: "bash" });
    expect(adapter.describeToolStart({ toolName: "view", toolCallId: "c2" }).step).toBe("→ view");
    expect(adapter.describeToolComplete({ success: true }, "view")).toBe("✓ view");
    expect(adapter.describeToolComplete({ success: false, error: { message: "not found" } }, "view")).toBe("✗ view: not found");
  });

  it("describes permission prompts from the runtime union", () => {
    expect(adapter.describePermissionPrompt({ kind: "commands", fullCommandText: "rm   -rf build" }))
      .toEqual({ kind: "commands", detail: "rm -rf build" });
    expect(adapter.describePermissionPrompt({ kind: "write", fileName: "src/a.ts", resolvedPath: "C:\\repo\\src\\a.ts" }))
      .toEqual({ kind: "write", detail: "C:\\repo\\src\\a.ts" });
    expect(adapter.describePermissionPrompt({ kind: "url", url: "https://example.com" }))
      .toEqual({ kind: "url", detail: "https://example.com" });
    expect(adapter.describePermissionPrompt(null)).toEqual({ kind: "unknown", detail: "" });
  });
});
