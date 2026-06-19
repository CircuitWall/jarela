// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./Badge";

describe("Badge", () => {
  it("defaults to neutral tone, xs size, and no border", () => {
    render(<Badge>label</Badge>);
    const badge = screen.getByText("label");
    expect(badge.className).toContain("bg-surface-3");
    expect(badge.className).toContain("text-fg-muted");
    expect(badge.className).toContain("h-4");
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).not.toContain("border ");
  });

  it.each([
    ["accent", "bg-accent/15"],
    ["success", "bg-emerald-500/15"],
    ["warning", "bg-amber-500/15"],
    ["danger", "bg-rose-500/15"],
    ["info", "bg-sky-500/15"],
    ["neutral", "bg-surface-3"],
  ] as const)("applies bg for tone=%s", (tone, expected) => {
    render(<Badge tone={tone}>x</Badge>);
    expect(screen.getByText("x").className).toContain(expected);
  });

  it.each([
    ["xs", "h-4"],
    ["sm", "px-2"],
  ] as const)("applies size dimensions for %s", (size, expected) => {
    render(<Badge size={size}>x</Badge>);
    expect(screen.getByText("x").className).toContain(expected);
  });

  it("adds a matching border when bordered=true", () => {
    render(
      <Badge tone="warning" bordered>
        x
      </Badge>,
    );
    const cls = screen.getByText("x").className;
    expect(cls).toContain("border ");
    expect(cls).toContain("border-amber-500/30");
  });

  it.each([
    ["accent", "border-accent/40"],
    ["success", "border-emerald-500/30"],
    ["danger", "border-rose-500/30"],
    ["info", "border-sky-500/30"],
    ["neutral", "border-border"],
  ] as const)("matches border tone for bordered %s", (tone, expected) => {
    render(
      <Badge tone={tone} bordered>
        x
      </Badge>,
    );
    expect(screen.getByText("x").className).toContain(expected);
  });

  it("renders the icon slot before the children", () => {
    const { container } = render(
      <Badge icon={<span data-testid="ic" />}>label</Badge>,
    );
    const badge = container.firstElementChild!;
    expect(badge.firstElementChild?.getAttribute("data-testid")).toBe("ic");
    expect(badge.textContent).toBe("label");
  });

  it("forwards the title attribute for native tooltips", () => {
    render(
      <Badge title="hover">label</Badge>,
    );
    expect(screen.getByText("label").getAttribute("title")).toBe("hover");
  });

  it("merges caller className after the variant classes", () => {
    render(
      <Badge className="extra-marker">x</Badge>,
    );
    const cls = screen.getByText("x").className;
    expect(cls).toContain("extra-marker");
    expect(cls).toContain("bg-surface-3");
  });

  it("is always shrink-0 and rounded-full so it survives inside flex rows", () => {
    render(<Badge>x</Badge>);
    const cls = screen.getByText("x").className;
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("rounded-full");
  });
});
