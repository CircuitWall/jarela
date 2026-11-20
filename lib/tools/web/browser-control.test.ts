import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  browserNavigateTool,
  browserClickTool,
  browserFillTool,
  browserFillManyTool,
  browserScrollTool,
  browserScreenshotTool,
  browserExtractTool,
  browserSnapshotTool,
  browserTabsTool,
  browserActivateTabTool,
  browserBatchTool,
  browserWaitTool,
  browserPressTool,
  resolveLocator,
  diffInteractive,
  _resetSnapshotCache,
} from "./browser-control";
import {
  pollNextCommand,
  submitResult,
  _resetQueue,
  _resetExtensionStatus,
  recordExtensionHandshake,
  BROWSER_PROTOCOL_VERSION,
  _markExtensionSeen,
  type BrowserCommand,
} from "@/lib/api/browser-control";

const writeBinaryFileMock = vi.fn<(name: string, data: Buffer) => string>();
const writeTextFileMock = vi.fn<(name: string, data: string) => string>();

vi.mock("@/lib/files", () => ({
  writeBinaryFile: (name: string, data: Buffer) => writeBinaryFileMock(name, data),
  writeTextFile: (name: string, data: string) => writeTextFileMock(name, data),
}));

beforeEach(() => {
  _resetQueue();
  _resetSnapshotCache();
  writeBinaryFileMock.mockReset();
  writeTextFileMock.mockReset();
  writeBinaryFileMock.mockImplementation((name) => `/tmp/${name}`);
  writeTextFileMock.mockImplementation((name) => `/tmp/${name}`);
});

