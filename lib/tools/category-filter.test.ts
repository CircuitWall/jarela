import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated SQLite per test run — point JARELA_DB_DIR at a tmp dir BEFORE
// importing modules that open the DB or register tools.
const tmpRoot = mkdtempSync(join(tmpdir(), "jarela-test-tool-filter-"));
process.env.JARELA_DB_DIR = tmpRoot;

const { getAllTools, executeTool, getAllToolCatalogAsync, applyAgentPermissionsToCatalog, applyProviderToolLimitToCatalog } = await import("./index");
const { setCategoryEnabled } = await import("@/lib/stores/builtin-tools");
const { registeredCategory } = await import("./registry");

afterAll(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

describe("built-in tool category filter (runtime layer)", () => {
  beforeEach(() => {
    // Re-enable everything between cases.
    setCategoryEnabled("Web", true);
    setCategoryEnabled("Files", true);
    setCategoryEnabled("Memory", true);
    setCategoryEnabled("Shell", true);
  });

  it("getAllTools includes built-ins of an enabled category", () => {
    const tools = getAllTools();
    const memoryTools = tools.filter((t) => registeredCategory(t.name) === "Memory");
    expect(memoryTools.length).toBeGreaterThan(0);
  });

  it("getAllTools drops every tool of a disabled category", () => {
    const before = getAllTools()
      .filter((t) => registeredCategory(t.name) === "Memory")
      .map((t) => t.name);
    expect(before.length).toBeGreaterThan(0); // sanity

    setCategoryEnabled("Memory", false);

    const after = getAllTools()
      .filter((t) => registeredCategory(t.name) === "Memory")
      .map((t) => t.name);
    expect(after).toEqual([]);
  });

  it("catalog still exposes disabled-category tools as unavailable to agents", async () => {
    setCategoryEnabled("Memory", false);
    const catalog = await getAllToolCatalogAsync();
    const permissions = applyAgentPermissionsToCatalog(catalog, { tools: JSON.stringify([]) });
    const memory = permissions.filter((tool) => tool.category === "Memory");

    expect(memory.length).toBeGreaterThan(0);
    expect(memory.every((tool) => tool.status === "disabled")).toBe(true);
    expect(memory.every((tool) => tool.status_reason === "category_disabled")).toBe(true);
    expect(memory.every((tool) => tool.permission === "unavailable")).toBe(true);
  });

  it("getAllTools leaves tools of other categories untouched when one is disabled", () => {
    setCategoryEnabled("Memory", false);
    const tools = getAllTools();
    const filesTools = tools.filter((t) => registeredCategory(t.name) === "Files");
    expect(filesTools.length).toBeGreaterThan(0);
  });

  it("executeTool blocks invocation of tools whose category is disabled", async () => {
    // Pick any built-in Files tool we know exists.
    const filesTool = getAllTools().find(
      (t) => registeredCategory(t.name) === "Files",
    );
    expect(filesTool).toBeDefined();
    const name = filesTool!.name;

    setCategoryEnabled("Files", false);

    await expect(
      executeTool(name, {}, {}),
    ).rejects.toThrow(/disabled/i);
  });

  it("re-enabling a category restores its tools immediately", () => {
    setCategoryEnabled("Web", false);
    expect(
      getAllTools().filter((t) => registeredCategory(t.name) === "Web"),
    ).toEqual([]);

    setCategoryEnabled("Web", true);
    expect(
      getAllTools().filter((t) => registeredCategory(t.name) === "Web").length,
    ).toBeGreaterThan(0);
  });
});

describe("provider tool limit", () => {
  it("prioritizes explicitly selected tools and marks omitted tools", () => {
    const catalog = ["default_a", "default_b", "selected_late", "config_tool"].map((name) => ({
      name,
      description: name,
      source: "builtin" as const,
      category: "Files" as const,
      capability: "read" as const,
      group: "Basic" as const,
      credentials_required: [],
      status: "enabled" as const,
      status_reason: null,
      permission: "enabled" as const,
      permission_reason: "agent_allowed",
    }));

    const result = applyProviderToolLimitToCatalog(
      catalog,
      ["default_a", "default_b", "selected_late", "config_tool"],
      2,
      ["config_tool", "selected_late"],
    );

    expect(result.allowedToolNames).toEqual(["config_tool", "selected_late"]);
    expect(result.omittedToolNames).toEqual(["default_a", "default_b"]);
    expect(result.toolPermissionMap.find((tool) => tool.name === "default_a")?.permission).toBe("disabled");
    expect(result.toolPermissionMap.find((tool) => tool.name === "default_a")?.permission_reason).toBe("provider_tool_limit");
    expect(result.toolPermissionMap.find((tool) => tool.name === "selected_late")?.permission).toBe("enabled");
  });

  it("uses the current request to select relevant candidates when the tool list exceeds the provider cap", () => {
    const catalog = ["calendar_lookup", "outlook_send_mail", "github_create_issue", "jira_search"].map((name) => ({
      name,
      description: name,
      source: "mcp" as const,
      category: name.includes("calendar") || name.includes("outlook") ? "Microsoft" as const : "GitHub" as const,
      capability: name.includes("send") || name.includes("create") ? "write" as const : "read" as const,
      group: "Work" as const,
      credentials_required: [],
      status: "enabled" as const,
      status_reason: null,
      permission: "enabled" as const,
      permission_reason: "agent_allowed",
    }));

    const result = applyProviderToolLimitToCatalog(
      catalog,
      catalog.map((tool) => tool.name),
      2,
      [],
      { candidateQuery: "send an outlook email" },
    );

    expect(result.allowedToolNames).toEqual(["outlook_send_mail", "calendar_lookup"]);
    expect(result.omittedToolNames).toEqual(["github_create_issue", "jira_search"]);
  });

  it("keeps pinned recovery tools even when other tools match the request better", () => {
    const catalog = ["list_tools", "outlook_send_mail", "outlook_list_messages"].map((name) => ({
      name,
      description: name,
      source: "builtin" as const,
      category: name === "list_tools" ? "Config" as const : "Microsoft" as const,
      capability: name === "outlook_send_mail" ? "write" as const : "read" as const,
      group: name === "list_tools" ? "Basic" as const : "Work" as const,
      credentials_required: [],
      status: "enabled" as const,
      status_reason: null,
      permission: "enabled" as const,
      permission_reason: "agent_allowed",
    }));

    const result = applyProviderToolLimitToCatalog(
      catalog,
      catalog.map((tool) => tool.name),
      2,
      ["list_tools"],
      { candidateQuery: "send outlook email" },
    );

    expect(result.allowedToolNames).toEqual(["list_tools", "outlook_send_mail"]);
    expect(result.omittedToolNames).toEqual(["outlook_list_messages"]);
  });
});
