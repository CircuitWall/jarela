// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { AgentSwitcher } from "./AgentSwitcher";
import { clearUnreadForAgent, dismissToast, pushToast } from "@/lib/ui/toasts";

const agents = [
  { id: "home", name: "Home", icon: null },
  { id: "work", name: "Work", icon: "data:image/png;base64,c3ludGhldGlj" },
  { id: "dev", name: "Developer", icon: null },
];
const cancel = vi.fn();
const animate = vi.fn(() => ({ cancel }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = this.parentElement ? [...this.parentElement.children].indexOf(this) : 0;
    return { left: index * 50, top: 0, width: 40, height: 36 } as DOMRect;
  });
  vi.stubGlobal("Animation", class {});
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
});
afterEach(() => {
  for (const agent of agents) clearUnreadForAgent(agent.id);
  clearUnreadForAgent(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
});

describe("AgentSwitcher", () => {
  it("puts the current agent first followed by fading, accessible icon buttons", () => {
    render(<AgentSwitcher agents={agents} activeAgentId="work" onSelect={vi.fn()} />);
    const buttons = within(screen.getByRole("group", { name: "Switch agent" })).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Current agent: Work", "Switch to: Home", "Switch to: Developer",
    ]);
    expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
    expect(buttons[1].firstElementChild?.className).toContain("opacity-65");
    expect(buttons[2].firstElementChild?.className).toContain("opacity-50");
    expect(buttons[1].firstElementChild?.className).toContain("group-hover:opacity-100");
    expect(buttons[1].firstElementChild?.className).toContain("group-focus-visible:opacity-100");
    expect(within(buttons[0]).getByRole("presentation").getAttribute("src")).toBe(agents[1].icon);
    expect(buttons[1].textContent).toBe("H");
  });

  it("preserves supplied ordering except active promotion and reflects refreshed backend order", () => {
    const { rerender } = render(<AgentSwitcher agents={agents} activeAgentId="dev" onSelect={vi.fn()} />);
    const labels = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(labels()).toEqual(["Current agent: Developer", "Switch to: Home", "Switch to: Work"]);
    rerender(<AgentSwitcher agents={[agents[1], agents[2], agents[0]]} activeAgentId="dev" onSelect={vi.fn()} />);
    expect(labels()).toEqual(["Current agent: Developer", "Switch to: Work", "Switch to: Home"]);
  });

  it("reacts to shared unread tracking without reordering or restarting animation", () => {
    render(<AgentSwitcher agents={agents} activeAgentId="home" onSelect={vi.fn()} />);
    const before = screen.getAllByRole("button");
    const calls = animate.mock.calls.length;
    let toastId = "";
    act(() => {
      toastId = pushToast({
        kind: "info", source: "run", sourceLabel: "Reply", title: "Synthetic reply",
        body: "", agent_id: "work", thread_id: null, ttl: 0,
      });
    });
    const work = screen.getByRole("button", { name: "Switch to: Work, 1 unread notification" });
    expect(work.querySelector("[data-unread-dot]")).toBeTruthy();
    expect(work.className).not.toContain("opacity-");
    expect(screen.getAllByRole("button")).toEqual(before);
    expect(animate).toHaveBeenCalledTimes(calls);
    act(() => {
      clearUnreadForAgent("work");
      dismissToast(toastId);
    });
    expect(screen.getByRole("button", { name: "Switch to: Work" }).querySelector("[data-unread-dot]")).toBeNull();
  });

  it("does not assign system-wide unread alerts to an agent", () => {
    render(<AgentSwitcher agents={agents} activeAgentId="home" onSelect={vi.fn()} />);
    let toastId = "";
    act(() => {
      toastId = pushToast({
        kind: "info", source: "system", sourceLabel: "System", title: "Synthetic alert",
        body: "", agent_id: null, thread_id: null, ttl: 0,
      });
    });
    expect(screen.getAllByRole("button").every((button) => !button.querySelector("[data-unread-dot]"))).toBe(true);
    act(() => { clearUnreadForAgent(null); dismissToast(toastId); });
  });

  it("activates a background agent once, preserves its button and animates its promotion", () => {
    const onSelect = vi.fn();
    const { rerender, unmount } = render(<AgentSwitcher agents={agents} activeAgentId="home" onSelect={onSelect} />);
    const workButton = screen.getByRole("button", { name: "Switch to: Work" });
    fireEvent.click(workButton);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("work");
    rerender(<AgentSwitcher agents={agents} activeAgentId="work" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Current agent: Work" })).toBe(workButton);
    expect(animate).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ duration: 420 }));
    const calls = animate.mock.calls.length;
    rerender(<AgentSwitcher agents={agents} activeAgentId="work" onSelect={onSelect} />);
    expect(animate).toHaveBeenCalledTimes(calls);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });

  it("respects reduced-motion preference", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { rerender } = render(<AgentSwitcher agents={agents} activeAgentId="home" onSelect={vi.fn()} />);
    rerender(<AgentSwitcher agents={agents} activeAgentId="dev" onSelect={vi.fn()} />);
    expect(screen.getAllByRole("button")[0].getAttribute("aria-label")).toBe("Current agent: Developer");
    expect(animate).not.toHaveBeenCalled();
  });

  it("handles loading, no active agent, and a removed selection without dropping agents", () => {
    const { rerender } = render(<AgentSwitcher agents={[]} activeAgentId={null} loading onSelect={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toBe("Loading agents");
    expect(screen.getByRole("group").getAttribute("aria-busy")).toBe("true");
    rerender(<AgentSwitcher agents={agents} activeAgentId="removed" onSelect={vi.fn()} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getAllByRole("button").every((button) => button.getAttribute("aria-pressed") === "false")).toBe(true);
  });
});