afterEach(() => {
  _resetQueue();
  _resetSnapshotCache();
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
      if (cmd.type === "navigate") {
        expect(cmd.url).toBe("https://example.com");
        expect(cmd.timeout_ms).toBe(90_000);
      }
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

  it("classifies a host-permission failure as ask-user, naming the host", async () => {
    const p = browserNavigateTool.invoke({ url: "https://unpermitted.example/x" });
    const { parsed } = await driveTool(p, () => ({
      ok: false,
      error:
        "Cannot access contents of the url \"https://unpermitted.example/x\". Extension manifest must request permission to access this host.",
    }));

    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({
      error_code: "host_permission_required",
      hostname: "unpermitted.example",
      ask_user: true,
    });
    // The instruction is what stops the retry loop: it must name the proposal
    // kind and the settings surface where the decision lands.
    expect(String((parsed as Record<string, unknown>).next_step)).toContain("allow_site");
    expect(String((parsed as Record<string, unknown>).next_step)).toContain("Allowed sites");
  });

  it("leaves unrelated failures without a permission hint", async () => {
    const p = browserNavigateTool.invoke({ url: "https://example.com" });
    const { parsed } = await driveTool(p, () => ({ ok: false, error: "net::ERR_NAME_NOT_RESOLVED" }));
    expect(parsed).not.toHaveProperty("error_code");
    expect(parsed).not.toHaveProperty("next_step");
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

describe("browser_fill_many", () => {
  it("passes each field locator through for live resolution", async () => {
    const p = browserFillManyTool.invoke({
      fields: [
        { ref: 0, value: "a@example.com" },
        { role: "textbox", name: "Password", value: "secret" },
      ],
      submit_selector: "button[type=submit]",
    });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("fill_many");
      if (cmd.type === "fill_many") {
        expect(cmd.fields).toEqual([
          { ref: 0, value: "a@example.com" },
          { role: "textbox", name: "Password", value: "secret" },
        ]);
        expect(cmd.submit_selector).toBe("button[type=submit]");
        expect(cmd.auto_snapshot).toBe(true);
      }
      return { ok: true, data: { matched: true, matched_count: 2, total: 2 } };
    });
    expect(parsed.action).toBe("browser_fill_many");
    expect(parsed.ok).toBe(true);
  });

  it("errors without dispatching when a field locator is invalid", async () => {
    const out = await browserFillManyTool.invoke({ fields: [{ value: "x" }] });
    const parsed = JSON.parse(out);
    expect(parsed.action).toBe("browser_fill_many");
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/field 0/);
    const cmd = await pollNextCommand(50);
    expect(cmd).toBeNull();
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
    const p = browserExtractTool.invoke({ selector: "main", format: "text", max_chars: 1000, offset: 2000, output: "inline" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("extract");
      if (cmd.type === "extract") {
        expect(cmd.selector).toBe("main");
        expect(cmd.format).toBe("text");
        expect(cmd.max_chars).toBe(1000);
        expect(cmd.offset).toBe(2000);
      }
      return { ok: true, data: { content: "Hello world.", offset: 2000, next_offset: null } };
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ content: "Hello world.", offset: 2000, next_offset: null });
  });

  it("reduces truncated extracts to a local text artifact with preview and continuation metadata", async () => {
    const content = "x".repeat(20_000);
    const p = browserExtractTool.invoke({ selector: "main", format: "text", max_chars: 20_000 });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("extract");
      return { ok: true, data: { matched: true, format: "text", content, truncated: true, original_length: 40_000, offset: 0, next_offset: 20_000 } };
    });
    expect(parsed.ok).toBe(true);
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock.mock.calls[0][1]).toBe(content);
    const data = parsed.data as {
      content?: string;
      content_ref: { name: string; uri: string; chars: number };
      result_ref: { name: string; uri: string; chars: number; size: number };
      preview: string;
      next_offset: number;
    };
    expect(data.content).toBeUndefined();
    expect(data.content_ref.name).toMatch(/^browser-extract-.+\.txt$/);
    expect(data.result_ref).toEqual(data.content_ref);
    expect(data.content_ref.uri).toContain(data.content_ref.name);
    expect(data.content_ref.chars).toBe(content.length);
    expect(data.result_ref.size).toBe(content.length);
    expect(data.preview).toHaveLength(2000);
    expect(data.next_offset).toBe(20_000);
    expect(String((parsed as Record<string, unknown>).hint)).toMatch(/result_ref\.name/);
    expect(String((parsed as Record<string, unknown>).hint)).toMatch(/offset=next_offset/);
  });

  it("honors output=file for small extracts", async () => {
    const p = browserExtractTool.invoke({ format: "html", output: "file" });
    const { parsed } = await driveTool(p, () => ({
      ok: true,
      data: { matched: true, format: "html", content: "<main>Hello</main>", truncated: false, original_length: 18, offset: 0, next_offset: null },
    }));
    expect(parsed.ok).toBe(true);
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    const data = parsed.data as { content_ref: { name: string; mimeType: string } };
    expect(data.content_ref.name).toMatch(/^browser-extract-.+\.html$/);
    expect(data.content_ref.mimeType).toBe("text/html; charset=utf-8");
  });
});

describe("browser_tabs / browser_activate_tab", () => {
  it("enqueues a tab inventory command", async () => {
    const p = browserTabsTool.invoke({});
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("tabs");
      if (cmd.type === "tabs") expect(cmd.include_unusable).toBe(true);
      return { ok: true, data: { tabs: [{ tab_id: 7, title: "Example" }], total: 1 } };
    });
    expect(parsed.action).toBe("browser_tabs");
    expect(parsed.ok).toBe(true);
  });

  it("enqueues a tab activation command", async () => {
    const p = browserActivateTabTool.invoke({ tab_id: 7 });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("activate_tab");
      if (cmd.type === "activate_tab") expect(cmd.tab_id).toBe(7);
      return { ok: true, data: { tab_id: 7, focused: true } };
    });
    expect(parsed.action).toBe("browser_activate_tab");
    expect(parsed.ok).toBe(true);
  });
});

// --------------------------------------------------------------------- //
// Locator resolution, snapshot cache, diff                              //
// --------------------------------------------------------------------- //

