// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AppProvider } from "@/contexts/AppContext";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/api/types";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MessageBubble image attachments", () => {
  it("renders sent images at viewport-sized bubble width while preserving original pixel bounds", () => {
    const content = JSON.stringify([
      { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" },
    ]);
    const message: Message = {
      id: "img-1",
      role: "user",
      content,
      created_at: "2026-08-15T12:00:00.000Z",
      status: "confirmed",
    };

    render(
      <AppProvider>
        <MessageBubble message={message} showAvatar={false} />
      </AppProvider>,
    );

    const img = screen.getByAltText("attached image");
    expect(img.className).toContain("w-full");
    expect(img.getAttribute("style")).toContain("object-fit: contain");
    let node: HTMLElement | null = img;
    while (node && !String(node.className).includes("max-w-[calc(100%-2.25rem)]")) {
      node = node.parentElement;
    }
    expect(node).toBeTruthy();
  });

  it("opens image preview in an in-app dialog with a close control", () => {
    const content = JSON.stringify([
      { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" },
    ]);
    const message: Message = {
      id: "img-2",
      role: "user",
      content,
      created_at: "2026-08-15T12:00:00.000Z",
      status: "confirmed",
    };

    render(
      <AppProvider>
        <MessageBubble message={message} showAvatar={false} />
      </AppProvider>,
    );

    fireEvent.click(screen.getByAltText("attached image"));

    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens markdown images in the same viewport-sized preview dialog", () => {
    const message: Message = {
      id: "img-md-1",
      role: "assistant",
      content: "Here is one: ![diagram](/api/v1/files/diagram.png)",
      created_at: "2026-08-15T12:00:00.000Z",
      status: "confirmed",
    };

    render(
      <AppProvider>
        <MessageBubble message={message} showAvatar={false} />
      </AppProvider>,
    );

    fireEvent.click(screen.getByAltText("diagram"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    const preview = screen.getAllByAltText("diagram").at(-1)!;
    expect(preview.className).toContain("max-h-full");
    expect(preview.className).toContain("max-w-full");
    expect(preview.className).toContain("object-contain");
  });
});

describe("MessageBubble transcript status", () => {
  it("shows the persisted interruption reason below the partial reply", () => {
    render(
      <AppProvider>
        <MessageBubble
          message={{
            id: "assistant-interrupted",
            role: "assistant",
            content: "The partial response",
            created_at: "2026-08-15T12:00:00.000Z",
            transcript_status: "interrupted",
            status_reason: "Stopped by user.",
          }}
          showAvatar={false}
        />
      </AppProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("Response interrupted");
    expect(screen.getByRole("status").textContent).toContain("Stopped by user.");
  });

  it("shows a safe status reason for a failed run with no response text", () => {
    render(
      <AppProvider>
        <MessageBubble
          message={{
            id: "assistant-failed",
            role: "assistant",
            content: "",
            created_at: "2026-08-15T12:00:00.000Z",
            category: "run_error",
            transcript_status: "failed",
            status_reason: "The response could not be prepared.",
          }}
          showAvatar={false}
        />
      </AppProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("Run failed");
    expect(screen.getByRole("status").textContent).toContain("The response could not be prepared.");
  });
});

describe("MessageBubble local file links", () => {
  it("renders a local markdown link as an inline snippet instead of a localhost anchor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        path: "C:\\repo\\README.md",
        name: "README.md",
        size: 12,
        renderable: true,
        snippet: "# Jarela",
        truncated: false,
      }),
    } as Response);
    const message: Message = {
      id: "local-link-1",
      role: "assistant",
      content: "Open [README](README.md)",
      created_at: "2026-08-16T12:00:00.000Z",
      status: "confirmed",
    };

    render(
      <AppProvider>
        <MessageBubble message={message} showAvatar={false} threadId="thread-1" />
      </AppProvider>,
    );

    const linkButton = screen.getByRole("button", { name: /README/i });
    expect(screen.queryByRole("link", { name: /README/i })).toBeNull();

    fireEvent.click(linkButton);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/local-file?href=README.md&thread_id=thread-1");
    expect(await screen.findByText("# Jarela")).toBeTruthy();
  });
});

