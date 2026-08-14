import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// External (.cjs) tools and MCP tools never passed through
// registerTools()'s wrapWithWallclock call — they had no wall-clock
// protection at all, unlike built-ins. getAllTools/getAllToolsAsync now
// wrap them at the merge point instead. See lib/tools/index.ts.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-ext-wallclock-"));
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;
process.env.JARELA_DB_DIR = join(tmpRoot, ".jarela-dbdir");
process.env.JARELA_TOOLS_DIR = join(tmpRoot, "tools");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

mkdirSync(join(tmpRoot, "tools"), { recursive: true });
writeFileSync(
  join(tmpRoot, "tools", "slow-tool.cjs"),
  `module.exports = {
    name: "slow_ext_tool",
    description: "sleeps then returns",
    schema: { type: "object", properties: {} },
    run: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true };
    },
  };`,
);

const { getAllTools } = await import("./index");
const { _resetExternalCache } = await import("./external");

describe("external tools get wallclock protection via getAllTools", () => {
  it("races a slow external tool against deadline_ms and returns a structured timeout instead of hanging", async () => {
    _resetExternalCache();
    const tool = getAllTools().find((t) => t.name === "slow_ext_tool");
    expect(tool).toBeDefined();

    const out = await tool!.invoke({ deadline_ms: 20 } as never);
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error_code).toBe("tool_timeout");
  });

  it("still returns the real result when the external tool finishes inside the budget", async () => {
    _resetExternalCache();
    const tool = getAllTools().find((t) => t.name === "slow_ext_tool");
    const out = await tool!.invoke({ deadline_ms: 1000 } as never);
    expect(JSON.parse(out as string)).toEqual({ ok: true });
  });
});
