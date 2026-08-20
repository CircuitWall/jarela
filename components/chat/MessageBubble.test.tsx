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
    expect(preview.className).toContain("h-full");
    expect(preview.className).toContain("w-full");
    expect(preview.className).toContain("object-contain");
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