describe("MessageBubble automation activity", () => {
  it("shows bridge listener outcome on the original inbound message card", () => {
    const message: Message = {
      id: "bridge-message-1",
      role: "user",
      category: "bridge",
      content: "[bridge:b1]\n[chat_id:chat-1]\n[chat_name:Family]\n[chat_type:group]\n[message_role:counterpart]\n[sender_id:diana]\n[sender_name:Diana]\n\nCompetition invitation",
      created_at: "2026-08-16T12:34:00.000Z",
      status: "confirmed",
      metadata: { bridge_conversation: { key: "b1:chat-1", bridge_id: "b1", chat_id: "chat-1" } },
    };

    render(
      <AppProvider>
        <MessageBubble
          message={message}
          attachedActivity={{
            version: 1,
            source_kind: "bridge",
            source_id: "b1:chat-1",
            label: "Message from Diana",
            state: "complete",
            disposition: "no_action",
            occurrence_count: 2,
            first_at: "2026-08-16T12:00:00.000Z",
            last_at: "2026-08-16T12:34:00.000Z",
          }}
          showAvatar={false}
        />
      </AppProvider>,
    );

    expect(screen.getByText("No action needed · 2 checks")).toBeTruthy();
    expect(screen.getByText("Competition invitation")).toBeTruthy();
  });

  it("shows scheduled-task and watcher context inside the related assistant response", () => {
    const message: Message = {
      id: "watcher-response-1",
      role: "assistant",
      category: "watcher",
      content: "The watched value changed.",
      created_at: "2026-08-16T12:34:00.000Z",
      status: "confirmed",
    };

    render(
      <AppProvider>
        <MessageBubble
          message={message}
          attachedActivity={{
            version: 1,
            source_kind: "watcher",
            source_id: "watcher-1",
            label: "Temperature watcher",
            state: "complete",
            disposition: "action",
            occurrence_count: 1,
            first_at: "2026-08-16T12:00:00.000Z",
            last_at: "2026-08-16T12:34:00.000Z",
            detail: "The temperature changed from 18 to 22.",
          }}
          showAvatar={false}
        />
      </AppProvider>,
    );

    expect(screen.getByRole("status").textContent).toContain("Action taken");
    expect(screen.getByText("The watched value changed.")).toBeTruthy();
    fireEvent.click(screen.getByText("Trigger"));
    expect(screen.getByText("The temperature changed from 18 to 22.")).toBeTruthy();
  });

  it("renders a centered activity row and expands available details", () => {
    const lastAt = "2026-08-16T12:34:00.000Z";
    const message: Message = {
      id: "activity-1",
      role: "assistant",
      content: "Inbox watcher: no action needed",
      created_at: lastAt,
      status: "confirmed",
      metadata: {
        automation_activity: {
          version: 1,
          source_kind: "watcher",
          source_id: "watcher-1",
          label: "Inbox watcher",
          state: "complete",
          disposition: "no_action",
          occurrence_count: 3,
          first_at: "2026-08-16T12:00:00.000Z",
          last_at: lastAt,
          detail: "Checked for new messages.",
          preview: "No matching messages.",
          error: "One mailbox was unavailable.",
        },
      },
    };

    render(
      <AppProvider>
        <MessageBubble message={message} />
      </AppProvider>,
    );

    const row = screen.getByRole("status");
    expect(row.textContent).toContain("Watcher");
    expect(row.textContent).toContain("Inbox watcher");
    expect(row.textContent).toContain("No action needed");
    expect(row.textContent).toContain("3 checks");
    expect(row.textContent).toContain(
      new Date(lastAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    );
    expect(screen.queryByText("Checked for new messages.")).toBeNull();
    expect(screen.queryByLabelText("Copy message text")).toBeNull();

    const disclosure = screen.getByRole("button", { name: "Show automation activity details" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(screen.getByText("Checked for new messages.")).toBeTruthy();
    expect(screen.getByText("No matching messages.")).toBeTruthy();
    expect(screen.getByText("One mailbox was unavailable.")).toBeTruthy();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  });
});
