// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { Button } from "./Button";

describe("Button", () => {
  it("defaults to type='button' so it cannot submit a wrapping form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).getAttribute("type")).toBe("button");
  });

  it("allows the caller to opt back into type='submit'", () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole("button", { name: "Send" }).getAttribute("type")).toBe("submit");
  });

  it("applies the primary variant classes by default", () => {
    render(<Button>Ok</Button>);
    const btn = screen.getByRole("button", { name: "Ok" });
    expect(btn.className).toContain("bg-accent");
    expect(btn.className).toContain("text-white");
  });

  it.each([
    ["secondary", "border-border"],
    ["ghost", "hover:bg-surface-3"],
    ["danger", "bg-rose-600"],
  ] as const)("applies %s variant classes", (variant, marker) => {
    render(<Button variant={variant}>X</Button>);
    expect(screen.getByRole("button").className).toContain(marker);
  });

  it.each([
    ["sm", "text-xs"],
    ["md", "text-sm"],
    ["lg", "font-medium"],
  ] as const)("applies %s size classes", (size, marker) => {
    render(<Button size={size}>X</Button>);
    expect(screen.getByRole("button").className).toContain(marker);
  });

  it("renders icon before and trailingIcon after children", () => {
    render(
      <Button icon={<span data-testid="lead" />} trailingIcon={<span data-testid="tail" />}>
        Label
      </Button>,
    );
    const btn = screen.getByRole("button");
    const order = Array.from(btn.children).map((c) => c.getAttribute("data-testid") ?? c.textContent);
    expect(order[0]).toBe("lead");
    expect(order[order.length - 1]).toBe("tail");
  });

  it("merges caller className after the variant classes", () => {
    render(<Button className="extra-marker">X</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("bg-accent");
    expect(cls).toContain("extra-marker");
  });

  it("forwards refs to the underlying button element", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>X</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("fires onClick when enabled and suppresses it when disabled", () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>X</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        X
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("includes the shared disabled affordance classes", () => {
    render(<Button>X</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).toContain("disabled:opacity-50");
    expect(cls).toContain("disabled:cursor-not-allowed");
  });
});
