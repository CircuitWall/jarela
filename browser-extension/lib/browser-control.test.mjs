import { describe, it, expect, vi } from "vitest";
import { dispatchCommand, pageClickFn, pageFillFn, pageScrollFn, pageExtractFn } from "./browser-control.mjs";

// Provide DOM globals the page-functions touch when invoked in Node.
// They run inside the page (via chrome.scripting.executeScript) in
// production, but here we exercise the pure logic.
if (typeof globalThis.Event === "undefined") {
  globalThis.Event = class Event {
    constructor(type, init) { this.type = type; this.bubbles = !!init?.bubbles; }
  };
}
if (typeof globalThis.KeyboardEvent === "undefined") {
  globalThis.KeyboardEvent = class KeyboardEvent extends globalThis.Event {
    constructor(type, init) {
      super(type, init);
      this.key = init?.key;
      this.code = init?.code;
    }
  };
}
if (typeof globalThis.MutationObserver === "undefined") {
  globalThis.MutationObserver = class MutationObserver {
    constructor(_cb) {}
    observe() {}
    disconnect() {}
  };
}

function makeDeps(overrides = {}) {
  const calls = { executeScript: [], updateTab: [], captureVisibleTab: [] };
  const deps = {
    queryActiveTab: vi.fn().mockResolvedValue([{ id: 7, windowId: 1 }]),
    updateTab: vi.fn().mockImplementation((opts) => { calls.updateTab.push(opts); return Promise.resolve(); }),
    executeScript: vi.fn().mockImplementation((opts) => {
      calls.executeScript.push(opts);
      // Default: return matched=true. Tests override to simulate misses.
      return Promise.resolve([{ result: { matched: true } }]);
    }),
    captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
    waitTabLoaded: vi.fn().mockResolvedValue(undefined),
    cropPngBase64: vi.fn().mockResolvedValue("CROPPED"),
    ...overrides,
  };
  return { deps, calls };
}

describe("dispatchCommand — preconditions", () => {
  it("returns an error when no active tab is found", async () => {
    const { deps } = makeDeps({ queryActiveTab: vi.fn().mockResolvedValue([]) });
    const r = await dispatchCommand(deps, { type: "click", selector: "#x" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no active tab/);
  });

  it("rejects an unknown command type", async () => {
    const { deps } = makeDeps();
    const r = await dispatchCommand(deps, { type: "weird" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown command type/);
  });

  it("rejects falsy commands", async () => {
    const { deps } = makeDeps();
    const r = await dispatchCommand(deps, null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid command/);
  });
});

describe("dispatchCommand — navigate", () => {
  it("calls chrome.tabs.update and resolves when tab finishes loading", async () => {
    const { deps, calls } = makeDeps();
    const r = await dispatchCommand(deps, { type: "navigate", url: "https://example.com" });
    expect(r.ok).toBe(true);
    expect(deps.updateTab).toHaveBeenCalledWith({ tabId: 7, url: "https://example.com" });
    expect(deps.waitTabLoaded).toHaveBeenCalledWith(7, 30_000);
    expect(calls.updateTab[0]).toEqual({ tabId: 7, url: "https://example.com" });
  });

  it("errors when wait_for_selector never resolves", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { found: false } }]),
    });
    const r = await dispatchCommand(deps, {
      type: "navigate",
      url: "https://example.com",
      wait_for_selector: "#never",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/wait_for_selector/);
  });
});

describe("dispatchCommand — click / fill / scroll / extract", () => {
  it("click reports matched=false as an error", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: false } }]),
    });
    const r = await dispatchCommand(deps, { type: "click", selector: "#missing" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no element matched/);
  });

  it("fill passes selector/value/submit through to the page function", async () => {
    const { deps } = makeDeps();
    await dispatchCommand(deps, {
      type: "fill",
      selector: "input",
      value: "hi",
      submit: true,
    });
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.target).toEqual({ tabId: 7 });
    expect(opts.args).toEqual(["input", "hi", true]);
  });

  it("scroll uses the dispatched arguments", async () => {
    const { deps } = makeDeps();
    await dispatchCommand(deps, { type: "scroll", to: "bottom" });
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.args).toEqual([null, "bottom"]);
  });

  it("extract bubbles up text from the page", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: true, content: "Hello.", format: "text" } }]),
    });
    const r = await dispatchCommand(deps, { type: "extract", selector: "main", format: "text" });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ matched: true, content: "Hello.", format: "text" });
  });
});

