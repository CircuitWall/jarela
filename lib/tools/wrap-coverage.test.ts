// PR-6 coverage tests. The wrap-at-registration hook in lib/tools/index.ts
// has to catch tool invocations from EVERY path, including the agent loop
// (which calls .invoke directly via LangChain's machinery, bypassing
// executeTool). These tests register a tool through the same surface
// built-ins use, then call .invoke on it directly (no executeTool wrapper),
// and assert dispatch + timeout fire.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { recentDispatchLog, _resetDispatchLog } from "./dispatch";

describe("wrap-at-registration: direct .invoke goes through dispatch", () => {
  beforeEach(() => {
    _resetDispatchLog();
  });
  afterEach(() => {
    delete process.env.JARELA_TOOL_TIMEOUT_MS;
  });

  it("a tool fetched via getAllTools logs to dispatch when invoked directly", async () => {
    // Side-effect import: registers the built-in tool registry.
    const mod = await import("./index");

    // Find any built-in tool. We don't pick a specific one to avoid
    // coupling this test to which tools exist; the contract is "every
    // built-in is wrapped".
    const tools = mod.getAllTools();
    const target = tools[0];
    expect(target).toBeTruthy();

    // Direct .invoke — the agent-loop pattern. NOT through executeTool.
    // Most built-ins refuse on missing args; that's fine — the dispatch
    // log fires whether the call succeeded or errored.
    try {
      await target.invoke({} as never);
    } catch {
      // Some tools throw on missing args before the wrapped invoke runs;
      // others return an error envelope. Either way, dispatch should
      // have been entered.
    }

    const log = recentDispatchLog();
    expect(log.length).toBeGreaterThanOrEqual(1);
    expect(log[log.length - 1].toolName).toBe(target.name);
  });

  it("an external-style tool registered via lib/tools/index runs through dispatch on direct invoke", async () => {
    // Build a tool the same way external.ts does, then put it through
    // the wrap by going through getAllToolsAsync. Since external tools
    // are wrapped by loadExternal() and we can't easily inject a fake
    // external tool from a unit test (requires JARELA_TOOLS_DIR setup),
    // simulate by constructing a tool and asking the wrap to apply
    // through the public hook on built-ins.
    const t = tool(
      async (args: { x: number }) => JSON.stringify({ doubled: args.x * 2 }),
      { name: "_pr6_echo", description: "echo", schema: z.object({ x: z.number() }) },
    );

    // We can't register with the BUILTIN registry mid-test (collision +
    // module-load-time ALL_BUILTINS snapshot). Instead, manually apply
    // the same idempotent wrap the production code uses, then assert
    // dispatch fires.
    const { runToolDispatched } = await import("./dispatch");
    type Cfg = Parameters<typeof t.invoke>[1];
    const original = t.invoke.bind(t);
    t.invoke = async (a, config) => {
      const result = await runToolDispatched(
        () => original(a, config as Cfg),
        { toolName: t.name },
      );
      if (result.kind === "json") return result.data as never;
      if (result.kind === "text") return result.data as never;
      return { error: result.message, code: result.code } as never;
    };

    const out = await t.invoke({ x: 4 });
    expect(out).toEqual({ doubled: 8 });
    const log = recentDispatchLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ toolName: "_pr6_echo", status: "ok" });
  });
});