const fakeSnapshot = {
  url: "https://example.com/login",
  title: "Login",
  tab_id: 7,
  interactive: [
    { idx: 0, role: "textbox", name: "Email", selector: "input[name=email]" },
    { idx: 1, role: "textbox", name: "Password", selector: "input[name=password]" },
    { idx: 2, role: "button", name: "Sign in", selector: "button[type=submit]" },
    { idx: 3, role: "link", name: "Forgot?", selector: "a.forgot" },
  ],
};

async function seedSnapshotCache() {
  const p = browserSnapshotTool.invoke({});
  const { parsed } = await driveTool(p, () => ({ ok: true, data: fakeSnapshot }));
  expect(parsed.ok).toBe(true);
}

describe("resolveLocator", () => {
  it("returns the selector verbatim when provided", () => {
    const r = resolveLocator({ selector: "#go" });
    expect(r).toEqual({ ok: true, locator: { selector: "#go" } });
  });

  it("errors with a clear message when nothing is provided", () => {
    const r = resolveLocator({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/selector.*ref.*role/);
  });

  it("passes a ref through without consulting any snapshot", () => {
    // The regression this guards: a handle used to be converted into a CSS
    // string server-side, which then went stale before it was used.
    const r = resolveLocator({ ref: 42 });
    expect(r).toEqual({ ok: true, locator: { ref: 42 } });
  });

  it("still accepts the legacy `handle` alias as a ref", () => {
    const r = resolveLocator({ handle: 7 });
    expect(r).toEqual({ ok: true, locator: { ref: 7 } });
  });

  it("rejects role alone (must pair with name)", () => {
    const r = resolveLocator({ role: "button" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/role.*name.*together/);
  });

  it("passes role + name through for live resolution", () => {
    const r = resolveLocator({ role: "button", name: "Sign in" });
    expect(r).toEqual({ ok: true, locator: { role: "button", name: "Sign in" } });
  });

  it("rejects two locator styles at once", () => {
    const r = resolveLocator({ selector: "#a", ref: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/exactly one/);
  });
});

describe("diffInteractive", () => {
  it("marks the first observation as baseline=first", () => {
    const next = {
      at: Date.now(),
      url: "https://x",
      items: fakeSnapshot.interactive.slice(0, 2),
    };
    const d = diffInteractive(null, next);
    expect(d.baseline).toBe("first");
    expect(d.added).toHaveLength(2);
    expect(d.removed).toHaveLength(0);
  });

  it("returns only the elements that changed when URL is stable", () => {
    const prev = {
      at: Date.now(),
      url: "https://x",
      items: [
        { idx: 0, role: "button", name: "Old", selector: "#old" },
        { idx: 1, role: "button", name: "Keep", selector: "#keep" },
      ],
    };
    const next = {
      at: Date.now(),
      url: "https://x",
      items: [
        { idx: 0, role: "button", name: "Keep", selector: "#keep" },
        { idx: 1, role: "button", name: "New", selector: "#new" },
      ],
    };
    const d = diffInteractive(prev, next);
    expect(d.baseline).toBe("diff");
    expect(d.added.map((i) => i.name)).toEqual(["New"]);
    expect(d.removed.map((i) => i.name)).toEqual(["Old"]);
    expect(d.unchanged).toBe(1);
  });

  it("treats URL change as a full reset (baseline=first)", () => {
    const prev = {
      at: Date.now(),
      url: "https://x",
      items: [{ idx: 0, role: "button", name: "A", selector: "#a" }],
    };
    const next = {
      at: Date.now(),
      url: "https://y",
      items: [{ idx: 0, role: "button", name: "A", selector: "#a" }],
    };
    const d = diffInteractive(prev, next);
    expect(d.baseline).toBe("first");
    expect(d.added).toHaveLength(1);
  });
});

describe("browser_snapshot", () => {
  it("renders the tree and keeps refs for later actions", async () => {
    const snapshot = {
      url: "https://example.com/login",
      tab_id: 7,
      filter: "interactive",
      tree: [
        { depth: 0, role: "button", name: "Sign in", ref: 5 },
        { depth: 0, role: "link", name: "Forgot?", ref: 6 },
      ],
      text: "Sign in Forgot?",
      interactive: [
        { idx: 0, ref: 5, role: "button", name: "Sign in", selector: "button[type=submit]" },
        { idx: 1, ref: 6, role: "link", name: "Forgot?", selector: "a.forgot" },
      ],
    };
    const p = browserSnapshotTool.invoke({ include_inventory: true });
    const { parsed } = await driveTool(p, () => ({ ok: true, data: snapshot }));
    const data = parsed.data as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(data.tree).toContain('button "Sign in" [ref 5]');
    expect(data.text).toContain("Forgot?");
    expect(data.interactive).toHaveLength(2);
    expect((data.cache as Record<string, unknown>).hit).toBe(false);
    // The cache is now keyed by tab, so a ref from this snapshot resolves
    // with no extra lookup anywhere.
    expect(resolveLocator({ ref: 5 })).toEqual({ ok: true, locator: { ref: 5 } });
  });

  it("omits the flat inventory unless it was asked for", async () => {
    const p = browserSnapshotTool.invoke({});
    const { parsed } = await driveTool(p, () => ({
      ok: true,
      data: { url: "https://x", tab_id: 1, tree: [{ depth: 0, role: "button", name: "Go", ref: 1 }], interactive: [] },
    }));
    expect((parsed.data as Record<string, unknown>).interactive).toBeUndefined();
  });

  it("reuses the cached page map by default", async () => {
    await seedSnapshotCache();
    const out = await browserSnapshotTool.invoke({});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.cache.hit).toBe(true);
    const cmd = await pollNextCommand(50);
    expect(cmd).toBeNull();
  });

  it("force_refresh bypasses the cached page map", async () => {
    await seedSnapshotCache();
    const p = browserSnapshotTool.invoke({ force_refresh: true });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("snapshot");
      return { ok: true, data: { ...fakeSnapshot, fingerprint: "fresh" } };
    });
    expect(parsed.ok).toBe(true);
    expect((parsed.data as Record<string, unknown>).cache).toMatchObject({ hit: false });
  });
});

