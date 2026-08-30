import { describe, it, expect, beforeEach } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  registerTools,
  registeredTools,
  registeredNames,
  registeredCategory,
  registeredCapability,
  registeredGroup,
  groupForCategory,
  unregisterTools,
  BUILTIN_CATEGORIES,
  _resetRegistry,
} from "./registry";

function mkTool(name: string) {
  return tool(async () => "ok", {
    name,
    description: name,
    schema: z.object({}),
  });
}

describe("tool registry", () => {
  beforeEach(() => _resetRegistry());

  it("registers tools and exposes them in insertion order", () => {
    const a = mkTool("a");
    const b = mkTool("b");
    registerTools("Files", "read", [a]);
    registerTools("Web", "read", [b]);

    expect(registeredTools().map((t) => t.name)).toEqual(["a", "b"]);
    expect(registeredNames().has("a")).toBe(true);
    expect(registeredNames().has("b")).toBe(true);
  });

  it("tracks category per tool", () => {
    registerTools("Files", "read", [mkTool("read")]);
    registerTools("Web", "read", [mkTool("fetch")]);
    expect(registeredCategory("read")).toBe("Files");
    expect(registeredCategory("fetch")).toBe("Web");
    expect(registeredCategory("missing")).toBeUndefined();
  });

  it("tracks capability per tool", () => {
    registerTools("Files", "read", [mkTool("file_read")]);
    registerTools("Files", "write", [mkTool("file_write")]);
    registerTools("Shell", "execute", [mkTool("local_exec")]);
    expect(registeredCapability("file_read")).toBe("read");
    expect(registeredCapability("file_write")).toBe("write");
    expect(registeredCapability("local_exec")).toBe("execute");
    expect(registeredCapability("missing")).toBeUndefined();
  });

  it("maps Basic and Work categories to their parent groups", () => {
    registerTools("Atlassian", "read", [mkTool("jira_x")]);
    registerTools("JiraAlign", "read", [mkTool("align_x")]);
    registerTools("GitHub", "read", [mkTool("gh_x")]);
    registerTools("Files", "read", [mkTool("file_x")]);

    expect(registeredGroup("jira_x")).toBe("Work");
    expect(registeredGroup("align_x")).toBe("Work");
    expect(registeredGroup("gh_x")).toBe("Work");
    expect(registeredGroup("file_x")).toBe("Basic");
  });

  it("throws on duplicate registration (collision is a bug)", () => {
    registerTools("Files", "read", [mkTool("dupe")]);
    expect(() => registerTools("Web", "read", [mkTool("dupe")])).toThrow(/duplicate/i);
  });

  it("registers multiple tools in a single call", () => {
    registerTools("Memory", "read", [mkTool("m1"), mkTool("m2"), mkTool("m3")]);
    expect(registeredTools()).toHaveLength(3);
    expect(registeredCategory("m2")).toBe("Memory");
    expect(registeredCapability("m2")).toBe("read");
  });

  it("supports the same category split across multiple capability calls", () => {
    registerTools("Memory", "read", [mkTool("memory_read"), mkTool("memory_list")]);
    registerTools("Memory", "write", [mkTool("memory_write")]);

    expect(registeredCategory("memory_read")).toBe("Memory");
    expect(registeredCategory("memory_write")).toBe("Memory");
    expect(registeredCapability("memory_read")).toBe("read");
    expect(registeredCapability("memory_write")).toBe("write");
  });

  it("unregisterTools removes named entries and reports the count", () => {
    registerTools("Files", "read", [mkTool("u1"), mkTool("u2")]);
    registerTools("Files", "write", [mkTool("u3")]);

    expect(registeredNames().has("u1")).toBe(true);
    expect(unregisterTools(["u1", "u3", "missing"])).toBe(2);
    expect(registeredNames().has("u1")).toBe(false);
    expect(registeredNames().has("u2")).toBe(true);
    expect(registeredNames().has("u3")).toBe(false);
    expect(registeredCategory("u1")).toBeUndefined();
  });

  it("unregisterTools makes the name available for a fresh registration", () => {
    registerTools("Files", "read", [mkTool("recycle")]);
    expect(() => registerTools("Web", "read", [mkTool("recycle")])).toThrow(/duplicate/i);
    unregisterTools(["recycle"]);
    expect(() => registerTools("Web", "read", [mkTool("recycle")])).not.toThrow();
    expect(registeredCategory("recycle")).toBe("Web");
  });

  it("BUILTIN_CATEGORIES lists every non-MCP category (including Microsoft / Agent)", () => {
    // Regression guard for the "unknown category: iCloud" 400 that hit the
    // `PATCH /api/v1/builtin-tools` route when a hardcoded allowlist drifted
    // away from the `BuiltinCategory` type. Anything that renders a
    // per-category toggle or validates a category over the wire MUST derive
    // from this list, and this test ensures the list stays complete.
    const required = [
      "Memory", "Documents", "Files", "Shell", "Web", "Images", "Voice",
      "Schedule", "Atlassian", "JiraAlign", "GitHub", "Mail", "Calendar",
      "Tasks", "Microsoft", "Config", "Agent", "Skills",
    ];
    for (const cat of required) {
      expect(BUILTIN_CATEGORIES).toContain(cat);
    }
    expect(BUILTIN_CATEGORIES).not.toContain("MCP");
    // iCloud used to be its own category; its tools now live under Mail /
    // Calendar / Tasks alongside Gmail / Outlook / MS To-Do.
    expect(BUILTIN_CATEGORIES).not.toContain("iCloud");
  });
});

describe("groupForCategory", () => {
  it("returns Work for known Work-grouped categories", () => {
    expect(groupForCategory("Atlassian")).toBe("Work");
    expect(groupForCategory("GitHub")).toBe("Work");
    expect(groupForCategory("Tasks")).toBe("Work");
    expect(groupForCategory("Microsoft")).toBe("Work");
    expect(groupForCategory("JiraAlign")).toBe("Work");
  });

  it("returns Basic for known Basic categories", () => {
    expect(groupForCategory("Files")).toBe("Basic");
    expect(groupForCategory("Web")).toBe("Basic");
    expect(groupForCategory("Memory")).toBe("Basic");
    expect(groupForCategory("Config")).toBe("Basic");
    expect(groupForCategory("Schedule")).toBe("Basic");
    expect(groupForCategory("Skills")).toBe("Basic");
  });

  it("returns null for ungrouped built-in categories", () => {
    expect(groupForCategory("Images")).toBeNull();
    expect(groupForCategory("Voice")).toBeNull();
    expect(groupForCategory("Calendar")).toBeNull();
  });

  it("returns null for MCP", () => {
    expect(groupForCategory("MCP")).toBeNull();
  });

  it("returns null for unknown custom categories without throwing", () => {
    expect(groupForCategory("Notion")).toBeNull();
    expect(groupForCategory("")).toBeNull();
    expect(groupForCategory("some-made-up-category")).toBeNull();
  });
});
