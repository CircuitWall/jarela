import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool } from "@langchain/core/tools";
import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

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

const { getAllTools, executeTool } = await import("../index");
const { _resetExternalCache } = await import("./external");

describe("external tools get wallclock protection via getAllTools", () => {
  it("retains workflow execution when a parent LangChain tool supplies an inherited abort signal", async () => {
    AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let work!: Promise<unknown>;
    let settled = false;
    const parent = tool(async () => {
      work = executeTool("slow_ext_tool", { deadline_ms: 1 }, {
        signal: controller.signal, await_tool_settlement: true,
      });
      void work.then(() => { settled = true; }, () => { settled = true; });
      started();
      return work;
    }, { name: "parent", description: "Synthetic parent tool", schema: { type: "object", properties: {} } });
    const parentResult = parent.invoke({}, { signal: controller.signal }).catch((error: unknown) => error);
    await ready;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(settled).toBe(false);
    expect(await work).toEqual({ ok: true });
    expect(await parentResult).toBeInstanceOf(Error);
  });

  it("does not start a coordinator-owned tool when the caller already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before execution"));
    await expect(executeTool("slow_ext_tool", {}, {
      signal: controller.signal, await_tool_settlement: true,
    })).rejects.toThrow("Cancelled before execution");
  });

  it.each([false, true])("retains workflow execution through deadline and caller abort (async_run=%s)", async (asyncRun) => {
    _resetExternalCache();
    const controller = new AbortController();
    let settled = false;
    const work = executeTool("slow_ext_tool", { deadline_ms: 1, async_run: asyncRun }, {
      signal: controller.signal, await_tool_settlement: true,
    }).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(await work).toEqual({ ok: true });
  });

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
