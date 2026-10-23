import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-terminal-tool-"));
process.env.JARELA_DB_DIR = tmpRoot;
afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

const fake = vi.hoisted(() => {
  const sessions = new Map<string, FakeSession>();
  const state = { nextExec: null as null | { stdout: string; stderr: string; exitCode: number; timedOut?: boolean } };
  class FakeSession {
    sessionId: string;
    shell = "fake-shell";
    pid = 4242;
    sent: string[] = [];
    executed: string[] = [];
    closed = false;
    constructor(opts: { sessionId: string }) { this.sessionId = opts.sessionId; }
    async exec(command: string) {
      this.executed.push(command);
      return { stdout: "", stderr: "", exitCode: 0, cwd: "/fake", ...(state.nextExec ?? {}) };
    }
    send(input: string) { this.sent.push(input); }
    readBuffer() { return "buffered"; }
    close() { this.closed = true; }
  }
  return { sessions, state, FakeSession };
});

vi.mock("@/lib/terminal", () => ({
  TerminalSession: fake.FakeSession,
  getSession: (id: string) => fake.sessions.get(id),
  putSession: (s: InstanceType<typeof fake.FakeSession>) => { fake.sessions.set(s.sessionId, s); },
  removeSession: (id: string) => { fake.sessions.get(id)?.close(); fake.sessions.delete(id); },
  listSessions: () => [...fake.sessions.values()].map((s) => ({ sessionId: s.sessionId, shell: s.shell, idleMs: 0, pid: s.pid, cwd: "/fake" })),
  sessionCount: () => fake.sessions.size,
  evictIdleSessions: () => {},
}));

const { terminalTool, terminalExecTool, terminalSendTool, terminalCloseTool, terminalOpenTool } = await import("./terminal");
const { getConfig } = await import("@/lib/env/config");

const config = { configurable: { thread_id: "t1" } };
const originalSafety = process.env.JARELA_TOOL_SAFETY;

async function call(t: { invoke: (a: never, c?: never) => Promise<unknown> }, args: Record<string, unknown>) {
  return JSON.parse(String(await t.invoke(args as never, config as never)));
}

async function openSession(id = "s1") {
  await call(terminalOpenTool, { session_id: id });
  return fake.sessions.get(id)!;
}

describe("terminal tools as used by an agent", () => {
  beforeEach(() => {
    fake.sessions.clear();
    fake.state.nextExec = null;
    delete process.env.JARELA_TOOL_SAFETY;
  });

  afterEach(() => {
    if (originalSafety === undefined) delete process.env.JARELA_TOOL_SAFETY;
    else process.env.JARELA_TOOL_SAFETY = originalSafety;
  });

  describe("terminal_send safety gate", () => {
    it("forwards ordinary prompt answers", async () => {
      const s = await openSession();
      expect(await call(terminalSendTool, { session_id: "s1", input: "y\n" })).toEqual({ output: "buffered" });
      expect(s.sent).toEqual(["y\n"]);
    });

    it.each(["rm -rf / \n", "echo ok\nshutdown now\n", "reboot"])(
      "does not type a blocked command into the shell: %j",
      async (input) => {
        const s = await openSession();
        const result = await call(terminalSendTool, { session_id: "s1", input });
        expect(result.error).toMatch(/blocked by safety policy/);
        expect(s.sent).toEqual([]);
      },
    );

    it("applies the same gate through the unified terminal tool", async () => {
      const s = await openSession();
      const result = await call(terminalTool, { action: "send", session_id: "s1", input: "shutdown -h now\n" });
      expect(result.error).toMatch(/blocked by safety policy/);
      expect(s.sent).toEqual([]);
    });

    it("honours an explicit allow_unsafe override in mostly_safe mode", async () => {
      const s = await openSession();
      await call(terminalSendTool, { session_id: "s1", input: "reboot\n", allow_unsafe: true });
      expect(s.sent).toEqual(["reboot\n"]);
    });

    it("keeps safe mode inspection-only for typed lines but allows Ctrl-C", async () => {
      process.env.JARELA_TOOL_SAFETY = "safe";
      const s = await openSession();
      expect((await call(terminalSendTool, { session_id: "s1", input: "python -c 1\n" })).error).toMatch(/safe mode/);
      await call(terminalSendTool, { session_id: "s1", input: "\x03" });
      expect(s.sent).toEqual(["\x03"]);
    });

    it("reports a missing session without sending", async () => {
      expect((await call(terminalSendTool, { session_id: "nope", input: "y\n" })).error).toMatch(/No active session/);
    });
  });

  describe("terminal_exec", () => {
    it("rejects a blank command without running it", async () => {
      const s = await openSession();
      const result = await call(terminalExecTool, { session_id: "s1", command: "   " });
      expect(result.exit_code).not.toBe(0);
      expect(s.executed).toEqual([]);
    });

    it("refuses blocked commands without running them", async () => {
      const s = await openSession();
      const result = await call(terminalExecTool, { session_id: "s1", command: "shutdown now" });
      expect(result.exit_code).toBe(126);
      expect(s.executed).toEqual([]);
    });

    it("bounds large session output and discloses truncation", async () => {
      await openSession();
      const max = getConfig().execMaxOutputBytes;
      fake.state.nextExec = { stdout: "x".repeat(max + 500), stderr: "e".repeat(5_000), exitCode: 0 };
      const result = await call(terminalExecTool, { session_id: "s1", command: "cat big.log" });
      expect(result.truncated).toBe(true);
      expect(result.stdout.length).toBeLessThan(max + 100);
      expect(result.stderr.length).toBeLessThan(2_100);
    });

    it("reports timeouts as failure with exit code 124", async () => {
      await openSession();
      fake.state.nextExec = { stdout: "partial", stderr: "", exitCode: 0, timedOut: true };
      const result = await call(terminalExecTool, { session_id: "s1", command: "sleep 100", timeout_ms: 10 });
      expect(result).toMatchObject({ exit_code: 124, timed_out: true, stdout: "partial" });
    });
  });

  describe("terminal_close", () => {
    it("closes an open session", async () => {
      const s = await openSession();
      expect(await call(terminalCloseTool, { session_id: "s1" })).toEqual({ ok: true, session_id: "s1" });
      expect(s.closed).toBe(true);
    });

    it("does not claim success for an unknown session", async () => {
      const result = await call(terminalCloseTool, { session_id: "ghost" });
      expect(result.ok).not.toBe(true);
      expect(result.error).toMatch(/No active session/);
    });
  });

  describe("terminal run", () => {
    it("requires a command", async () => {
      expect(await call(terminalTool, { action: "run" })).toMatchObject({ exit_code: 1 });
    });
  });
});
