import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-exec-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

// Background settlement wakes the owning agent through the signal dispatcher;
// these tests assert the recorded outcome, not the wake-up itself.
vi.mock("@/lib/lifecycle/system-signals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lifecycle/system-signals")>();
  return { ...actual, requestSystemSignalDispatch: vi.fn() };
});

const { localExecTool } = await import("./exec");
const { terminalTool } = await import("./terminal");
const { setWorkspace, _resetWorkspaceContext } = await import("../filesystem/workspace-context");
const { getAsyncResult, __resetStore } = await import("../support/async-results");
const { toolResultGetTool } = await import("../support/async-results-tool");
const { wrapWithWallclock } = await import("../support/wallclock");
const { createThread } = await import("@/lib/stores/threads");

function parse(s: string) { return JSON.parse(s) as Record<string, unknown>; }

describe("local_exec timeout reporting", () => {
  it("returns timed_out=true with exit_code=124 and an actionable hint when the command exceeds timeout_ms", async () => {
    const cmd = process.platform === "win32"
      ? "powershell -NoProfile -Command \"Start-Sleep -Seconds 5\""
      : "sleep 5";
    const out = parse(await localExecTool.invoke({ command: cmd, timeout_ms: 200 }));
    expect(out.timed_out).toBe(true);
    expect(out.exit_code).toBe(124);
    expect(out.timeout_ms).toBe(200);
    expect(String(out.error)).toMatch(/timed out after/i);
    expect(String(out.error)).toMatch(/narrower scope|timeout_ms/i);
  }, 15_000);

  it("does not mark normal command failures as timed_out", async () => {
    const out = parse(await localExecTool.invoke({ command: "nonexistent_jarela_test_cmd_zz" }));
    expect(out.timed_out).toBeUndefined();
    expect(out.exit_code).not.toBe(124);
  }, 15_000);
});

describe("terminal", () => {
  afterAll(() => {
    _resetWorkspaceContext();
  });

  it("runs a one-shot shell command without keeping a terminal session", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command \"Write-Output terminal-run-ok\""
      : "printf terminal-run-ok";
    const out = parse(await terminalTool.invoke({ action: "run", command, session_id: "ignored-run-session" }));
    const sessions = await terminalTool.invoke({ action: "list" });

    expect(out.exit_code).toBe(0);
    expect(String(out.stdout)).toContain("terminal-run-ok");
    expect(out.session_id).toBeUndefined();
    expect(sessions).not.toContain("ignored-run-session");
  }, 15_000);

  it("uses the active workspace for one-shot and persistent relative commands", async () => {
    const workspaceRoot = mkdtempSync(join(tmpRoot, "workspace-"));
    writeFileSync(join(workspaceRoot, "marker.txt"), "workspace-marker\n");
    const config = { configurable: { thread_id: "workspace-terminal-test" } };
    setWorkspace({ root: workspaceRoot, scoped: true, opened_at: Date.now() }, config);
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command \"Get-Content marker.txt\""
      : "cat marker.txt";

    const oneShot = parse(await terminalTool.invoke({ action: "run", command }, config));
    const persistent = parse(await terminalTool.invoke({ action: "exec", command }, config));
    await terminalTool.invoke({ action: "close" }, config);

    expect(String(oneShot.stdout)).toContain("workspace-marker");
    expect(String(persistent.stdout)).toContain("workspace-marker");
  }, 15_000);

  it("runs a command through the combined persistent terminal tool", async () => {
    const command = process.platform === "win32"
      ? "powershell -NoProfile -Command \"Write-Output terminal-ok\""
      : "printf terminal-ok";
    const out = parse(await terminalTool.invoke({ action: "exec", command, session_id: "terminal-test" }));

    expect(out.exit_code).toBe(0);
    expect(String(out.stdout)).toContain("terminal-ok");
    expect(out.session_id).toBe("terminal-test");

    const closed = parse(await terminalTool.invoke({ action: "close", session_id: "terminal-test" }));
    expect(closed.ok).toBe(true);
  }, 15_000);
});

// Three ticks spread over ~180ms, printed as they happen.
const TICK_CMD = `node -e "let i=0;const t=setInterval(()=>{console.log('tick '+(++i));if(i===3)clearInterval(t)},60)"`;

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

