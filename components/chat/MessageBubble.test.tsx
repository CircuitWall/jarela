// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AppProvider } from "@/contexts/AppContext";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "@/api/types";

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
});
