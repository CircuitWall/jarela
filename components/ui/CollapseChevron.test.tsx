// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { CollapseChevron } from "./CollapseChevron";

function findIcon(container: HTMLElement) {
  return container.querySelector("svg")!;
}

describe("CollapseChevron", () => {
  it("renders a chevron SVG that is decorative by default", () => {
    const { container } = render(<CollapseChevron open={false} />);
    const icon = findIcon(container);
    expect(icon).not.toBeNull();
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  it("omits the rotate-90 class when closed", () => {
    const { container } = render(<CollapseChevron open={false} />);
    const cls = findIcon(container).getAttribute("class") ?? "";
    expect(cls).toContain("transition-transform");
    expect(cls).not.toContain("rotate-90");
  });

  it("adds the rotate-90 class when open", () => {
    const { container } = render(<CollapseChevron open />);
    expect(findIcon(container).getAttribute("class") ?? "").toContain("rotate-90");
  });

  it("defaults to size 11 and respects an explicit size override", () => {
    const { container, rerender } = render(<CollapseChevron open={false} />);
    expect(findIcon(container).getAttribute("width")).toBe("11");
    rerender(<CollapseChevron open={false} size={14} />);
    expect(findIcon(container).getAttribute("width")).toBe("14");
    expect(findIcon(container).getAttribute("height")).toBe("14");
  });

  it("composes caller className after the baseline classes", () => {
    const { container } = render(
      <CollapseChevron open={false} className="text-fg-faint mt-0.5" />,
    );
    const cls = findIcon(container).getAttribute("class") ?? "";
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("transition-transform");
    expect(cls).toContain("text-fg-faint");
    expect(cls).toContain("mt-0.5");
  });

  it("lets the caller mark the icon as not aria-hidden", () => {
    const { container } = render(
      <CollapseChevron open aria-hidden={false} />,
    );
    expect(findIcon(container).getAttribute("aria-hidden")).toBe("false");
  });
});
