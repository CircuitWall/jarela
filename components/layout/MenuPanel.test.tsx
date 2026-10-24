// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MenuPanel } from "./MenuPanel";
import type { Tab } from "@/contexts/AppContext";

const mocks = vi.hoisted(() => ({
  mode: "full",
  attention: { any: false, models: false, credentials: false },
}));
vi.mock("@/contexts/AppContext", () => ({
  useAppContext: () => ({ state: { experienceMode: mocks.mode } }),
}));
vi.mock("@/hooks/useSettingsAttention", () => ({
  useSettingsAttention: () => mocks.attention,
}));

beforeEach(() => {
  mocks.mode = "full";
  mocks.attention = { any: false, models: false, credentials: false };
});

describe("MenuPanel", () => {
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
