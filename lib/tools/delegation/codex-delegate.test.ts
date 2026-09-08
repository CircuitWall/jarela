import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: () => "win32",
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  existsSync: () => true,
}));

const { buildCodexArgs, resolveCodexLaunch, resolveCodexWorkspace } = await import("./codex-delegate");
const WINDOWS_APP_DATA = process.env.APPDATA ?? "C:\\Users\\runner\\AppData\\Roaming";

describe("buildCodexArgs", () => {
  it("uses Codex JSON output and a read-only sandbox by default", () => {
    expect(buildCodexArgs("inspect the repo", undefined, undefined, undefined, false)).toEqual([
      "exec", "--json", "--sandbox", "read-only", "inspect the repo",
    ]);
  });

  it("allows workspace writes only after explicit unsafe escalation", () => {
    expect(buildCodexArgs("fix the test", "gpt-5.6-codex", undefined, undefined, true)).toEqual([
      "exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5.6-codex", "fix the test",
    ]);
  });

  it("passes a trusted Codex profile and explicit extra writable directories", () => {
    expect(buildCodexArgs("work on the app", undefined, "work", ["C:\\shared"], true)).toEqual([
      "exec", "--json", "--sandbox", "workspace-write", "--profile", "work", "--add-dir", "C:\\shared", "work on the app",
    ]);
  });

  it("launches npm-installed Codex through Node on Windows", () => {
    const result = resolveCodexLaunch("codex", ["login", "status"], WINDOWS_APP_DATA);
    expect(result.command).toBe(process.execPath);
    expect(result.args.at(-2)).toBe("login");
    expect(result.args.at(-1)).toBe("status");
    expect(result.args[0]).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  });

  it("launches a configured npm cmd shim through Node on Windows", () => {
    const launcher = `${WINDOWS_APP_DATA}\\npm\\codex.cmd`;
    const result = resolveCodexLaunch(launcher, ["exec", "task"], WINDOWS_APP_DATA);
    expect(result.command).toBe(process.execPath);
    expect(result.args).toEqual(expect.arrayContaining(["exec", "task"]));
    expect(result.args[0]).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  });

  it("requires an explicit or active workspace instead of using the server cwd", () => {
    expect(resolveCodexWorkspace(undefined, undefined)).toBeNull();
    expect(resolveCodexWorkspace(undefined, "C:\\work\\repo")).toBe("C:\\work\\repo");
    expect(resolveCodexWorkspace(" C:\\other\\repo ", "C:\\work\\repo")).toBe("C:\\other\\repo");
  });
});