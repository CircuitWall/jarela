// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { StatusDot } from "./StatusDot";

function findDot(container: HTMLElement) {
  return container.querySelector("span")!;
}

describe("StatusDot", () => {
  it("defaults to neutral tone, xs size, and aria-hidden when no label is given", () => {
    const { container } = render(<StatusDot />);
    const dot = findDot(container);
    expect(dot.className).toContain("bg-fg-faint");
    expect(dot.className).toContain("w-1.5");
    expect(dot.className).toContain("h-1.5");
    expect(dot.className).toContain("rounded-full");
    expect(dot.getAttribute("aria-hidden")).not.toBeNull();
    expect(dot.getAttribute("role")).toBeNull();
  });

  it.each([
    ["accent", "bg-accent"],
    ["success", "bg-emerald-500"],
    ["warning", "bg-amber-500"],
    ["danger", "bg-rose-500"],
    ["info", "bg-sky-500"],
    ["neutral", "bg-fg-faint"],
  ] as const)("applies bg for tone=%s", (tone, expected) => {
    const { container } = render(<StatusDot tone={tone} />);
    expect(findDot(container).className).toContain(expected);
  });

  it.each([
    ["xs", "w-1.5"],
    ["sm", "w-2"],
  ] as const)("applies dimensions for size=%s", (size, expected) => {
    const { container } = render(<StatusDot size={size} />);
    expect(findDot(container).className).toContain(expected);
  });

  it("adds animate-pulse when pulse=true", () => {
    const { container } = render(<StatusDot pulse />);
    expect(findDot(container).className).toContain("animate-pulse");
  });

  it("omits animate-pulse by default", () => {
    const { container } = render(<StatusDot />);
    expect(findDot(container).className).not.toContain("animate-pulse");
  });

  it("becomes role='img' with aria-label when a label is provided", () => {
    const { container } = render(<StatusDot label="needs attention" />);
    const dot = findDot(container);
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBe("needs attention");
    expect(dot.getAttribute("aria-hidden")).toBeNull();
  });

  it("forwards a native title attribute for tooltips", () => {
    const { container } = render(<StatusDot title="hover text" />);
    expect(findDot(container).getAttribute("title")).toBe("hover text");
  });

  it("composes caller className after the variant classes", () => {
    const { container } = render(<StatusDot className="extra-marker" />);
    const cls = findDot(container).className;
    expect(cls).toContain("extra-marker");
    expect(cls).toContain("bg-fg-faint");
  });

  it("always sets shrink-0 so the dot survives inside flex rows", () => {
    const { container } = render(<StatusDot />);
    expect(findDot(container).className).toContain("shrink-0");
  });
});
