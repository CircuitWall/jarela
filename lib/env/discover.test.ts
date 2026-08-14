import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";

const mockedSpawn = vi.mocked(spawn);

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; kill: (signal?: string) => void };
  child.stdout = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("discoverAllShellEnv", () => {
  const originalEnv = { ...process.env };
  const originalPlatform = process.platform;

  beforeEach(() => {
    process.env = { ...originalEnv, SHELL: "/bin/zsh" };
    mockedSpawn.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it.skipIf(process.platform === "win32")("parses a full env -0 dump framed by sentinels, including multi-'=' values", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const { discoverAllShellEnv } = await import("./discover");
    const promise = discoverAllShellEnv();

    const dump = "FOO=bar\0PATH=/opt/homebrew/bin:/usr/bin\0MULTI=a=b\0";
    child.stdout.emit("data", Buffer.from(`noise\n__JARELA_ENV_BEGIN__${dump}__JARELA_ENV_END__\n`));
    child.emit("close", 0);

    const result = await promise;
    expect(result.source).toBe("shell-rc");
    expect(result.values.FOO).toBe("bar");
    expect(result.values.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    expect(result.values.MULTI).toBe("a=b");
  });

  it.skipIf(process.platform === "win32")("falls back to process.env when the shell probe errors", async () => {
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    process.env.CUSTOM_VAR = "from-process-env";

    const { discoverAllShellEnv } = await import("./discover");
    const promise = discoverAllShellEnv();
    child.emit("error", new Error("spawn failed"));

    const result = await promise;
    expect(result.source).toBe("process");
    expect(result.values.CUSTOM_VAR).toBe("from-process-env");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("queries the Windows User registry via PowerShell and layers it over process.env", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.CUSTOM_VAR = "windows-process-value";
    const child = fakeChild();
    mockedSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const { discoverAllShellEnv } = await import("./discover");
    const promise = discoverAllShellEnv();
    child.stdout.emit("data", Buffer.from("__JARELA_ENV_BEGIN__REG_VAR=reg-value__JARELA_ENV_END__\n"));
    child.emit("close", 0);

    const result = await promise;
    expect(result.source).toBe("windows-registry");
    expect(result.shell).toBe("powershell");
    expect(result.values.REG_VAR).toBe("reg-value");
    expect(result.values.CUSTOM_VAR).toBe("windows-process-value");
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it("falls back to process.env when both Windows registry probe attempts (pwsh + powershell) fail", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.CUSTOM_VAR = "windows-process-value";
    mockedSpawn.mockImplementation(() => {
      const c = fakeChild();
      queueMicrotask(() => c.emit("error", new Error("spawn failed")));
      return c as unknown as ReturnType<typeof spawn>;
    });

    const { discoverAllShellEnv } = await import("./discover");
    const result = await discoverAllShellEnv();

    expect(result.source).toBe("process");
    expect(result.values.CUSTOM_VAR).toBe("windows-process-value");
    expect(mockedSpawn).toHaveBeenCalledTimes(2);
  });
});
