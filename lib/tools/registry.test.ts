import { describe, it, expect, beforeEach } from "vitest";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  registerTools,
  registeredTools,
  registeredNames,
  registeredCategory,
  registeredGroup,
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
    registerTools("Files", [a]);
    registerTools("Web", [b]);

    expect(registeredTools().map((t) => t.name)).toEqual(["a", "b"]);
    expect(registeredNames().has("a")).toBe(true);
    expect(registeredNames().has("b")).toBe(true);
  });

  it("tracks category per tool", () => {
    registerTools("Files", [mkTool("read")]);
    registerTools("Web", [mkTool("fetch")]);
    expect(registeredCategory("read")).toBe("Files");
    expect(registeredCategory("fetch")).toBe("Web");
    expect(registeredCategory("missing")).toBeUndefined();
  });

  it("maps Atlassian/JiraAlign/GitHub to the Work group", () => {
    registerTools("Atlassian", [mkTool("jira_x")]);
    registerTools("JiraAlign", [mkTool("align_x")]);
    registerTools("GitHub", [mkTool("gh_x")]);
    registerTools("Files", [mkTool("file_x")]);

    expect(registeredGroup("jira_x")).toBe("Work");
    expect(registeredGroup("align_x")).toBe("Work");
    expect(registeredGroup("gh_x")).toBe("Work");
    expect(registeredGroup("file_x")).toBeNull();
  });

  it("throws on duplicate registration (collision is a bug)", () => {
    registerTools("Files", [mkTool("dupe")]);
    expect(() => registerTools("Web", [mkTool("dupe")])).toThrow(/duplicate/i);
  });

  it("registers multiple tools in a single call", () => {
    registerTools("Memory", [mkTool("m1"), mkTool("m2"), mkTool("m3")]);
    expect(registeredTools()).toHaveLength(3);
    expect(registeredCategory("m2")).toBe("Memory");
  });
});
