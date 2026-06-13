import { describe, it, expect, beforeEach, vi } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { registerLangChainPackage } from "./langchain-package";
import {
  registeredNames,
  registeredCategory,
  registeredCapability,
  _resetRegistry,
} from "./registry";

vi.mock("@/lib/stores/integrations", () => {
  const raw: Record<string, Record<string, string> | undefined> = {};
  return {
    getIntegrationRaw: (name: string) => raw[name] ?? null,
    __setIntegrationRawForTest: (name: string, value: Record<string, string> | undefined) => {
      raw[name] = value;
    },
  };
});

function mkTool(name: string) {
  return tool(async () => "ok", { name, description: name, schema: z.object({}) });
}

describe("registerLangChainPackage", () => {
  beforeEach(() => _resetRegistry());

  it("registers each capability bucket once and maps category/capability", () => {
    registerLangChainPackage({
      category: "Memory",
      tools: {
        read: [mkTool("p_read")],
        write: [mkTool("p_write_1"), mkTool("p_write_2")],
      },
    });

    expect(registeredCategory("p_read")).toBe("Memory");
    expect(registeredCategory("p_write_1")).toBe("Memory");
    expect(registeredCapability("p_read")).toBe("read");
    expect(registeredCapability("p_write_1")).toBe("write");
  });

  it("skips empty buckets without throwing", () => {
    expect(() =>
      registerLangChainPackage({
        category: "Files",
        tools: { read: [mkTool("only_read")] },
      }),
    ).not.toThrow();
    expect(registeredNames().has("only_read")).toBe(true);
  });

  it("unregister handle removes every tool the package registered", () => {
    const handle = registerLangChainPackage({
      category: "Web",
      tools: {
        read: [mkTool("pkg_r")],
        execute: [mkTool("pkg_x")],
      },
    });
    expect(registeredNames().has("pkg_r")).toBe(true);
    expect(registeredNames().has("pkg_x")).toBe(true);

    handle.unregister();
    expect(registeredNames().has("pkg_r")).toBe(false);
    expect(registeredNames().has("pkg_x")).toBe(false);
  });

  it("unregister allows the same names to be re-registered (hot-reload)", () => {
    const a = registerLangChainPackage({
      category: "Web",
      tools: { read: [mkTool("hot")] },
    });
    a.unregister();
    expect(() =>
      registerLangChainPackage({
        category: "Files",
        tools: { read: [mkTool("hot")] },
      }),
    ).not.toThrow();
    expect(registeredCategory("hot")).toBe("Files");
  });

  it("no-auth resolveAuth surfaces a descriptive error", () => {
    const handle = registerLangChainPackage({
      category: "Web",
      tools: { read: [mkTool("noauth")] },
    });
    const result = handle.resolveAuth();
    expect(result).toEqual({ error: expect.stringContaining("no auth bridge") });
  });

  it("with auth bridge, env wins over DB and is forwarded via setAuthResolver", () => {
    let captured: (() => unknown) | null = null;
    const handle = registerLangChainPackage<{ token: string }>({
      category: "Web",
      tools: { read: [mkTool("withauth")] },
      auth: {
        integrationId: "fake-integration",
        setAuthResolver: (fn) => { captured = fn; },
        resolveAuthFromEnv: () => ({ token: "env-token" }),
        mapStoreFields: () => null,
        notConfiguredError: "not configured",
      },
    });

    expect(captured).toBeTypeOf("function");
    expect(handle.resolveAuth()).toEqual({ token: "env-token" });
    expect((captured as unknown as () => unknown)()).toEqual({ token: "env-token" });
  });

  it("falls back to mapStoreFields when env resolver returns an error and store is non-empty", async () => {
    const integrations = (await import("@/lib/stores/integrations")) as unknown as {
      __setIntegrationRawForTest: (n: string, v: Record<string, string> | undefined) => void;
    };
    integrations.__setIntegrationRawForTest("github", { token: "ghp_from_db" });
    try {
      const handle = registerLangChainPackage<{ token: string }>({
        category: "Web",
        tools: { read: [mkTool("dbfallback")] },
        auth: {
          integrationId: "github",
          setAuthResolver: () => {},
          resolveAuthFromEnv: () => ({ error: "env empty" }),
          mapStoreFields: (raw) => (raw.token ? { token: raw.token } : null),
          notConfiguredError: "should not be returned",
        },
      });
      expect(handle.resolveAuth()).toEqual({ token: "ghp_from_db" });
    } finally {
      integrations.__setIntegrationRawForTest("github", undefined);
    }
  });

  it("returns notConfiguredError when both env and DB are empty", () => {
    const handle = registerLangChainPackage<{ token: string }>({
      category: "Web",
      tools: { read: [mkTool("unconfigured")] },
      auth: {
        integrationId: "github",
        setAuthResolver: () => {},
        resolveAuthFromEnv: () => ({ error: "env empty" }),
        mapStoreFields: () => null,
        notConfiguredError: "must configure github",
      },
    });
    expect(handle.resolveAuth()).toEqual({ error: "must configure github" });
  });
});