describe("dispatchCommand — screenshot", () => {
  it("captures the whole viewport when no selector is given", async () => {
    const { deps } = makeDeps();
    const r = await dispatchCommand(deps, { type: "screenshot", format: "png" });
    expect(r.ok).toBe(true);
    expect(r.data.media_type).toBe("image/png");
    expect(r.data.base64).toBe("AAAA");
    expect(r.data.cropped).toBe(false);
    expect(deps.captureVisibleTab).toHaveBeenCalled();
  });

  it("crops to element bounds when selector supplied", async () => {
    let call = 0;
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation(() => {
        call++;
        // First call: pageElementBoundsFn
        if (call === 1) {
          return Promise.resolve([{ result: { matched: true, dpr: 1, x: 10, y: 20, width: 100, height: 50 } }]);
        }
        return Promise.resolve([{ result: { matched: true } }]);
      }),
    });
    const r = await dispatchCommand(deps, { type: "screenshot", selector: "header", format: "png" });
    expect(r.ok).toBe(true);
    expect(deps.cropPngBase64).toHaveBeenCalledTimes(1);
    expect(r.data.cropped).toBe(true);
    expect(r.data.base64).toBe("CROPPED");
  });

  it("falls back to uncropped image when cropPngBase64 throws", async () => {
    let call = 0;
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation(() => {
        call++;
        if (call === 1) {
          return Promise.resolve([{ result: { matched: true, dpr: 1, x: 0, y: 0, width: 10, height: 10 } }]);
        }
        return Promise.resolve([{ result: { matched: true } }]);
      }),
      cropPngBase64: vi.fn().mockRejectedValue(new Error("OffscreenCanvas unavailable")),
    });
    const r = await dispatchCommand(deps, { type: "screenshot", selector: "header" });
    expect(r.ok).toBe(true);
    expect(r.data.cropped).toBe(false);
    expect(r.data.base64).toBe("AAAA");
  });

  it("errors when the selector matches nothing", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: false } }]),
    });
    const r = await dispatchCommand(deps, { type: "screenshot", selector: "#missing" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no element matched/);
  });
});

// --------------------------------------------------------------------- //
// pageXxxFn — pure DOM helpers. We exercise the logic with jsdom-like
// stubs of document/window to validate selection + dispatch semantics
// without spinning up a browser.
// --------------------------------------------------------------------- //

function makeFakeElement(extra = {}) {
  const events = [];
  return {
    tagName: "DIV",
    isContentEditable: false,
    value: "",
    textContent: "",
    innerHTML: "<span>HI</span>",
    outerHTML: "<div><span>HI</span></div>",
    innerText: "HI",
    form: null,
    focus: () => {},
    click: () => events.push({ type: "click" }),
    scrollIntoView: () => events.push({ type: "scroll" }),
    closest: () => null,
    dispatchEvent: (ev) => { events.push({ type: ev.type, key: ev.key }); return true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    _events: events,
    ...extra,
  };
}

describe("pageClickFn (pure)", () => {
  it("returns matched=false when nothing is found", () => {
    globalThis.document = { querySelector: () => null };
    expect(pageClickFn("#missing")).toEqual({ matched: false });
  });

  it("scrolls into view and clicks the element", () => {
    const el = makeFakeElement();
    globalThis.document = { querySelector: () => el };
    const r = pageClickFn("#go");
    expect(r).toEqual({ matched: true, tag: "DIV" });
    expect(el._events.map((e) => e.type)).toEqual(["scroll", "click"]);
  });
});

describe("pageFillFn (pure)", () => {
  it("sets the value and dispatches input + change", () => {
    const el = makeFakeElement({ value: "" });
    globalThis.document = { querySelector: () => el };
    const r = pageFillFn("input", "hi", false);
    expect(r.matched).toBe(true);
    expect(el.value).toBe("hi");
    const types = el._events.map((e) => e.type);
    expect(types).toContain("input");
    expect(types).toContain("change");
  });

  it("dispatches an Enter keydown when submit=true and no form is present", () => {
    const el = makeFakeElement({ value: "" });
    globalThis.document = { querySelector: () => el };
    pageFillFn("input", "hi", true);
    const types = el._events.map((e) => e.type);
    expect(types).toContain("keydown");
  });

  it("returns matched=false on missing element", () => {
    globalThis.document = { querySelector: () => null };
    expect(pageFillFn("input", "hi", false)).toEqual({ matched: false });
  });
});

describe("pageScrollFn (pure)", () => {
  it("scrolls to top via window.scrollTo", () => {
    let target = null;
    globalThis.document = { body: { scrollHeight: 5000 } };
    globalThis.window = { scrollTo: (opts) => { target = opts; } };
    expect(pageScrollFn(null, "top")).toEqual({ scrolled: "top" });
    expect(target.top).toBe(0);
  });

  it("scrolls into view when given an element", () => {
    const el = makeFakeElement();
    globalThis.document = { querySelector: () => el };
    const r = pageScrollFn("main", "into-view");
    expect(r).toEqual({ matched: true, scrolled: "into-view" });
  });

  it("requires a selector for to=into-view", () => {
    globalThis.document = { querySelector: () => null };
    const r = pageScrollFn(null, "into-view");
    expect(r.matched).toBe(false);
    expect(r.reason).toMatch(/selector required/);
  });
});

describe("pageExtractFn (pure)", () => {
  it("returns inner text by default", () => {
    const el = makeFakeElement();
    globalThis.document = { querySelector: () => el, body: el };
    const r = pageExtractFn(null, "text", 100);
    expect(r.matched).toBe(true);
    expect(r.content).toBe("HI");
    expect(r.format).toBe("text");
  });

  it("returns innerHTML when format=html", () => {
    const el = makeFakeElement();
    globalThis.document = { querySelector: () => el, body: el };
    const r = pageExtractFn(null, "html", 100);
    expect(r.content).toBe("<span>HI</span>");
  });

  it("truncates when content exceeds max_chars", () => {
    const el = makeFakeElement({ innerText: "abcdefghij" });
    globalThis.document = { querySelector: () => el, body: el };
    const r = pageExtractFn(null, "text", 5);
    expect(r.content).toBe("abcde");
    expect(r.truncated).toBe(true);
    expect(r.original_length).toBe(10);
  });

  it("returns matched=false when selector matches nothing", () => {
    globalThis.document = { querySelector: () => null };
    expect(pageExtractFn("#missing", "text", 100)).toEqual({ matched: false });
  });
});
