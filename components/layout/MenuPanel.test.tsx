// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MenuPanel } from "./MenuPanel";
import type { Tab } from "@/contexts/AppContext";

const mocks = vi.hoisted(() => ({
  mode: "full",
  attention: { any: false, models: false, credentials: false },
  listModels: vi.fn(),
}));
const activeAgent = {
  id: "synthetic-agent",
  name: "Synthetic agent",
  icon: "data:image/png;base64,c3ludGhldGlj",
  identity: "A **test assistant**.",
  instructions: "## Working style\n\n- Verify **evidence**.\n- Use `tools`.\n\n[Guide](https://example.com/guide)",
  usage_profile: "dev" as const,
  model_config_name: "Synthetic model",
  usage_strategy: "high_reasoning" as const,
  tools: ["web_search", "web_fetch"],
  delegate_targets: ["synthetic-delegate"],
  voice_enabled: true,
  never_reply: false,
};
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { experienceMode: mocks.mode } }),
}));
vi.mock("@/hooks/useSettingsAttention", () => ({
  useSettingsAttention: () => mocks.attention,
}));
vi.mock("@/api/client", () => ({
  api: { models: { list: mocks.listModels } },
}));

beforeEach(() => {
  mocks.mode = "full";
  mocks.attention = { any: false, models: false, credentials: false };
  mocks.listModels.mockReset().mockResolvedValue([]);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});
afterEach(() => vi.unstubAllGlobals());

