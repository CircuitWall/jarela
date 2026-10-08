// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SettingsCard, SettingsGroup } from "./SettingsCard";
import { PanelHeader, HeaderAction } from "./PanelHeader";
import { Notice } from "./Notice";
import { PanelMessage } from "./PanelMessage";
import { SubTabBar } from "./SubTabBar";

describe("SettingsCard", () => {
  it("is always expanded outside a group and has no toggle", () => {
    render(<SettingsCard title="Solo" description="desc">body</SettingsCard>);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("keeps only one drawer open and exposes aria-expanded", () => {
    render(
      <SettingsGroup defaultOpenId="a">
        <SettingsCard id="a" title="A">alpha</SettingsCard>
        <SettingsCard id="b" title="B">beta</SettingsCard>
      </SettingsGroup>,
    );
    const a = screen.getByRole("button", { name: "A" });
    const b = screen.getByRole("button", { name: "B" });
    expect(a.getAttribute("aria-expanded")).toBe("true");
    expect(b.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(b);
    expect(a.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(b);
    expect(b.getAttribute("aria-expanded")).toBe("false");
  });

  it("makes collapsed content inert so it cannot take focus", () => {
    render(
      <SettingsGroup>
        <SettingsCard id="a" title="A"><button>inner</button></SettingsCard>
      </SettingsGroup>,
    );
    const body = document.getElementById("a-body")!;
    expect(body.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(body.hasAttribute("inert")).toBe(false);
  });

  it("shows header actions only while open", () => {
    render(
      <SettingsGroup>
        <SettingsCard id="a" title="A" actions={<button>act</button>}>x</SettingsCard>
      </SettingsGroup>,
    );
    expect(screen.queryByText("act")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "A" }));
    expect(screen.getByText("act")).toBeTruthy();
  });
});

describe("PanelHeader", () => {
  it("renders the title as a heading with actions", () => {
    const onClick = vi.fn();
    render(
      <PanelHeader icon={<span>i</span>} title="Things">
        <HeaderAction label="New" onClick={onClick} />
      </PanelHeader>,
    );
    expect(screen.getByRole("heading", { name: "Things" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /New/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire a disabled action", () => {
    const onClick = vi.fn();
    render(<HeaderAction label="Go" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button", { name: /Go/ }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Notice and PanelMessage", () => {
  it("announces errors as alerts but not warnings", () => {
    const { rerender } = render(<Notice tone="error">bad</Notice>);
    expect(screen.getByRole("alert").textContent).toBe("bad");
    rerender(<Notice tone="warn">careful</Notice>);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("exposes PanelMessage as a status region", () => {
    render(<PanelMessage>Loading…</PanelMessage>);
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });
});

describe("SubTabBar", () => {
  const tabs = [
    { id: "a", label: "Alpha" },
    { id: "b", label: "Beta" },
    { id: "c", label: "Gamma" },
  ];

  it("uses roving tabindex and selects with arrow keys, wrapping at the ends", () => {
    const onChange = vi.fn();
    render(<SubTabBar tabs={tabs} active="a" onChange={onChange} ariaLabel="Test" />);
    const list = screen.getByRole("tablist");
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("tab", { name: "Beta" }).getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(list, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    fireEvent.keyDown(list, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("a");
  });

  it("keeps the strip keyboard-reachable when the active tab is not listed", () => {
    render(<SubTabBar tabs={tabs} active={"zzz" as string} onChange={() => {}} ariaLabel="Test" />);
    expect(screen.getByRole("tab", { name: "Alpha" }).getAttribute("tabindex")).toBe("0");
  });
});
