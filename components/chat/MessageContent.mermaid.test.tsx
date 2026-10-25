// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MarkdownContent } from "./MessageContent";

const renderer = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: renderer }));

describe("Mermaid diagram controls", () => {
  beforeEach(() => {
    renderer.initialize.mockReset();
    renderer.render.mockReset();
    renderer.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><script>alert(1)</script><text onclick="alert(1)">Safe diagram</text></svg>',
    });
  });

  it("downloads the sanitized SVG and exposes the original source for copying", async () => {
    const source = "flowchart TD\n  A[Start] --> B[Finish]";
    render(<MarkdownContent text={`\`\`\`mermaid\n${source}\n\`\`\``} />);
    const preview = await screen.findByRole("img", { name: "Mermaid diagram" });
    const download = screen.getByRole("link", { name: "Download diagram as SVG" });
    const href = download.getAttribute("href")!;
    expect(href.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const exported = decodeURIComponent(href.slice(href.indexOf(",") + 1));
    expect(exported).toBe(preview.innerHTML);
    expect(exported).toContain("Safe diagram");
    expect(exported).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(exported).not.toContain("<script");
    expect(exported).not.toContain("onclick");
    expect(download.getAttribute("download")).toBe("diagram.svg");
    expect(renderer.initialize).toHaveBeenCalledWith({
      startOnLoad: false, securityLevel: "strict", theme: "base",
    });

    const summary = screen.getByText("Diagram source");
    fireEvent.click(summary);
    expect(summary.parentElement?.hasAttribute("open")).toBe(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps source fallback and omits the download when rendering fails", async () => {
    renderer.render.mockRejectedValue(new Error("Invalid diagram"));
    render(<MarkdownContent text={"```mermaid\ninvalid diagram\n```"} />);
    expect(await screen.findByText("Mermaid preview unavailable")).toBeTruthy();
    expect(screen.getByText("invalid diagram")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download diagram as SVG" })).toBeNull();
  });

  it("does not offer a stale SVG while a changed diagram is rendering", async () => {
    const { rerender } = render(<MarkdownContent text={"```mermaid\nflowchart TD\n A --> B\n```"} />);
    await screen.findByRole("link", { name: "Download diagram as SVG" });
    renderer.render.mockReturnValue(new Promise(() => {}));
    rerender(<MarkdownContent text={"```mermaid\nflowchart TD\n B --> C\n```"} />);
    await screen.findByText("Rendering diagram...");
    expect(screen.queryByRole("link", { name: "Download diagram as SVG" })).toBeNull();
  });
});
