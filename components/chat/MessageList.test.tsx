// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MessageList } from "./MessageList";
import type { Message } from "@/api/types";

vi.mock("./MessageBubble", () => ({
  MessageBubble: ({ message, attachedActivity, showAvatar }: {
    message: Pick<Message, "content">;
    attachedActivity?: { source_kind: string };
    showAvatar?: boolean;
  }) => (
    <div data-activity-kind={attachedActivity?.source_kind} data-show-avatar={String(showAvatar)}>{message.content}</div>
  ),
}));

vi.mock("./ToolList", () => ({
  ToolList: () => <div data-testid="tool-list">tools</div>,
}));

function mkMessage(id: string, role: "user" | "assistant", content: string, created_at: string): Message {
  return { id, role, content, created_at, seq: Number(id.replace(/\D/g, "")), status: "confirmed" };
}

function mkActivity(sourceKind: "bridge" | "scheduled_task" | "watcher", sourceId: string): Message {
  const message = mkMessage(`activity-${sourceKind}`, "assistant", "activity", "2026-08-09T10:00:00.000Z");
  message.category = sourceKind;
  message.metadata = {
    automation_activity: {
      version: 1,
      source_kind: sourceKind,
      source_id: sourceId,
      label: "Automated check",
      state: "complete",
      disposition: "action",
      occurrence_count: 1,
      first_at: "2026-08-09T10:00:00.000Z",
      last_at: "2026-08-09T10:00:00.000Z",
    },
  };
  return message;
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
  it.each([
    ["bridge", "bridge-1:chat-1", "user", "bridge", { bridge_conversation: { key: "bridge-1:chat-1" } }],
    ["scheduled_task", "task-1", "assistant", "scheduled_task", undefined],
    ["watcher", "watcher-1", "assistant", "watcher", undefined],
  ] as const)("attaches %s activity to its related message", (sourceKind, sourceId, role, category, metadata) => {
    const activity = mkActivity(sourceKind, sourceId);
    const related = mkMessage("m2", role, "related message", "2026-08-09T10:00:01.000Z");
    related.category = category;
    related.metadata = metadata;

    const { container } = render(<MessageList threadId="thread-1" messages={[activity, related]} />);

    expect(container.querySelectorAll("[data-activity-kind]")).toHaveLength(1);
    expect(container.querySelector("[data-activity-kind]")?.getAttribute("data-activity-kind")).toBe(sourceKind);
    expect(container.querySelector("[data-activity-kind]")?.getAttribute("data-show-avatar")).toBe("true");
    expect(screen.queryByText("activity")).toBeNull();
  });

  it("keeps the context boundary when it targets an activity attached to a message", () => {
    const activity = mkActivity("watcher", "watcher-1");
    activity.seq = 1;
    const related = mkMessage("m2", "assistant", "watcher result", "2026-08-09T10:00:01.000Z");
    related.seq = 2;
    related.category = "watcher";

    const { container } = render(
      <MessageList threadId="thread-1" messages={[activity, related]} hotSinceSeq={1} />,
    );

    const boundary = container.querySelector("[data-focus-boundary='1']");
    const relatedMessage = container.querySelector('[data-message-id="m2"]');
    expect(boundary).toBeTruthy();
    expect(relatedMessage).toBeTruthy();
    expect(boundary!.compareDocumentPosition(relatedMessage!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not pair consecutive activity records with each other", () => {
    const firstActivity = mkActivity("watcher", "watcher-1");
    firstActivity.id = "activity-watcher-1";
    firstActivity.seq = 1;
    const nextActivity = mkActivity("watcher", "watcher-2");
    nextActivity.id = "activity-watcher-2";
    nextActivity.seq = 2;
    const related = mkMessage("m3", "assistant", "watcher result", "2026-08-09T10:00:02.000Z");
    related.seq = 3;
    related.category = "watcher";

    const { container } = render(
      <MessageList threadId="thread-1" messages={[firstActivity, nextActivity, related]} />,
    );

    expect(screen.getAllByText("activity")).toHaveLength(1);
    expect(container.querySelectorAll("[data-activity-kind='watcher']")).toHaveLength(1);
  });

  it("uses the live stream bubble instead of duplicating a persisted draft", () => {
    const draft: Message = {
      id: "draft-1",
      role: "assistant",
      content: "persisted partial",
      created_at: "2026-08-09T10:00:00.000Z",
      transcript_status: "in_progress",
    };
    const { rerender } = render(
      <MessageList threadId="thread-draft" messages={[draft]} streaming streamingContent="live partial" />,
    );

    expect(screen.queryByText("persisted partial")).toBeNull();
    rerender(<MessageList threadId="thread-draft" messages={[draft]} />);
    expect(screen.getByText("persisted partial")).toBeTruthy();
  });

  it("shows a fast scroll-to-latest button when scrolled away from bottom", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "latest", "2026-08-09T10:00:01.000Z"),
    ];
    const { container } = render(<MessageList threadId="thread-1" messages={messages} />);
    const scroller = container.querySelector(".panel-scrollbar") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 120 });

    fireEvent.scroll(scroller);

    const button = screen.getByRole("button", { name: "Resume auto-scroll to latest message" });
    expect(button).toBeTruthy();

    fireEvent.click(button);
    expect(scroller.scrollTop).toBe(1000);
    expect(screen.queryByRole("button", { name: "Resume auto-scroll to latest message" })).toBeNull();
  });

  it("pauses following while scrolled up and resumes after jumping to latest", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "latest", "2026-08-09T10:00:01.000Z"),
    ];
    const { container, rerender } = render(<MessageList threadId="thread-1" messages={messages} />);
    const scroller = container.querySelector(".panel-scrollbar") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 120 });
    fireEvent.scroll(scroller);

    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1200 });
    rerender(<MessageList threadId="thread-1" messages={[...messages, mkMessage("m3", "assistant", "new reply", "2026-08-09T10:00:02.000Z")]} />);
    expect(scroller.scrollTop).toBe(120);
    expect(screen.getByRole("button", { name: "Resume auto-scroll to latest message" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume auto-scroll to latest message" }));
    expect(scroller.scrollTop).toBe(1200);

    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1300 });
    rerender(<MessageList threadId="thread-1" messages={[...messages, mkMessage("m3", "assistant", "new reply", "2026-08-09T10:00:02.000Z"), mkMessage("m4", "assistant", "next reply", "2026-08-09T10:00:03.000Z")]} />);
    expect(scroller.scrollTop).toBe(1300);
    expect(screen.queryByRole("button", { name: "Resume auto-scroll to latest message" })).toBeNull();
  });

  it("groups live thinking, streamed text, and tools into one turn activity stack", () => {
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={[]}
        thinkingContent="checking the useful documents"
        streamingContent="I found a match"
        toolEvents={[{ id: "call-1", phase: "call", name: "documents_search", payload: { query: "jarela" } }]}
      />,
    );

    const activity = screen.getByTestId("live-turn-activity");
    expect(within(activity).getByRole("button", { name: "toggle thinking details" })).toBeTruthy();
    expect(within(activity).getByText("I found a match")).toBeTruthy();
    expect(within(activity).getByTestId("tool-list")).toBeTruthy();
    expect(container.querySelectorAll("[data-testid='live-turn-activity']")).toHaveLength(1);
  });

  it("places the steering message between the prior and steered live answers", () => {
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={[
          mkMessage("u1", "user", "initial request", "2026-08-09T10:00:00.000Z"),
          { ...mkMessage("steer-1", "user", "focus on the API", "2026-08-09T10:00:01.000Z"), status: "steering" },
        ]}
        steeredSegments={[{ id: "steer-1", content: "prior live answer" }]}
        streamingContent="steered live answer"
      />,
    );

    const transcript = container.textContent ?? "";
    expect(transcript.indexOf("prior live answer")).toBeLessThan(transcript.indexOf("focus on the API"));
    expect(transcript.indexOf("focus on the API")).toBeLessThan(transcript.indexOf("steered live answer"));
  });

  it("shows thinking dots while a run has produced nothing yet, and drops them once it has", () => {
    const { rerender } = render(
      <MessageList threadId="thread-1" messages={[]} streaming />,
    );
    expect(screen.getByTestId("thinking-dots")).toBeTruthy();

    rerender(
      <MessageList threadId="thread-1" messages={[]} streaming streamingContent="I found a match" />,
    );
    expect(screen.queryByTestId("thinking-dots")).toBeNull();
  });

  it("shows no thinking dots when no run is in flight", () => {
    render(<MessageList threadId="thread-1" messages={[]} />);
    expect(screen.queryByTestId("thinking-dots")).toBeNull();
  });

  it("opens a confirmation dialog on drag release and only persists after confirm", async () => {
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
        hotSinceSeq={1}
        warmSummary="Short cached summary"
        warmSummaryBeforeSeq={1}
      />,
    );

    const candidates = Array.from(container.querySelectorAll("[data-hot-candidate='1']"));
    expect(candidates).toHaveLength(2);
    setRect(container.querySelector(".panel-scrollbar")!, 0, 400);
    setRect(candidates[0], 120);
    setRect(candidates[1], 220);

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    installPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 220 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 212 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 220 });

    const dialog = await waitFor(() => screen.getByRole("dialog"));
    expect(within(dialog).getByText("Move conversation focus here?")).toBeTruthy();
    expect(onSetContextPin).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Move focus" }));
    expect(onSetContextPin).toHaveBeenCalledWith(2);
  });

  it("cancels without persisting when the dialog is dismissed", async () => {
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
        hotSinceSeq={2}
        warmSummary="Short cached summary"
        warmSummaryBeforeSeq={2}
      />,
    );

    const candidates = Array.from(container.querySelectorAll("[data-hot-candidate='1']"));
    setRect(container.querySelector(".panel-scrollbar")!, 0, 400);
    setRect(candidates[0], 120);
    setRect(candidates[1], 220);

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    installPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 120 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 112 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 120 });

    const dialog = await waitFor(() => screen.getByRole("dialog"));
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
        hotSinceSeq={2}
        warmSummary="Short cached summary"
        warmSummaryBeforeSeq={2}
      />,
    );

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    fireEvent.click(handle);

    expect(screen.getByText("Earlier messages summary")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
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
        hotSinceSeq={2}
        warmSummary="Short cached summary"
        warmSummaryBeforeSeq={2}
      />,
    );

    const handle = screen.getByRole("button", { name: /drag to move conversation focus/i }) as HTMLButtonElement;
    installPointerCapture(handle);

    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 120 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 120 });
    fireEvent.click(handle);

    expect(screen.getByText("Earlier messages summary")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(onSetContextPin).not.toHaveBeenCalled();
  });

  it("does not render a warm/recent boundary for unpinned threads", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "newer", "2026-08-09T10:00:01.000Z"),
    ];
    render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
        warmSummary={null}
      />,
    );

    expect(screen.queryByRole("button", { name: /drag to move conversation focus/i })).toBeNull();
    expect(screen.queryByLabelText("conversation focus boundary")).toBeNull();
  });

  it("renders a boundary for a persisted hot_since before summary metadata arrives", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "latest", "2026-08-09T10:00:01.000Z"),
    ];
    render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
        hotSinceSeq={3}
        warmSummary={null}
      />,
    );

    expect(screen.getByRole("button", { name: /drag to move conversation focus/i })).toBeTruthy();
    expect(screen.getByLabelText("conversation focus boundary")).toBeTruthy();
  });

  it("renders a breathing boundary while a confirmed focus move refreshes summary", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "latest", "2026-08-09T10:00:01.000Z"),
    ];
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
        hotSinceSeq={2}
        warmSummary="Old cached summary"
        warmSummaryBeforeSeq={1}
        warmSummaryPending={true}
      />,
    );

    const boundary = container.querySelector("[data-focus-boundary='1']");
    const line = boundary?.querySelector(".animate-pulse");
    const messageNodes = Array.from(container.querySelectorAll("[data-hot-candidate='1']"));

    expect(boundary).toBeTruthy();
    expect(line).toBeTruthy();
    expect(boundary!.compareDocumentPosition(messageNodes[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("recent 1 · warm 1")).toBeTruthy();
  });

  it("renders the boundary when hot_since has matching summary state", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "latest", "2026-08-09T10:00:01.000Z"),
    ];
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
        hotSinceSeq={3}
        warmSummary="Short cached summary"
        warmSummaryBeforeSeq={3}
      />,
    );

    const boundary = container.querySelector("[data-focus-boundary='1']");
    const messageNodes = Array.from(container.querySelectorAll("[data-hot-candidate='1']"));
    expect(boundary).toBeTruthy();
    expect(messageNodes[1].compareDocumentPosition(boundary!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("recent 0 · warm 2")).toBeTruthy();
  });

  it("renders and locates the exact source seq when message timestamps tie", () => {
    const timestamp = "2026-08-09T10:00:00.000Z";
    const messages = [
      mkMessage("m1", "user", "first tied row", timestamp),
      mkMessage("m2", "assistant", "pinned tied row", timestamp),
    ];
    const { container } = render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
        hotSinceSeq={2}
        warmSummary="Exact summary"
        warmSummaryBeforeSeq={2}
      />,
    );

    const boundary = container.querySelector("[data-focus-boundary='1']") as HTMLElement;
    const first = document.getElementById("1")!;
    const pinned = document.getElementById("2")!;
    expect(boundary.id).toBe("context-boundary-2");
    expect(first.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(boundary.compareDocumentPosition(pinned) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("recent 1 · warm 1")).toBeTruthy();

    const scrollIntoView = vi.fn();
    boundary.scrollIntoView = scrollIntoView;
    fireEvent.click(screen.getByRole("button", { name: /filters & focus/i }));
    const locate = screen.getByRole("button", { name: "Locate boundary line" });
    fireEvent.click(locate);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("keeps the anchor message on screen when hot_since relocates the boundary line", () => {
    const messages = [
      mkMessage("m1", "user", "one", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "two", "2026-08-09T10:00:01.000Z"),
      mkMessage("m3", "user", "three", "2026-08-09T10:00:02.000Z"),
      mkMessage("m4", "assistant", "four", "2026-08-09T10:00:03.000Z"),
    ];
    const { container, rerender } = render(
      <MessageList threadId="thread-1" messages={messages} hotSinceSeq={3} />,
    );

    const scroller = container.querySelector(".panel-scrollbar") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 300 });
    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 300 });

    setRect(container.querySelector('[data-message-id="m1"]')!, -200);
    setRect(container.querySelector('[data-message-id="m2"]')!, -50);
    setRect(container.querySelector('[data-message-id="m3"]')!, 150);
    setRect(container.querySelector('[data-message-id="m4"]')!, 400);

    // Scrolled away from the bottom with m3 the topmost visible message —
    // captures it as the anchor.
    fireEvent.scroll(scroller);
    expect(scroller.scrollTop).toBe(300);

    // Boundary relocates: in a real browser this shifts m3 (and
    // everything after it) up or down by the divider's own height; stand
    // in for that by nudging m3's rect by -50.
    setRect(container.querySelector('[data-message-id="m3"]')!, 100);
    rerender(
      <MessageList threadId="thread-1" messages={messages} hotSinceSeq={4} />,
    );

    // scrollTop drops by exactly the amount m3 moved up, so the anchor
    // message stays at the same on-screen position.
    expect(scroller.scrollTop).toBe(250);
  });

  it("disables Locate boundary line until a focus pin is set, then scrolls to it", () => {
    const messages = [
      mkMessage("m1", "user", "older", "2026-08-09T10:00:00.000Z"),
      mkMessage("m2", "assistant", "newer", "2026-08-09T10:00:01.000Z"),
    ];
    const { rerender } = render(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /filters & focus/i }));
    const button = screen.getByRole("button", { name: "Locate boundary line" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    rerender(
      <MessageList
        threadId="thread-1"
        messages={messages}
        onSetContextPin={vi.fn()}
        hotSinceSeq={2}
        warmSummary="Short cached summary"
        warmSummaryBeforeSeq={2}
      />,
    );

    const enabledButton = screen.getByRole("button", { name: "Locate boundary line" }) as HTMLButtonElement;
    expect(enabledButton.disabled).toBe(false);

    const scrollIntoView = vi.fn();
    const boundaryEl = document.querySelector("[data-focus-boundary='1']") as HTMLElement;
    boundaryEl.scrollIntoView = scrollIntoView;

    fireEvent.click(enabledButton);
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
