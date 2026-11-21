// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkifiedText } from "./LinkifiedText";

const pushToast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ui/toasts", () => ({ pushToast }));

describe("LinkifiedText", () => {
  it("opens web references in a new window and keeps surrounding punctuation", () => {
    const { container } = render(
      <LinkifiedText text="See https://example.com/docs, then reply." />,
    );

    const link = screen.getByRole("link", { name: "https://example.com/docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).toBe("See https://example.com/docs, then reply.");
  });

  it("turns file references into open-file actions", () => {
    render(<LinkifiedText text={"Updated src/app/page.tsx and C:\\repo\\README.md."} />);

    expect(screen.getByRole("button", { name: "src/app/page.tsx" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "C:\\repo\\README.md" })).toBeTruthy();
  });

  it("leaves prose that merely contains a separator alone", () => {
    render(<LinkifiedText text="either/or and/or 3/4 done" />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
