import { describe, it, expect, vi } from "vitest";

const enabledRef = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/stores/app-settings", () => ({
  isRedactionEnabled: () => enabledRef.value,
}));

import { withMaskRun, getCurrentMaskContext } from "./context";
import { wrapToolForRehydrate, wrapToolsForRehydrate } from "./wrap-tools";

const FAKE_ANT = "sk-ant-abc123def456ghi789jkl000"; // jarela-secret-ok

function fakeTool() {
  const calls: unknown[] = [];
  // Minimal shape — wrapToolForRehydrate uses Proxy with `invoke` only;
  // metadata fields like name/description/schema flow through via Reflect.
  const tool = {
    name: "send_email",
    description: "Send an email",
    schema: { type: "object", properties: {}, required: [] },
    async invoke(input: unknown) {
      calls.push(input);
      return "ok";
    },
  };
  return { tool, calls };
}

describe("wrapToolForRehydrate", () => {
  it("preserves passthrough fields (name, description, schema)", () => {
    const { tool } = fakeTool();
    // Cast through unknown — the test fake intentionally has a thin shape
    // that satisfies the Proxy's runtime needs without implementing the
    // full LangChain StructuredToolInterface.
    const wrapped = wrapToolForRehydrate(tool as unknown as Parameters<typeof wrapToolForRehydrate>[0]);
    expect((wrapped as unknown as { name: string }).name).toBe("send_email");
    expect((wrapped as unknown as { description: string }).description).toBe("Send an email");
    expect((wrapped as unknown as { schema: unknown }).schema).toBe(tool.schema);
  });

  it("rehydrates string args before invoking the underlying tool", async () => {
    enabledRef.value = true;
    const { tool, calls } = fakeTool();
    const wrapped = wrapToolForRehydrate(tool as unknown as Parameters<typeof wrapToolForRehydrate>[0]);
    await withMaskRun(async () => {
      const ctx = getCurrentMaskContext()!;
      const { text: maskedBody } = ctx.maskText(`Body: ${FAKE_ANT}`);
      expect(maskedBody).not.toContain(FAKE_ANT);
      // Simulate the model emitting the placeholder inside a tool arg.
      await (wrapped as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({
        body: maskedBody,
      });
    });
    expect(calls).toHaveLength(1);
    const arg = calls[0] as { body: string };
    expect(arg.body).toContain(FAKE_ANT);
    expect(arg.body).not.toMatch(/«SECRET:/);
  });

  it("walks nested objects and arrays during rehydrate", async () => {
    enabledRef.value = true;
    const { tool, calls } = fakeTool();
    const wrapped = wrapToolForRehydrate(tool as unknown as Parameters<typeof wrapToolForRehydrate>[0]);
    await withMaskRun(async () => {
      const ctx = getCurrentMaskContext()!;
      const { text: masked } = ctx.maskText(`token ${FAKE_ANT}`);
      await (wrapped as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({
        nested: { items: [{ msg: masked }] },
      });
    });
    const arg = calls[0] as { nested: { items: Array<{ msg: string }> } };
    expect(arg.nested.items[0].msg).toContain(FAKE_ANT);
  });

  it("passes input through unchanged when no MaskRunContext is active", async () => {
    enabledRef.value = true;
    const { tool, calls } = fakeTool();
    const wrapped = wrapToolForRehydrate(tool as unknown as Parameters<typeof wrapToolForRehydrate>[0]);
    await (wrapped as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({
      body: "no context, no rehydrate",
    });
    expect(calls[0]).toEqual({ body: "no context, no rehydrate" });
  });

  it("preserves primitive args (numbers, booleans, null) without transforming", async () => {
    enabledRef.value = true;
    const { tool, calls } = fakeTool();
    const wrapped = wrapToolForRehydrate(tool as unknown as Parameters<typeof wrapToolForRehydrate>[0]);
    await withMaskRun(async () => {
      await (wrapped as unknown as { invoke: (i: unknown) => Promise<unknown> }).invoke({
        n: 42,
        b: true,
        z: null,
      });
    });
    expect(calls[0]).toEqual({ n: 42, b: true, z: null });
  });
});

describe("wrapToolsForRehydrate", () => {
  it("wraps every tool in the input array", () => {
    const { tool: a } = fakeTool();
    const { tool: b } = fakeTool();
    const wrapped = wrapToolsForRehydrate([
      a as unknown as Parameters<typeof wrapToolsForRehydrate>[0][number],
      b as unknown as Parameters<typeof wrapToolsForRehydrate>[0][number],
    ]);
    expect(wrapped).toHaveLength(2);
    expect((wrapped[0] as unknown as { name: string }).name).toBe("send_email");
    expect((wrapped[1] as unknown as { name: string }).name).toBe("send_email");
  });
});
