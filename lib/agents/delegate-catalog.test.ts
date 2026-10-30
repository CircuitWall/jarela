import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigRow } from "@/lib/stores/agent-configs";
import type { ToolCatalogEntry } from "@/lib/tools";
const mocks = vi.hoisted(() => ({ agents: new Map<string, AgentConfigRow>(), refresh: vi.fn() }));
vi.mock("@/lib/stores/agent-configs", () => ({
  getAgentConfig: (id: string) => mocks.agents.get(id) ?? null,
  parseDelegateTargets: (value: string | null) => value ? JSON.parse(value) : [],
}));
vi.mock("./advertisement-service", () => ({ advertisementService: () => ({ refresh: mocks.refresh }) }));
const { buildDelegateCatalog, DELEGATE_CATALOG_MAX_CHARS } = await import("./delegate-catalog");
const parent = { id: "parent", delegate_targets: '["b","a"]' };
const allowed = [{ name: "delegate_to_agent", permission: "enabled" as const, permission_reason: "agent_allowed" }];
beforeEach(() => {
  mocks.agents.clear(); mocks.refresh.mockReset(); mocks.refresh.mockResolvedValue(null);
  for (const id of ["a", "b", "hidden"]) mocks.agents.set(id, { id, name: `Name ${id}`, identity: "PRIVATE IDENTITY", instructions: "PRIVATE INSTRUCTIONS" } as AgentConfigRow);
});
describe("authorized bounded delegate catalog", () => {
  it("reports unavailable metadata while preserving existing authorized delegation without private fallbacks", async () => {
    mocks.refresh.mockRejectedValue(new Error("synthetic metadata failure"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const lines = await buildDelegateCatalog(parent, allowed, []);
      expect(lines).toHaveLength(2);
      expect(lines.join(" ")).toContain("Metadata unavailable");
      expect(lines.join(" ")).not.toContain("PRIVATE");
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
  it("omits empty and denied catalogs without inspecting hidden agents", async () => {
    expect(await buildDelegateCatalog(parent, [], [])).toEqual([]);
    expect(await buildDelegateCatalog({ ...parent, delegate_targets: null }, allowed, [])).toEqual([]);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("includes proxy-reachable dispatch permission and deterministic authorized identities only", async () => {
    const lines = await buildDelegateCatalog(parent, [{ ...allowed[0], permission: "disabled", permission_reason: "proxy_only" }], []);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["a", "b"]);
    expect(lines.join(" ")).not.toMatch(/hidden|PRIVATE/);
    expect(lines.join(" ")).toContain("legacy");
  });
  it("never exposes missing, self, denied or revoked targets", async () => {
    mocks.agents.delete("a");
    const lines = await buildDelegateCatalog({ id: "b", delegate_targets: '["a","b","hidden"]' }, allowed, []);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe("hidden");
    expect(await buildDelegateCatalog(parent, [{ ...allowed[0], permission: "unavailable", permission_reason: "category_disabled" }], [])).toEqual([]);
  });
  it("marks fresh claims model-generated and stale/failed claims legacy without private fallback", async () => {
    mocks.refresh.mockImplementation((id) => Promise.resolve(id === "a"
      ? { status: "ready", advertisement: { purpose: "Synthetic purpose", call_when: ["Summarize fixtures"], do_not_call_for: ["Unrelated work"], inputs: "Fixture", output: "Summary", tools: [] } }
      : { status: "stale", advertisement: { purpose: "MUST NOT APPEAR" } }));
    const text = (await buildDelegateCatalog(parent, allowed, [])).join("\n");
    expect(text).toContain("model-generated, not verified");
    expect(text).toContain("Synthetic purpose");
    expect(text).not.toMatch(/PRIVATE|MUST NOT APPEAR/);
  });
  it("reports all-or-nothing generated overflow with every identity preserved", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `specialist-${index}`);
    for (const id of ids) mocks.agents.set(id, { id, name: id } as AgentConfigRow);
    mocks.refresh.mockResolvedValue({ status: "ready", advertisement: { purpose: "x".repeat(1500) } });
    const lines = await buildDelegateCatalog({ id: "parent", delegate_targets: JSON.stringify(ids) }, allowed, []);
    expect(lines[0]).toContain("omitted");
    expect(lines).toHaveLength(11);
    expect(lines.join("\n").length).toBeLessThan(DELEGATE_CATALOG_MAX_CHARS);
  });
  it("reports identity overflow without selecting a hidden subset", async () => {
    const ids = Array.from({ length: 33 }, (_, index) => `target-${index}`);
    for (const id of ids) mocks.agents.set(id, { id, name: id } as AgentConfigRow);
    const lines = await buildDelegateCatalog({ id: "parent", delegate_targets: JSON.stringify(ids) }, allowed, []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("overflow");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("passes the current full capability catalog to freshness validation, not pinned tools", async () => {
    const catalog = [{ name: "fixture_read", permission_reason: "proxy_only" }] as ToolCatalogEntry[];
    await buildDelegateCatalog(parent, allowed, catalog);
    expect(mocks.refresh).toHaveBeenCalledWith("a", false, catalog);
  });
});
