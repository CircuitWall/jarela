import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkExecAllowed, checkFsAllowed, resolveSafetyMode } from "./safety";

const ORIGINAL = process.env.JARELA_TOOL_SAFETY;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JARELA_TOOL_SAFETY;
  else process.env.JARELA_TOOL_SAFETY = ORIGINAL;
});

describe("resolveSafetyMode", () => {
  it("defaults to mostly_safe", () => {
    delete process.env.JARELA_TOOL_SAFETY;
    expect(resolveSafetyMode()).toBe("mostly_safe");
  });
  it("accepts safe / mostly_safe / bypass", () => {
    process.env.JARELA_TOOL_SAFETY = "safe";
    expect(resolveSafetyMode()).toBe("safe");
    process.env.JARELA_TOOL_SAFETY = "BYPASS";
    expect(resolveSafetyMode()).toBe("bypass");
    process.env.JARELA_TOOL_SAFETY = "unsafe";
    expect(resolveSafetyMode()).toBe("bypass");
    process.env.JARELA_TOOL_SAFETY = "garbage";
    expect(resolveSafetyMode()).toBe("mostly_safe");
  });
});

describe("checkExecAllowed - bypass", () => {
  it("allows anything", () => {
    expect(checkExecAllowed("rm -rf /", { mode: "bypass", blockedByPattern: true }).allowed).toBe(true);
  });
});

describe("checkExecAllowed - mostly_safe", () => {
  it("blocks dangerous pattern without allow_unsafe", () => {
    const r = checkExecAllowed("rm -rf /", { mode: "mostly_safe", blockedByPattern: true });
    expect(r.allowed).toBe(false);
  });
  it("permits dangerous pattern with allow_unsafe", () => {
    const r = checkExecAllowed("rm -rf /", { mode: "mostly_safe", blockedByPattern: true, allowUnsafe: true });
    expect(r.allowed).toBe(true);
  });
  it("permits normal commands", () => {
    expect(checkExecAllowed("ls -la", { mode: "mostly_safe", blockedByPattern: false }).allowed).toBe(true);
  });
});

describe("checkExecAllowed - safe", () => {
  const opts = { mode: "safe" as const, blockedByPattern: false };
  it("allows ls", () => {
    expect(checkExecAllowed("ls -la", opts).allowed).toBe(true);
  });
  it("allows git status", () => {
    expect(checkExecAllowed("git status", opts).allowed).toBe(true);
  });
  it("blocks git push", () => {
    expect(checkExecAllowed("git push origin main", opts).allowed).toBe(false);
  });
  it("blocks unknown commands", () => {
    expect(checkExecAllowed("rm file", opts).allowed).toBe(false);
  });
  it("blocks pipelines and composition", () => {
    expect(checkExecAllowed("ls | grep foo", opts).allowed).toBe(false);
    expect(checkExecAllowed("ls && pwd", opts).allowed).toBe(false);
    expect(checkExecAllowed("ls; pwd", opts).allowed).toBe(false);
    expect(checkExecAllowed("ls > out.txt", opts).allowed).toBe(false);
    expect(checkExecAllowed("echo $(whoami)", opts).allowed).toBe(false);
  });
  it("blocks tools that execute arbitrary code", () => {
    expect(checkExecAllowed("node -e 'process.exit()'", opts).allowed).toBe(false);
    expect(checkExecAllowed("python -c 'print(1)'", opts).allowed).toBe(false);
    expect(checkExecAllowed("npx some-pkg", opts).allowed).toBe(false);
  });
  it("ignores allow_unsafe", () => {
    expect(
      checkExecAllowed("rm -rf /", { mode: "safe", blockedByPattern: true, allowUnsafe: true }).allowed,
    ).toBe(false);
  });
  it("rejects empty command", () => {
    expect(checkExecAllowed("   ", opts).allowed).toBe(false);
  });
});

describe("checkFsAllowed", () => {
  it("bypass + mostly_safe always permit", () => {
    expect(checkFsAllowed("write", { mode: "bypass" }).allowed).toBe(true);
    expect(checkFsAllowed("write", { mode: "mostly_safe" }).allowed).toBe(true);
    expect(checkFsAllowed("read", { mode: "bypass" }).allowed).toBe(true);
    expect(checkFsAllowed("read", { mode: "mostly_safe" }).allowed).toBe(true);
  });
  it("safe permits reads, blocks writes", () => {
    expect(checkFsAllowed("read", { mode: "safe" }).allowed).toBe(true);
    expect(checkFsAllowed("write", { mode: "safe" }).allowed).toBe(false);
  });
});
