import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  browserNavigateTool,
  browserClickTool,
  browserFillTool,
  browserScrollTool,
  browserScreenshotTool,
  browserExtractTool,
} from "./browser-control";
import {
  pollNextCommand,
  submitResult,
  _resetQueue,
  type BrowserCommand,
} from "@/lib/api/browser-control";

const writeBinaryFileMock = vi.fn<(name: string, data: Buffer) => string>();

vi.mock("@/lib/files", () => ({
  writeBinaryFile: (name: string, data: Buffer) => writeBinaryFileMock(name, data),
}));

beforeEach(() => {
  _resetQueue();
  writeBinaryFileMock.mockReset();
  writeBinaryFileMock.mockImplementation((name) => `/tmp/${name}`);
});

afterEach(() => {
  _resetQueue();
});

// Helper: drive a tool invocation by simulating the extension picking up
// the command, applying the test's chosen result, and waiting for the
// tool's stringified response.
async function driveTool<T>(
  toolPromise: Promise<string>,
  responder: (cmd: BrowserCommand) => { ok: true; data: T } | { ok: false; error: string },
): Promise<{ raw: string; parsed: { action: string; ok: boolean; data?: unknown; error?: string } }> {
  const cmd = await pollNextCommand(1000);
  if (!cmd) throw new Error("no command was enqueued");
  const outcome = responder(cmd);
  submitResult({ cmd_id: cmd.cmd_id, ...outcome });
  const raw = await toolPromise;
  return { raw, parsed: JSON.parse(raw) };
}

describe("browser_navigate", () => {
  it("enqueues a navigate command and surfaces the extension result", async () => {
    const p = browserNavigateTool.invoke({ url: "https://example.com" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("navigate");
      if (cmd.type === "navigate") expect(cmd.url).toBe("https://example.com");
      return { ok: true, data: { url: "https://example.com", title: "Example" } };
    });
    expect(parsed.action).toBe("browser_navigate");
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ url: "https://example.com", title: "Example" });
  });

  it("forwards wait_for_selector to the extension", async () => {
    const p = browserNavigateTool.invoke({
      url: "https://example.com",
      wait_for_selector: "#root",
    });
    const { parsed } = await driveTool(p, (cmd) => {
      if (cmd.type === "navigate") expect(cmd.wait_for_selector).toBe("#root");
      return { ok: true, data: { url: "https://example.com" } };
    });
    expect(parsed.ok).toBe(true);
  });

  it("returns an error JSON when the extension fails", async () => {
    const p = browserNavigateTool.invoke({ url: "https://example.com" });
    const { parsed } = await driveTool(p, () => ({ ok: false, error: "tab crashed" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("tab crashed");
  });
});

describe("browser_click", () => {
  it("enqueues a click with the selector and propagates success", async () => {
    const p = browserClickTool.invoke({ selector: "button#go" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("click");
      if (cmd.type === "click") expect(cmd.selector).toBe("button#go");
      return { ok: true, data: { matched: true } };
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("browser_fill", () => {
  it("enqueues a fill with value and submit flag", async () => {
    const p = browserFillTool.invoke({
      selector: "input[name=q]",
      value: "hello",
      submit: true,
    });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("fill");
      if (cmd.type === "fill") {
        expect(cmd.selector).toBe("input[name=q]");
        expect(cmd.value).toBe("hello");
        expect(cmd.submit).toBe(true);
      }
      return { ok: true, data: { filled: true } };
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("browser_scroll", () => {
  it("enqueues a scroll command with target", async () => {
    const p = browserScrollTool.invoke({ to: "bottom" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("scroll");
      if (cmd.type === "scroll") expect(cmd.to).toBe("bottom");
      return { ok: true, data: { scrolled: true } };
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("browser_screenshot", () => {
  it("persists the returned image and emits markdown", async () => {
    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const p = browserScreenshotTool.invoke({ selector: "header" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("screenshot");
      if (cmd.type === "screenshot") {
        expect(cmd.selector).toBe("header");
        expect(cmd.format).toBe("png");
      }
      return { ok: true, data: { base64: tinyPng, media_type: "image/png" } };
    });
    expect(parsed.ok).toBe(true);
    expect(writeBinaryFileMock).toHaveBeenCalledTimes(1);
    const data = parsed.data as { url: string; markdown: string; media_type: string };
    expect(data.url).toMatch(/^\/api\/v1\/files\/browser-.+\.png$/);
    expect(data.markdown).toContain(data.url);
    expect(data.media_type).toBe("image/png");
  });

  it("reports an error when extension returns no image data", async () => {
    const p = browserScreenshotTool.invoke({});
    const { parsed } = await driveTool(p, () => ({ ok: true, data: {} }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/no image data/);
    expect(writeBinaryFileMock).not.toHaveBeenCalled();
  });

  it("propagates extension errors without writing a file", async () => {
    const p = browserScreenshotTool.invoke({});
    const { parsed } = await driveTool(p, () => ({ ok: false, error: "captureVisibleTab denied" }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("captureVisibleTab denied");
    expect(writeBinaryFileMock).not.toHaveBeenCalled();
  });
});

describe("browser_extract", () => {
  it("requests the extension extract content and returns it", async () => {
    const p = browserExtractTool.invoke({ selector: "main", format: "text" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("extract");
      if (cmd.type === "extract") {
        expect(cmd.selector).toBe("main");
        expect(cmd.format).toBe("text");
      }
      return { ok: true, data: { content: "Hello world." } };
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ content: "Hello world." });
  });
});