describe("local_exec background output", () => {
  beforeEach(() => { __resetStore(); });
  // Registration applies the wall-clock/async wrapper; invoking the raw tool
  // directly would ignore async_run and deadline_ms.
  const wrapped = wrapWithWallclock(localExecTool);

  it("streams process output into the async record while it runs", async () => {
    const started = parse(await wrapped.invoke(
      { command: TICK_CMD, timeout_ms: 10_000, async_run: true },
      { configurable: { thread_id: "exec-stream-thread" } },
    ));
    expect(String(started.key)).toMatch(/^async_[0-9a-f]{16}$/);

    await waitFor(() => (getAsyncResult(String(started.key))?.progress ?? "").includes("tick 1"));
    expect(getAsyncResult(String(started.key))!.progress).toContain("tick 1");

    await waitFor(() => getAsyncResult(String(started.key))?.status !== "pending");
    const done = getAsyncResult(String(started.key))!;
    expect(done.status).toBe("done");
    expect(done.progress).toContain("tick 3");
    expect(done.exit_code).toBe(0);
  }, 20_000);

  it("promotes a blocking call that outlives its deadline and keeps its output", async () => {
    const thread = createThread("exec-promotion-agent");
    const receipt = parse(await wrapped.invoke(
      { command: TICK_CMD, timeout_ms: 10_000, deadline_ms: 60 },
      { configurable: { thread_id: thread.thread_id } },
    ));

    expect(receipt.backgrounded).toBe(true);
    expect(String(receipt.message)).toMatch(/Do not repeat it/);

    await waitFor(() => getAsyncResult(String(receipt.key), thread.thread_id)?.status === "done");
    const record = getAsyncResult(String(receipt.key), thread.thread_id)!;
    expect(record.progress).toContain("tick 3");
    expect(parse(record.result!).exit_code).toBe(0);
  }, 20_000);

  it("streams persistent terminal_exec output into the record while it runs", async () => {
    // Covers the per-exec listener path: a shared session is created before
    // the listener exists, so the wiring has to attach for the call.
    const wrappedTerminal = wrapWithWallclock(terminalTool);
    const started = parse(await wrappedTerminal.invoke(
      { action: "exec", command: TICK_CMD, session_id: "stream-session", timeout_ms: 10_000, async_run: true },
      { configurable: { thread_id: "exec-terminal-stream-thread" } },
    ));
    await waitFor(() => (getAsyncResult(String(started.key))?.progress ?? "").includes("tick 1"));
    await waitFor(() => getAsyncResult(String(started.key))?.status !== "pending");
    await terminalTool.invoke({ action: "close", session_id: "stream-session" });
    expect(getAsyncResult(String(started.key))!.progress).toContain("tick 3");
  }, 20_000);

  it("lets a follower read a promoted call through tool_result_get", async () => {
    const thread = createThread("exec-follow-agent");
    const receipt = parse(await wrapped.invoke(
      { command: TICK_CMD, timeout_ms: 10_000, deadline_ms: 60 },
      { configurable: { thread_id: thread.thread_id } },
    ));
    expect(receipt.backgrounded).toBe(true);

    const key = String(receipt.key);
    const config = { configurable: { thread_id: thread.thread_id } };
    let page = parse(await toolResultGetTool.invoke({ key, cursor: 0, wait_ms: 8_000 }, config) as string);
    expect(page.ok).toBe(true);
    let text = String((page.progress as { text?: string }).text ?? "");
    let cursor = Number((page.progress as { next_offset?: number }).next_offset ?? 0);

    // wait_ms returns on the first byte of output, which may only be the shell
    // prompt; keep following with the cursor until the process reports.
    for (let i = 0; i < 40 && !text.includes("tick"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      page = parse(await toolResultGetTool.invoke({ key, cursor, wait_ms: 500 }, config) as string);
      text += String((page.progress as { text?: string }).text ?? "");
      cursor = Number((page.progress as { next_offset?: number }).next_offset ?? cursor);
    }
    expect(text).toContain("tick");
    expect(cursor).toBeGreaterThan(0);
  }, 20_000);
});
