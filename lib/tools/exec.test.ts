import { describe, it, expect, afterAll } from "vitest";
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

const { localExecTool } = await import("./exec");
const { terminalTool } = await import("./terminal");
const { setWorkspace, _resetWorkspaceContext } = await import("./workspace-context");

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
