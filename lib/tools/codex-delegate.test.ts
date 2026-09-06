import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: () => "win32",
}));

const { buildCodexArgs, resolveCodexLaunch } = await import("./codex-delegate");

describe("buildCodexArgs", () => {
  it("uses Codex JSON output and a read-only sandbox by default", () => {
    expect(buildCodexArgs("inspect the repo", undefined, false)).toEqual([
      "exec", "--json", "--sandbox", "read-only", "inspect the repo",
    ]);
  });

  it("allows workspace writes only after explicit unsafe escalation", () => {
    expect(buildCodexArgs("fix the test", "gpt-5.6-codex", true)).toEqual([
      "exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5.6-codex", "fix the test",
    ]);
  });

  it("launches npm-installed Codex through Node on Windows", () => {
    const result = resolveCodexLaunch("codex", ["login", "status"], process.env.APPDATA);
    expect(result.command).toBe(process.execPath);
    expect(result.args.at(-2)).toBe("login");
    expect(result.args.at(-1)).toBe("status");
    expect(result.args[0]).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
  });
});