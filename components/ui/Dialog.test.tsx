// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Dialog } from "./Dialog";

function noop() {}

describe("Dialog", () => {
  it("renders nothing when open=false", () => {
    const { container } = render(
      <Dialog open={false} onClose={noop}>
        body
      </Dialog>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a role='dialog' with aria-modal when open", () => {
    render(
      <Dialog open onClose={noop} title="Hi">
        body
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("heading").textContent).toBe("Hi");
  });

  it("locks body scroll while open and restores the previous value on unmount", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <Dialog open onClose={noop}>
        body
      </Dialog>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("calls onClose on Escape when dismissOnEscape is the default", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose}>
        body
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape when dismissOnEscape=false", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} dismissOnEscape={false}>
        body
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on backdrop mousedown by default and respects dismissOnBackdrop=false", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open onClose={onClose}>
        body
      </Dialog>,
    );
    const backdrop = screen.getByRole("presentation");
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <Dialog open onClose={onClose} dismissOnBackdrop={false}>
        body
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the dialog card itself receives mousedown", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose}>
        body
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders a close button with aria-label='Close' when a title is present", () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Hi">
        body
      </Dialog>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hides the close button when showClose=false even with a title", () => {
    render(
      <Dialog open onClose={noop} title="Hi" showClose={false}>
        body
      </Dialog>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it.each([
    ["sm", "max-w-md"],
    ["md", "max-w-lg"],
    ["lg", "max-w-xl"],
    ["xl", "max-w-2xl"],
    ["full", "max-w-[min(96vw,1400px)]"],
  ] as const)("applies max-width for size=%s", (size, expected) => {
    render(
      <Dialog open onClose={noop} size={size}>
        body
      </Dialog>,
    );
    expect(screen.getByRole("dialog").className).toContain(expected);
  });

  it.each([
    ["default", "z-50"],
    ["elevated", "z-[60]"],
    ["topmost", "z-[70]"],
  ] as const)("applies z-index for level=%s", (level, expected) => {
    render(
      <Dialog open onClose={noop} level={level}>
        body
      </Dialog>,
    );
    expect(screen.getByRole("presentation").className).toContain(expected);
  });

  it("aligns the overlay differently for top vs center", () => {
    const { rerender } = render(
      <Dialog open onClose={noop} align="top">
        body
      </Dialog>,
    );
    expect(screen.getByRole("presentation").className).toContain("items-start");
    rerender(
      <Dialog open onClose={noop} align="center">
        body
      </Dialog>,
    );
    expect(screen.getByRole("presentation").className).toContain("items-center");
  });

  it("renders footer slot outside the scrollable body", () => {
    render(
      <Dialog open onClose={noop} footer={<div data-testid="ftr">F</div>}>
        body
      </Dialog>,
    );
    expect(screen.getByTestId("ftr").textContent).toBe("F");
  });

  it("omits default padding/spacing when padded=false", () => {
    render(
      <Dialog open onClose={noop} padded={false}>
        body
      </Dialog>,
    );
    // Body wrapper is the only child of the dialog card containing the text.
    const dialog = screen.getByRole("dialog");
    const body = dialog.lastElementChild as HTMLElement;
    expect(body.className).not.toContain("p-4");
    expect(body.className).not.toContain("space-y-3");
  });

  it("renders edge-to-edge viewport layout when fitViewport=true", () => {
    render(
      <Dialog open onClose={noop} fitViewport>
        body
      </Dialog>,
    );
    const overlay = screen.getByRole("presentation");
    const dialog = screen.getByRole("dialog");
    expect(overlay.className).toContain("p-0");
    expect(overlay.className).toContain("items-stretch");
    expect(dialog.className).toContain("w-screen");
    expect(dialog.className).toContain("h-[100dvh]");
    expect(dialog.className).toContain("rounded-none");
  });
});
