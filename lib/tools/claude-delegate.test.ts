import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-claude-delegate-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
delete process.env.JARELA_ALLOW_SENSITIVE_FILES;

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Fake `claude` CLI child process: records every spawn call whose bin is
// literally "claude" and, on the next microtask, emits the scripted
// stream-json lines from `state.script` followed by a `close` event with
// `state.exitCode`. Real `claude` spawns cost money and hit the network —
// this is the injection seam instead (per ADR-0071's documented
// test-convention deviation).
//
// This same `spawn` is also what `lib/env/sync.ts`'s one-time
// `runEnvSyncOnce()` bootstrap uses (a `/bin/zsh -ic ...` probe, fired the
// first time `getDb()` initializes) — non-"claude" calls are let through
// with an immediate harmless close so that bootstrap doesn't hang, but are
// NOT recorded in `state.calls`/`state.killSpies`, which stay claude-only.
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: string) => void;
}
const state = vi.hoisted(() => ({
  calls: [] as Array<{ bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>,
  killSpies: [] as Array<(signal?: string) => void>,
  script: [] as string[],
  exitCode: 0 as number | null,
  autoClose: true,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawnFn = vi.fn((bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    const isClaude = bin === "claude" || /(?:^|\/)claude$/.test(bin);
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const kill = vi.fn();
    child.kill = kill;
    if (isClaude) {
      state.calls.push({ bin, args, cwd: opts.cwd, env: opts.env });
      state.killSpies.push(kill);
    }
    if (!isClaude || state.autoClose) {
      queueMicrotask(() => {
        const lines = isClaude ? state.script : [];
        for (const line of lines) child.stdout.emit("data", Buffer.from(line + "\n"));
        child.emit("close", isClaude ? state.exitCode : 0);
      });
    }
    return child;
  });
  return { ...actual, spawn: spawnFn };
});

const { claudeDelegateTool, claudeDelegateStatusTool } = await import("./claude-delegate");
const { _resetDelegateJobs } = await import("./claude-delegate-jobs");
const { _resetWorkspaceContext, setWorkspace } = await import("./workspace-context");
const { saveIntegration, deleteIntegration } = await import("@/lib/stores/integrations");

function parse(s: string): Record<string, unknown> {
  return JSON.parse(s) as Record<string, unknown>;
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    is_error: false,
    result: "done",
    duration_ms: 42,
    total_cost_usd: 0.01,
    num_turns: 1,
    permission_denials: [],
    ...overrides,
  });
}

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@e.st"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "ignore" });
}

let projectRoot: string;
beforeEach(() => {
  state.calls = [];
  state.killSpies = [];
  state.script = [resultLine()];
  state.exitCode = 0;
  state.autoClose = true;
  delete process.env.JARELA_TOOL_SAFETY;
  delete process.env.JARELA_CLAUDE_BIN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  deleteIntegration("claude-code");
  _resetDelegateJobs();
  _resetWorkspaceContext();
  projectRoot = mkdtempSync(join(tmpRoot, "proj-"));
});

describe("claude_delegate — safety gate", () => {
  it("refuses outright under JARELA_TOOL_SAFETY=safe, without spawning", async () => {
    process.env.JARELA_TOOL_SAFETY = "safe";
    const out = parse(await claudeDelegateTool.invoke({ task: "do a thing", cwd: projectRoot, sync_memory: false }));
    expect(out.ok).toBe(false);
    expect(out.code).toBe("SAFETY_BLOCKED");
    expect(state.calls).toHaveLength(0);
  });

  it("forces --permission-mode dontAsk under mostly_safe (the default) without allow_unsafe", async () => {
    const out = parse(await claudeDelegateTool.invoke({ task: "do a thing", cwd: projectRoot, sync_memory: false }));
    expect(out.safety_mode).toBe("mostly_safe");
    expect(out.permission_mode_used).toBe("dontAsk");
    expect(state.calls[0]!.args).toContain("--permission-mode");
    expect(state.calls[0]!.args[state.calls[0]!.args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
  });

  it("honours a requested permission_mode when allow_unsafe=true under mostly_safe", async () => {
    const out = parse(await claudeDelegateTool.invoke({
      task: "do a thing", cwd: projectRoot, sync_memory: false,
      allow_unsafe: true, permission_mode: "acceptEdits",
    }));
    expect(out.permission_mode_used).toBe("acceptEdits");
    const args = state.calls[0]!.args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("defaults to bypassPermissions when allow_unsafe=true but no permission_mode given", async () => {
    const out = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false, allow_unsafe: true }));
    expect(out.permission_mode_used).toBe("bypassPermissions");
  });

  it("honours the caller's permission_mode as-is under bypass, ignoring allow_unsafe", async () => {
    process.env.JARELA_TOOL_SAFETY = "bypass";
    const out = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false, permission_mode: "plan" }));
    expect(out.safety_mode).toBe("bypass");
    expect(out.permission_mode_used).toBe("plan");
  });

  it("surfaces permission_denials and a verify_hint when Claude's writes were denied", async () => {
    state.script = [resultLine({ permission_denials: [{ tool_name: "Write", tool_input: { file_path: "x" } }] })];
    const out = parse(await claudeDelegateTool.invoke({ task: "write a file", cwd: projectRoot, sync_memory: false }));
    expect(out.permission_denials).toHaveLength(1);
    expect(String(out.verify_hint)).toMatch(/allow_unsafe/);
  });
});

