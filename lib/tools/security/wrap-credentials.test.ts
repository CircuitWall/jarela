import { describe, it, expect, vi } from "vitest";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  wrapToolForCredentialRouting,
  wrapToolsForCredentialRouting,
} from "./wrap-credentials";
import {
  getCurrentToolCredentialContext,
} from "./credential-context";

// Minimal stand-in for a LangChain tool. Only the bits the wrapper touches
// (name + invoke) need to exist; the rest is reachable through the Proxy
// via Reflect.get so we don't need a real StructuredTool here.
function makeTool(name: string, onInvoke: (input: unknown) => unknown) {
  return {
    name,
    description: `${name} test stub`,
    schema: { type: "object" as const },
    extra: "passthrough",
    invoke: vi.fn(async (input: unknown) => onInvoke(input)),
  } as unknown as StructuredToolInterface;
}

describe("wrapToolForCredentialRouting", () => {
  it("enters an ALS frame with the tool's name and the supplied override map on invoke", async () => {
    let observed: ReturnType<typeof getCurrentToolCredentialContext> = null;
    const t = makeTool("github_create_issue", () => {
      observed = getCurrentToolCredentialContext();
      return "ok";
    });
    const wrapped = wrapToolForCredentialRouting(t, {
      github_create_issue: "integration-github-work",
    });
    await wrapped.invoke({});
    expect(observed).not.toBeNull();
    expect(observed!.toolName).toBe("github_create_issue");
    expect(observed!.toolCredentials).toEqual({
      github_create_issue: "integration-github-work",
    });
  });

  it("does not leak the ALS frame outside the invocation", async () => {
    const t = makeTool("gmail_send", () => "ok");
    const wrapped = wrapToolForCredentialRouting(t, { gmail_send: "integration-gmail-work" });
    await wrapped.invoke({});
    expect(getCurrentToolCredentialContext()).toBeNull();
  });

  it("preserves the proxied tool's other properties (name, description, extras)", () => {
    const t = makeTool("noop", () => null);
    const wrapped = wrapToolForCredentialRouting(t, {});
    expect(wrapped.name).toBe("noop");
    expect((wrapped as unknown as { description: string }).description).toBe("noop test stub");
    expect((wrapped as unknown as { extra: string }).extra).toBe("passthrough");
  });
});

describe("wrapToolsForCredentialRouting", () => {
  it("returns the original array reference when the override map is empty (fast path)", () => {
    const tools = [makeTool("a", () => null), makeTool("b", () => null)];
    const out = wrapToolsForCredentialRouting(tools, {});
    expect(out).toBe(tools);
  });

  it("wraps every tool when at least one override is set", async () => {
    let seenA: ReturnType<typeof getCurrentToolCredentialContext> = null;
    let seenB: ReturnType<typeof getCurrentToolCredentialContext> = null;
    const a = makeTool("a", () => { seenA = getCurrentToolCredentialContext(); });
    const b = makeTool("b", () => { seenB = getCurrentToolCredentialContext(); });
    const out = wrapToolsForCredentialRouting([a, b], { a: "credential-a" });

    await out[0]!.invoke({});
    await out[1]!.invoke({});

    expect(seenA).not.toBeNull();
    expect(seenB).not.toBeNull();
    expect(seenA!.toolName).toBe("a");
    expect(seenB!.toolName).toBe("b");
    // The full map is the same for both — only the toolName changes.
    expect(seenA!.toolCredentials).toEqual({ a: "credential-a" });
    expect(seenB!.toolCredentials).toEqual({ a: "credential-a" });
  });
});