describe("browser_click with ref / role+name", () => {
  it("sends a ref to the extension instead of a resolved selector", async () => {
    const p = browserClickTool.invoke({ ref: 2 });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("click");
      if (cmd.type === "click") {
        expect(cmd.ref).toBe(2);
        expect(cmd.selector).toBeUndefined();
        expect(cmd.auto_snapshot).toBe(true);
      }
      return { ok: true, data: { matched: true } };
    });
    expect(parsed.ok).toBe(true);
  });

  it("keeps role + name intact for the page to resolve", async () => {
    const p = browserClickTool.invoke({ role: "link", name: "Forgot?" });
    const { parsed } = await driveTool(p, (cmd) => {
      if (cmd.type === "click") {
        expect(cmd.role).toBe("link");
        expect(cmd.name).toBe("Forgot?");
      }
      return { ok: true, data: { matched: true } };
    });
    expect(parsed.ok).toBe(true);
  });

  it("errors without dispatching when no locator is supplied", async () => {
    const out = await browserClickTool.invoke({});
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/selector.*ref.*role/);
  });
});

describe("auto_snapshot piggyback", () => {
  it("updates the cache from a click result and emits a diff", async () => {
    await seedSnapshotCache();
    const p = browserClickTool.invoke({ ref: 2 });
    const { parsed } = await driveTool(p, () => ({
      ok: true,
      data: {
        matched: true,
        tag: "BUTTON",
        snapshot: {
          url: "https://example.com/login",
          title: "Login",
          tab_id: 7,
          interactive: [
            ...fakeSnapshot.interactive,
            { idx: 4, role: "button", name: "Try again", selector: "button.retry" },
          ],
        },
      },
    }));
    expect(parsed.ok).toBe(true);
    const body = parsed as unknown as {
      data: Record<string, unknown>;
      page: { url: string; total_interactive: number };
      diff: { baseline: string; added: Array<{ name: string }> };
      hint: string;
    };
    expect(body.data.snapshot).toBeUndefined();
    expect(body.page.url).toBe("https://example.com/login");
    expect(body.page.total_interactive).toBe(5);
    expect(body.diff.baseline).toBe("diff");
    expect(body.diff.added.map((i) => i.name)).toEqual(["Try again"]);
    expect(body.hint).toMatch(/diff\.added/);
    // The cache was refreshed — the new control carries the ref the next
    // action can use with no further lookup.
    expect(body.diff.added[0]).toMatchObject({ ref: 4, name: "Try again" });
    expect(resolveLocator({ handle: 4 })).toEqual({ ok: true, locator: { ref: 4 } });
  });

  it("falls through unchanged when the extension returns no snapshot", async () => {
    const p = browserClickTool.invoke({ selector: "#x" });
    const { parsed } = await driveTool(p, () => ({
      ok: true,
      data: { matched: true, tag: "DIV" },
    }));
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ matched: true, tag: "DIV" });
    // No "page"/"diff" keys when no snapshot was attached.
    expect((parsed as Record<string, unknown>).page).toBeUndefined();
    expect((parsed as Record<string, unknown>).diff).toBeUndefined();
  });
});
describe("browser_batch / browser_wait / browser_press", () => {
  it("enqueues the whole step list as one batch command", async () => {
    const p = browserBatchTool.invoke({
      steps: [
        { action: "click", ref: 3 },
        { action: "fill", ref: 4, value: "hello" },
        { action: "press", key: "Enter", expect: { selector: "#result" } },
      ],
    });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("batch");
      if (cmd.type === "batch") {
        expect(cmd.steps).toHaveLength(3);
        expect(cmd.steps[2].expect).toEqual({ selector: "#result" });
        expect(cmd.auto_snapshot).toBe(true);
        expect(cmd.timeout_ms).toBeGreaterThan(20_000);
      }
      return { ok: true, data: { steps: [{ ok: true }, { ok: true }, { ok: true }], halted_at: null } };
    });
    expect(parsed.action).toBe("browser_batch");
    expect(parsed.ok).toBe(true);
  });

  it("keeps per-step detail when the batch halted", async () => {
    const p = browserBatchTool.invoke({ steps: [{ action: "click", ref: 1 }, { action: "click", ref: 2 }] });
    const { parsed } = await driveTool(p, () => ({
      ok: false,
      error: "step 1 (click): no element matched ref 2",
      data: { halted_at: 1, steps: [{ index: 0, action: "click", ok: true }, { index: 1, action: "click", ok: false, error: "no element matched ref 2" }] },
    }));
    expect(parsed.ok).toBe(false);
    const data = (parsed as unknown as { data: { halted_at: number; steps: unknown[] } }).data;
    expect(data.halted_at).toBe(1);
    expect(data.steps).toHaveLength(2);
  });

  it("enqueues a wait with its condition", async () => {
    const p = browserWaitTool.invoke({ for: "text", text: "Saved", timeout_ms: 4_000 });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("wait");
      if (cmd.type === "wait") {
        expect(cmd.for).toBe("text");
        expect(cmd.text).toBe("Saved");
      }
      return { ok: true, data: { matched: true, for: "text", waited_ms: 120 } };
    });
    expect(parsed.ok).toBe(true);
  });

  it("presses to the focused element when no locator is given", async () => {
    const p = browserPressTool.invoke({ key: "Escape" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("press");
      if (cmd.type === "press") {
        expect(cmd.key).toBe("Escape");
        expect(cmd.ref).toBeUndefined();
        expect(cmd.selector).toBeUndefined();
      }
      return { ok: true, data: { matched: true, via: "focus" } };
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("browser_navigate history and ref capture", () => {
  it("supports reload without a URL", async () => {
    const p = browserNavigateTool.invoke({ to: "reload" });
    const { parsed } = await driveTool(p, (cmd) => {
      expect(cmd.type).toBe("navigate");
      if (cmd.type === "navigate") {
        expect(cmd.to).toBe("reload");
        expect(cmd.url).toBeUndefined();
      }
      return { ok: true, data: { tab_id: 3, url: "https://example.com" } };
    });
    expect(parsed.ok).toBe(true);
  });

  it("refuses to send both a URL and a history move", async () => {
    const out = await browserNavigateTool.invoke({ url: "https://example.com", to: "back" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not both/);
    expect(await pollNextCommand(50)).toBeNull();
  });

  it("crops a screenshot to a ref", async () => {
    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64");
    const p = browserScreenshotTool.invoke({ ref: 9 });
    const { parsed } = await driveTool(p, (cmd) => {
      if (cmd.type === "screenshot") {
        expect(cmd.ref).toBe(9);
        expect(cmd.selector).toBeUndefined();
      }
      return { ok: true, data: { base64: tinyPng, media_type: "image/png", cropped: true } };
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("browser_tabs tab_ref and metadata hint", () => {
  const tabsData = {
    tabs: [
      { tab_id: 88509162, window_id: 1, active: true, url: "http://127.0.0.1:4312/", host: "127.0.0.1", usable: true, title: "Jarela" },
      { tab_id: 88509170, window_id: 1, active: false, url: "", host: "", usable: false, title: "" },
    ],
  };

  it("adds a small symbolic tab_ref and keeps the numeric id", async () => {
    const p = browserTabsTool.invoke({});
    const { parsed } = await driveTool(p, () => ({ ok: true, data: tabsData }));
    const data = parsed.data as { tabs: Array<Record<string, unknown>>; metadata_hint?: string };
    expect(data.tabs[0].tab_ref).toBe(1);
    expect(data.tabs[0].tab_id).toBe(88509162);
    expect(data.tabs[1].tab_ref).toBe(2);
    expect(data.metadata_hint).toMatch(/Grant host access/);
  });

  it("activates by tab_ref without exposing the numeric id", async () => {
    const p1 = browserTabsTool.invoke({});
    await driveTool(p1, () => ({ ok: true, data: tabsData }));
    const p2 = browserActivateTabTool.invoke({ tab_ref: 2 });
    const { parsed } = await driveTool(p2, (cmd) => {
      expect(cmd.type).toBe("activate_tab");
      if (cmd.type === "activate_tab") expect(cmd.tab_id).toBe(88509170);
      return { ok: true, data: { tab_id: 88509170, focused: true } };
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects a tab_ref that is not in the last inventory", async () => {
    const out = await browserActivateTabTool.invoke({ tab_ref: 99 });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not in the last tab inventory|call browser_tabs first/);
    expect(await pollNextCommand(50)).toBeNull();
  });
});

describe("browser_snapshot refuses an empty payload", () => {
  it("reports a reload hint instead of a successful empty result", async () => {
    const p = browserSnapshotTool.invoke({ force_refresh: true });
    const { parsed } = await driveTool(p, () => ({ ok: true, data: { tab_id: 7 } }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/returned no page structure/);
    expect(parsed.error).toMatch(/Reload the extension/);
  });
});

describe("stale extension hint", () => {
  it("appends the reload instruction when the polling build is older", async () => {
    _resetExtensionStatus();
    _markExtensionSeen();
    recordExtensionHandshake(1, "0.2.0");
    const p = browserSnapshotTool.invoke({ force_refresh: true });
    const { parsed } = await driveTool(p, () => ({
      ok: true,
      data: { tab_id: 7 },
    }));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/protocol 1/);
    expect(parsed.error).toMatch(/reload it/);
  });

  it("stays quiet when the extension reports the current protocol", async () => {
    _resetExtensionStatus();
    _markExtensionSeen();
    recordExtensionHandshake(BROWSER_PROTOCOL_VERSION, "0.3.0");
    const p = browserClickTool.invoke({ selector: "#missing" });
    const { parsed } = await driveTool(p, () => ({ ok: false, error: "no element matched" }));
    expect(parsed.error).toBe("no element matched");
  });
});