describe("claude_delegate — cwd resolution", () => {
  it("uses the explicit cwd param and passes it as the spawn cwd", async () => {
    await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false });
    expect(state.calls[0]!.cwd).toBe(projectRoot);
  });

  it("falls back to the active workspace root when cwd is omitted", async () => {
    setWorkspace({ root: projectRoot, scoped: false, opened_at: Date.now() });
    const out = parse(await claudeDelegateTool.invoke({ task: "x", sync_memory: false }));
    expect(state.calls[0]!.cwd).toBe(projectRoot);
    expect(out.workspace_missing).toBeUndefined();
  });

  it("flags workspace_missing when neither cwd nor an active workspace is set", async () => {
    const out = parse(await claudeDelegateTool.invoke({ task: "x", sync_memory: false }));
    expect(out.workspace_missing).toBe(true);
  });

  it("prefers UI-managed Claude Code settings over shell environment values", async () => {
    saveIntegration("claude-code", {
      cli_path: "/opt/homebrew/bin/claude",
      api_key: "sk-ant-ui",
      auth_token: "auth-ui",
      base_url: "https://ui.anthropic.example",
      default_opus_model: "claude-opus-ui",
      default_sonnet_model: "claude-sonnet-ui",
      default_haiku_model: "claude-haiku-ui",
    });
    process.env.JARELA_CLAUDE_BIN = "/usr/local/bin/claude";
    process.env.ANTHROPIC_API_KEY = "sk-ant-env";
    process.env.ANTHROPIC_AUTH_TOKEN = "auth-env";
    process.env.ANTHROPIC_BASE_URL = "https://env.anthropic.example";
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "claude-opus-env";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-env";
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-env";

    await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false });
    expect(state.calls[0]!.bin).toBe("/opt/homebrew/bin/claude");
    expect(state.calls[0]!.env.ANTHROPIC_API_KEY).toBe("sk-ant-ui");
    expect(state.calls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe("auth-ui");
    expect(state.calls[0]!.env.ANTHROPIC_BASE_URL).toBe("https://ui.anthropic.example");
    expect(state.calls[0]!.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-ui");
    expect(state.calls[0]!.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-ui");
    expect(state.calls[0]!.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-haiku-ui");
  });
});

describe("claude_delegate — session persistence", () => {
  it("starts a fresh session on the first call, then resumes it on a follow-up", async () => {
    const first = parse(await claudeDelegateTool.invoke({ task: "start", cwd: projectRoot, sync_memory: false }));
    expect(first.resumed).toBe(false);
    const firstArgs = state.calls[0]!.args;
    expect(firstArgs).toContain("--session-id");
    expect(firstArgs).not.toContain("--resume");
    const sessionId = first.session_id as string;

    const second = parse(await claudeDelegateTool.invoke({ task: "continue", cwd: projectRoot, sync_memory: false }));
    expect(second.resumed).toBe(true);
    expect(second.session_id).toBe(sessionId);
    const secondArgs = state.calls[1]!.args;
    expect(secondArgs[secondArgs.indexOf("--resume") + 1]).toBe(sessionId);
  });

  it("fresh:true starts a new session even when one already exists", async () => {
    const first = parse(await claudeDelegateTool.invoke({ task: "start", cwd: projectRoot, sync_memory: false }));
    const second = parse(await claudeDelegateTool.invoke({ task: "start over", cwd: projectRoot, fresh: true, sync_memory: false }));
    expect(second.session_id).not.toBe(first.session_id);
    expect(second.resumed).toBe(false);
  });

  it("keeps feature-labelled sub-sessions independent from the project default", async () => {
    const base = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false }));
    const feature = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, feature: "auth-rewrite", sync_memory: false }));
    expect(feature.project_key).not.toBe(base.project_key);
    expect(feature.resumed).toBe(false);
  });
});

