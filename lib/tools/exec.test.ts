import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