describe("MenuPanel", () => {
  it("renders a desktop agent card with its icon and Markdown instead of duplicate metadata", () => {
    const onSetTab = vi.fn();
    const onClose = vi.fn();
    render(<MenuPanel activeTab="chat" activeAgent={activeAgent} onSetTab={onSetTab} onClose={onClose} />);
    const summary = screen.getByRole("region", { name: "Selected agent" });
    expect(summary.className).toContain("hidden");
    expect(summary.className).toContain("xl:block");
    expect(within(summary).getByRole("heading", { name: "Synthetic agent" })).toBeTruthy();
    expect(within(summary).getByRole("presentation").getAttribute("src")).toBe(activeAgent.icon);
    const description = within(summary).getByRole("region", { name: "Agent description" });
    expect(description.tabIndex).toBe(0);
    expect(description.className).toContain("max-h-64");
    expect(description.className).toContain("overflow-y-auto");
    expect(within(description).getByText("test assistant").tagName).toBe("STRONG");
    expect(within(description).getByRole("heading", { name: "Working style" })).toBeTruthy();
    expect(within(description).getAllByRole("listitem")).toHaveLength(2);
    expect(within(description).getByText("evidence").tagName).toBe("STRONG");
    expect(within(description).getByText("tools").tagName).toBe("CODE");
    const guide = within(description).getByRole("link", { name: "Guide" });
    expect(guide.getAttribute("href")).toBe("https://example.com/guide");
    expect(guide.getAttribute("rel")).toBe("noopener noreferrer");
    for (const label of ["Profile", "Model override", "Selected tools", "Synthetic model", "Usage strategy", "Delegation targets", "Voice"]) {
      expect(within(summary).queryByText(label)).toBeNull();
    }
    expect(summary.parentElement?.firstElementChild).toBe(summary);
    fireEvent.click(within(summary).getByRole("button", { name: "Manage agents" }));
    expect(onSetTab).toHaveBeenCalledExactlyOnceWith("agents");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("updates the card on agent changes with an initial avatar and explicit empty descriptions", () => {
    const { rerender } = render(<MenuPanel activeTab="chat" activeAgent={activeAgent} onSetTab={vi.fn()} onClose={vi.fn()} />);
    rerender(<MenuPanel activeTab="chat" activeAgent={{
      ...activeAgent, id: "other", name: "Other agent", icon: null, identity: "", instructions: " \n ",
    }} onSetTab={vi.fn()} onClose={vi.fn()} />);
    const summary = screen.getByRole("region", { name: "Selected agent" });
    expect(within(summary).queryByText("Synthetic agent")).toBeNull();
    for (const label of ["Other agent", "No identity set.", "No instructions set."]) {
      expect(within(summary).getByText(label)).toBeTruthy();
    }
    expect(within(summary).getByText("O").getAttribute("aria-hidden")).toBe("true");
    expect(within(summary).queryByRole("presentation")).toBeNull();
    expect(within(summary).queryByRole("heading", { name: "Working style" })).toBeNull();
    expect(within(summary).queryByText("test assistant")).toBeNull();
  });

  it("supports GFM tables without loading instruction images or rendering raw HTML", () => {
    render(<MenuPanel activeTab="chat" activeAgent={{
      ...activeAgent, icon: null,
      instructions: "| Step | Output |\n| --- | --- |\n| Verify | Evidence |\n\n![Diagram](https://example.com/private.png)\n\n<script>alert('test')</script>\n\n[Unsafe](javascript:alert%281%29)",
    }} onSetTab={vi.fn()} onClose={vi.fn()} />);
    const summary = screen.getByRole("region", { name: "Selected agent" });
    expect(within(summary).getByRole("table")).toBeTruthy();
    expect(within(summary).getByRole("cell", { name: "Evidence" })).toBeTruthy();
    expect(within(summary).getByText("Diagram")).toBeTruthy();
    expect(summary.querySelector("img")).toBeNull();
    expect(summary.querySelector("script")).toBeNull();
    expect(summary.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("handles missing, loading, and failed agent data without presenting stale details", () => {
    const { rerender } = render(<MenuPanel activeTab="chat" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Select an agent to see its details.")).toBeTruthy();
    rerender(<MenuPanel activeTab="chat" agentsLoading onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Loading agent details...");
    expect(screen.queryByText("Synthetic agent")).toBeNull();
    rerender(<MenuPanel activeTab="chat" activeAgent={activeAgent} agentsError="Synthetic failure" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Could not load agent details: Synthetic failure");
    expect(screen.queryByText("Synthetic agent")).toBeNull();
  });

  it("does not mount quick controls or load models on small screens", () => {
    render(<MenuPanel activeTab="chat" activeAgent={activeAgent} onUpdateAgent={vi.fn()} onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Quick agent settings" })).toBeNull();
    expect(mocks.listModels).not.toHaveBeenCalled();
  });

  it("mounts quick controls on desktop and keeps the card mounted during agent refreshes", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })));
    const { rerender } = render(<MenuPanel activeTab="chat" activeAgent={activeAgent} onUpdateAgent={vi.fn()} onSetTab={vi.fn()} onClose={vi.fn()} />);
    const controls = screen.getByRole("group", { name: "Quick agent settings" });
    expect(mocks.listModels).toHaveBeenCalledOnce();
    rerender(<MenuPanel activeTab="chat" activeAgent={activeAgent} agentsLoading onUpdateAgent={vi.fn()} onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Quick agent settings" })).toBe(controls);
  });

  it("shows the same agent description in Essential mode without adding advanced destinations", () => {
    mocks.mode = "essential";
    render(<MenuPanel activeTab="chat" activeAgent={activeAgent} onSetTab={vi.fn()} onClose={vi.fn()} />);
    const summary = screen.getByRole("region", { name: "Selected agent" });
    expect(within(summary).getByText("Synthetic agent")).toBeTruthy();
    expect(within(summary).getByRole("heading", { name: "Working style" })).toBeTruthy();
    expect(screen.queryByText("Advanced")).toBeNull();
    for (const label of ["Usage strategy", "Selected tools", "Delegation targets"]) {
      expect(within(summary).queryByText(label)).toBeNull();
    }
  });

  it("keeps closed drawers available as docked navigation on wide screens", () => {
    const { container, rerender } = render(<MenuPanel open={false} activeTab="chat" onSetTab={vi.fn()} onClose={vi.fn()} />);
    const navigation = container.querySelector("nav")!;
    expect(navigation.id).toBe("main-navigation");
    expect(navigation.className).toContain("hidden xl:flex");
    expect(navigation.className).toContain("xl:w-80");
    rerender(<MenuPanel open activeTab="chat" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(navigation.className).not.toContain("hidden xl:flex");
  });

  it("groups real destinations without another agent picker", () => {
    render(<MenuPanel activeTab="agents" onSetTab={vi.fn()} onClose={vi.fn()} />);
    const workspace = screen.getByRole("region", { name: "Workspace" });
    expect(within(workspace).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "AgentsCreate and configure your agents",
      "KnowledgeSearch documents, chats, and saved facts",
      "AutomationsManage scheduled and background work",
      "UsageReview activity and costs",
    ]);
    expect(screen.getByRole("region", { name: "Preferences" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Switch agent" })).toBeNull();
    expect(screen.queryByText("No persona")).toBeNull();
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps Essential mode limited to everyday destinations", () => {
    mocks.mode = "essential";
    render(<MenuPanel activeTab="chat" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["Agents", "Profile", "Settings"]);
    expect(screen.queryByText("Advanced")).toBeNull();
  });

  it.each([
    ["Agents", "agents"], ["Knowledge", "memory"],
    ["Automations", "tasks"], ["Usage", "dashboard"], ["Profile", "profile"],
    ["Settings", "settings"], ["Capabilities", "tools"],
  ] satisfies [string, Tab][])("navigates to %s and closes the drawer", (label, tab) => {
    const onSetTab = vi.fn();
    const onClose = vi.fn();
    render(<MenuPanel activeTab="tools" onSetTab={onSetTab} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onSetTab).toHaveBeenCalledExactlyOnceWith(tab);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("expands Advanced for its active destination, otherwise starts collapsed", () => {
    const { container, rerender } = render(<MenuPanel activeTab="chat" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(container.querySelector("details")?.open).toBe(false);
    rerender(<MenuPanel activeTab="tools" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(container.querySelector("details")?.open).toBe(true);
    expect(screen.getByRole("button", { name: "Capabilities" }).getAttribute("aria-current")).toBe("page");
  });

  it("keeps configuration attention visible and accessible", () => {
    mocks.attention = { any: true, models: true, credentials: true };
    render(<MenuPanel activeTab="chat" onSetTab={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Settings" }).title)
      .toBe("Settings - no model configured, no credentials saved");
    expect(screen.getByText("no model configured, no credentials saved")).toBeTruthy();
  });

  it("uses complete labels, safe-area spacing, and scrollable touch-sized rows", () => {
    const { container } = render(<MenuPanel activeTab="tools" onSetTab={vi.fn()} onClose={vi.fn()} />);
    const navigation = screen.getByRole("navigation", { name: "Main navigation" });
    expect(navigation.className).toContain("pb-safe");
    expect(navigation.className).toContain("glass-elevated");
    expect(container.querySelector(".overflow-y-auto")).toBeTruthy();
    for (const button of within(navigation).getAllByRole("button")) {
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("w-full");
      expect(button.textContent).toContain(button.getAttribute("aria-label"));
    }
  });
});