describe("claude_delegate — verify loop (changes)", () => {
  it("attaches a git diff summary reflecting the real workspace state", async () => {
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, "a.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: projectRoot, stdio: "ignore" });
    // Simulate Claude having created a new file during its run.
    writeFileSync(join(projectRoot, "new.txt"), "created by claude\n");

    const out = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false }));
    const changes = out.changes as Record<string, unknown>;
    expect(changes.is_repo).toBe(true);
    expect(changes.dirty).toBe(true);
    expect(changes.status_lines).toEqual(["?? new.txt"]);
  });

  it("reports is_repo=false for a non-git workspace", async () => {
    const out = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false }));
    expect((out.changes as Record<string, unknown>).is_repo).toBe(false);
  });
});

describe("claude_delegate — memory sync", () => {
  it("pushes Claude's own memory files into this project's claude-sync namespace by default", async () => {
    state.script = [resultLine()];
    // Claude writes a memory file as a side effect of the run — simulated
    // by dropping the file where syncOut will look for it right after the
    // (mocked) spawn closes.
    const { claudeProjectDir } = await import("./claude-memory-bridge");
    const dir = claudeProjectDir(projectRoot);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "learned.md"),
      "---\nname: learned\ndescription: something learned\nmetadata:\n  type: feedback\n---\n\nAlways branch off main.\n",
    );

    const out = parse(await claudeDelegateTool.invoke({ task: "x", cwd: projectRoot }));
    const sync = out.sync as { namespace: string; out?: { pushed: string[] } };
    expect(sync.namespace).toMatch(/^claude-sync:/);
    expect(sync.out?.pushed).toContain("learned");

    const { listMemory } = await import("@/lib/stores/memory");
    expect(listMemory(sync.namespace).some((r) => r.key === "learned")).toBe(true);
  });
});

describe("claude_delegate — error surfacing", () => {
  it("throws when the final result event has is_error=true", async () => {
    state.script = [resultLine({ is_error: true, result: "boom" })];
    await expect(claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false })).rejects.toThrow(/boom/);
  });

  it("throws a helpful error when the claude binary is missing", async () => {
    state.autoClose = false;
    // Override spawn for this one test to throw ENOENT synchronously.
    const { spawn } = await import("node:child_process");
    vi.mocked(spawn).mockImplementationOnce(() => {
      const err = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      throw err;
    });
    await expect(claudeDelegateTool.invoke({ task: "x", cwd: projectRoot, sync_memory: false })).rejects.toThrow(/claude CLI not found/);
  });
});

describe("claude_delegate — background mode + claude_delegate_status", () => {
  it("returns a job_id immediately, then reflects done status once the spawn closes", async () => {
    const started = parse(await claudeDelegateTool.invoke({ task: "long task", cwd: projectRoot, background: true, sync_memory: false }));
    expect(started.status).toBe("running");
    expect(typeof started.job_id).toBe("string");

    // finalizeRun shells out to real `git` (unmocked) for the diff summary,
    // so wait for the job to actually settle instead of a single microtask.
    let status: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      status = parse(await claudeDelegateStatusTool.invoke({ job_id: started.job_id as string }));
      if (status.status !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(status.status).toBe("done");
    const result = status.result as Record<string, unknown>;
    expect(result.session_id).toBe(started.session_id);
  });

  it("cancel kills the child and the job stays cancelled even if the process later reports done", async () => {
    state.autoClose = false; // hold the process open — we cancel before it would close
    const started = parse(await claudeDelegateTool.invoke({ task: "long task", cwd: projectRoot, background: true, sync_memory: false }));

    const cancelled = parse(await claudeDelegateStatusTool.invoke({ job_id: started.job_id as string, action: "cancel" }));
    expect(cancelled.status).toBe("cancelled");
    expect(state.killSpies.at(-1)).toHaveBeenCalledWith("SIGTERM");

    const status = parse(await claudeDelegateStatusTool.invoke({ job_id: started.job_id as string }));
    expect(status.status).toBe("cancelled");
  });

  it("cancel on an unknown job_id throws", async () => {
    await expect(claudeDelegateStatusTool.invoke({ job_id: "does-not-exist", action: "cancel" })).rejects.toThrow(/No running job/);
  });
});
