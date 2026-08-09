// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { Message } from "@/api/types";

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ message }: { message: Message }) => (
    <div>{message.content}</div>
  ),
}));

vi.mock("./ToolList", () => ({
  ToolList: () => null,
}));

function mkMessage(id: string, role: "user" | "assistant", content: string, created_at: string): Message {
  return { id, role, content, created_at, status: "confirmed" };
}

function setRect(el: Element, top: number, height = 24) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: top,
      width: 400,
      height,
      top,
      right: 400,
      bottom: top + height,
      left: 0,
      toJSON: () => ({}),
    }),
  });
}

function installPointerCapture(button: HTMLButtonElement) {
  Object.defineProperty(button, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(button, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(button, "hasPointerCapture", { configurable: true, value: vi.fn(() => true) });
}

describe("MessageList conversation focus", () => {
  it("opens a confirmation dialog on drag release and only persists after confirm", () => {
    const onSetContextPin = vi.fn();
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "newer", "2026-08-09T10:00:01.000Z"),
    ];
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={onSetContextPin}
      />,
    );

    const candidates = Array.from(container.querySelectorAll("[data-hot-candidate='1']"));
    expect(candidates).toHaveLength(2);
    setRect(candidates[0], 120);
    setRect(candidates[1], 220);

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    installPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 220 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 212 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 220 });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Move conversation focus here?")).toBeTruthy();
    expect(onSetContextPin).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Move focus" }));
    expect(onSetContextPin).toHaveBeenCalledWith("2026-08-09T10:00:01.000Z");
  });

  it("cancels without persisting when the dialog is dismissed", () => {
    const onSetContextPin = vi.fn();
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "newer", "2026-08-09T10:00:01.000Z"),
    ];
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={onSetContextPin}
      />,
    );

    const candidates = Array.from(container.querySelectorAll("[data-hot-candidate='1']"));
    setRect(candidates[0], 120);
    setRect(candidates[1], 220);

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    installPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 120 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 112 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 120 });

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onSetContextPin).not.toHaveBeenCalled();
  });

  it("opens floating summary panel on line click without triggering move-focus dialog", () => {
    const onSetContextPin = vi.fn();
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "newer", "2026-08-09T10:00:01.000Z"),
    ];
    render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={onSetContextPin}
        hotSince="2026-08-09T10:00:01.000Z"
        warmSummary="Short cached summary"
        warmSummaryBefore="2026-08-09T10:00:01.000Z"
      />,
    );

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    fireEvent.click(handle);

    expect(screen.getByText("Earlier messages summary")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSetContextPin).not.toHaveBeenCalled();
  });

  it("opens floating summary panel on tap without closing it on the follow-up click", () => {
    const onSetContextPin = vi.fn();
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "newer", "2026-08-09T10:00:01.000Z"),
    ];
    render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={onSetContextPin}
        hotSince="2026-08-09T10:00:01.000Z"
        warmSummary="Short cached summary"
        warmSummaryBefore="2026-08-09T10:00:01.000Z"
      />,
    );

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    installPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 120 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 120 });
    fireEvent.click(handle);

    expect(screen.getByText("Earlier messages summary")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSetContextPin).not.toHaveBeenCalled();
  });
});