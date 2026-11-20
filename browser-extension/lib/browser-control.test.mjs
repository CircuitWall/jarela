import { describe, it, expect, vi } from "vitest";
import { dispatchCommand, pageActFn, pageScrollFn, pageExtractFn, pageSnapshotFn, pageWaitFn, pageWaitForDomIdleFn } from "./browser-control.mjs";

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
    queryTabs: vi.fn().mockResolvedValue([{ id: 7, windowId: 1, index: 0, active: true, url: "https://example.com", title: "Example", status: "complete" }]),
    getPinnedTab: vi.fn().mockResolvedValue(null),
    getForegroundTab: vi.fn().mockResolvedValue({ tabId: 7 }),
    getLastFocusedWindow: vi.fn().mockResolvedValue({ id: 1, focused: true }),
    updateTab: vi.fn().mockImplementation((opts) => { calls.updateTab.push(opts); return Promise.resolve(); }),
    activateTab: vi.fn().mockResolvedValue({ id: 7, windowId: 1, url: "https://example.com", title: "Example" }),
    focusWindow: vi.fn().mockResolvedValue({ id: 1, focused: true }),
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

  it("does not require an active tab to list tabs", async () => {
    const { deps } = makeDeps({ queryActiveTab: vi.fn().mockResolvedValue([]) });
    const r = await dispatchCommand(deps, { type: "tabs", include_unusable: true });
    expect(r.ok).toBe(true);
    expect(r.data.tabs[0].tab_id).toBe(7);
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

  it("fill passes the locator and value through to the page function", async () => {
    const { deps } = makeDeps();
    await dispatchCommand(deps, {
      type: "fill",
      selector: "input",
      value: "hi",
      submit: true,
    });
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.target).toEqual({ tabId: 7 });
    expect(opts.args[0]).toBe("fill");
    expect(opts.args[1]).toMatchObject({ selector: "input", value: "hi", submit: true });
  });

  it("fill_many fills all fields in one page execution", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: true, matched_count: 2, total: 2, fields: [{ matched: true }, { matched: true }] } }]),
    });
    const r = await dispatchCommand(deps, {
      type: "fill_many",
      fields: [
        { selector: "input[name=email]", value: "a@example.com" },
        { selector: "input[name=name]", value: "A" },
      ],
      submit_selector: "button[type=submit]",
    });
    expect(r.ok).toBe(true);
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.target).toEqual({ tabId: 7 });
    expect(opts.args[0]).toBe("fill_many");
    expect(opts.args[1].fields).toEqual([
      { selector: "input[name=email]", value: "a@example.com" },
      { selector: "input[name=name]", value: "A" },
    ]);
    expect(opts.args[1].submit_selector).toBe("button[type=submit]");
  });

  it("fill_many reports partial field misses", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: false, matched_count: 1, total: 2, fields: [{ matched: true }, { selector: "#missing", matched: false }] } }]),
    });
    const r = await dispatchCommand(deps, {
      type: "fill_many",
      fields: [{ selector: "#ok", value: "ok" }, { selector: "#missing", value: "missing" }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/1 of 2 fields/);
    expect(r.data.fields[1].selector).toBe("#missing");
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

  it("extract passes offset for chunked reads", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: true, content: "llo", format: "text", offset: 2, next_offset: null } }]),
    });
    await dispatchCommand(deps, { type: "extract", selector: "main", format: "text", max_chars: 3, offset: 2 });
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.args).toEqual(["main", "text", 3, 2]);
  });

  it("snapshot routes to pageSnapshotFn with options", async () => {
    const fakeSnap = { url: "https://x", title: "x", interactive: [] };
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: fakeSnap }]),
    });
    const r = await dispatchCommand(deps, { type: "snapshot", max_items: 25, include_hidden: true, filter: "text", depth: 4 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject(fakeSnap);
    expect(r.data.tab_id).toBe(7);
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.args[0]).toMatchObject({ max_items: 25, include_hidden: true, filter: "text", depth: 4 });
  });

  it("page snapshot includes a stable fingerprint", () => {
    const button = makeFakeElement({
      tagName: "BUTTON",
      textContent: "Save",
      innerText: "Save",
      getAttribute: () => null,
      previousElementSibling: null,
      parentElement: null,
      children: [],
    });
    globalThis.location = { href: "https://example.com" };
    globalThis.window = {
      innerWidth: 1000,
      innerHeight: 800,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    globalThis.document = {
      title: "Example",
      body: { nodeType: 1, innerText: "Save", children: [button], hidden: false, getAttribute: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }) },
      documentElement: { scrollHeight: 1000 },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector) => selector.includes("button") ? [button] : [],
    };
    const first = pageSnapshotFn({ max_items: 10 });
    const second = pageSnapshotFn({ max_items: 10 });
    expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

describe("dispatchCommand — tabs", () => {
  it("returns tab inventory with target markers", async () => {
    const { deps } = makeDeps({
      queryTabs: vi.fn().mockResolvedValue([
        { id: 7, windowId: 1, index: 0, active: true, url: "https://example.com", title: "Example", status: "complete" },
        { id: 8, windowId: 1, index: 1, active: false, url: "chrome://settings", title: "Settings", status: "complete" },
      ]),
      getPinnedTab: vi.fn().mockResolvedValue({ tabId: 7 }),
      getForegroundTab: vi.fn().mockResolvedValue({ tabId: 7 }),
      getLastFocusedWindow: vi.fn().mockResolvedValue({ id: 1 }),
    });
    const r = await dispatchCommand(deps, { type: "tabs", include_unusable: true });
    expect(r.ok).toBe(true);
    expect(r.data.tabs).toHaveLength(2);
    expect(r.data.tabs[0]).toMatchObject({ tab_id: 7, host: "example.com", active: true, focused_window: true, pinned_target: true, foreground: true, usable: true });
    expect(r.data.tabs[1]).toMatchObject({ tab_id: 8, usable: false });
  });

  it("filters unusable tabs unless include_unusable is set", async () => {
    const { deps } = makeDeps({
      queryTabs: vi.fn().mockResolvedValue([
        { id: 7, windowId: 1, index: 0, active: true, url: "https://example.com", title: "Example" },
        { id: 8, windowId: 1, index: 1, active: false, url: "chrome://settings", title: "Settings" },
      ]),
    });
    const r = await dispatchCommand(deps, { type: "tabs" });
    expect(r.ok).toBe(true);
    expect(r.data.tabs.map((tab) => tab.tab_id)).toEqual([7]);
  });

  it("activates the tab and focuses its window", async () => {
    const { deps } = makeDeps();
    const r = await dispatchCommand(deps, { type: "activate_tab", tab_id: 7 });
    expect(r.ok).toBe(true);
    expect(deps.activateTab).toHaveBeenCalledWith(7);
    expect(deps.focusWindow).toHaveBeenCalledWith(1);
    expect(r.data).toMatchObject({ tab_id: 7, window_id: 1, focused: true });
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
    nodeType: 1,
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

describe("pageActFn (pure)", () => {
  it("returns no_match when the selector matches nothing", () => {
    globalThis.document = { querySelector: () => null };
    const r = pageActFn("click", { selector: "#missing" });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("no_match");
  });

  it("clicks the element found by selector", () => {
    const el = makeFakeElement();
    globalThis.document = { querySelector: () => el };
    const r = pageActFn("click", { selector: "#go" });
    expect(r).toMatchObject({ matched: true, tag: "DIV", via: "selector" });
    const types = el._events.map((e) => e.type);
    expect(types).toContain("scroll");
    expect(types).toContain("click");
  });

  it("resolves a ref against the page registry", () => {
    const el = makeFakeElement({ isConnected: true });
    globalThis.__jarelaAgentNodes = new Map([[42, { node: el, role: "button", name: "Save" }]]);
    globalThis.document = { querySelector: () => null };
    const r = pageActFn("click", { ref: 42 });
    expect(r).toMatchObject({ matched: true, via: "ref" });
    expect(el._events.map((e) => e.type)).toContain("click");
  });

  it("reports a stale ref together with what it used to be", () => {
    const el = makeFakeElement({ isConnected: false });
    globalThis.__jarelaAgentNodes = new Map([[43, { node: el, role: "button", name: "Save" }]]);
    globalThis.document = { querySelector: () => null };
    const r = pageActFn("click", { ref: 43 });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("stale_ref");
    expect(r.stale).toEqual({ role: "button", name: "Save" });
  });

  it("asks for a snapshot when no locator is supplied", () => {
    globalThis.document = { querySelector: () => null };
    const r = pageActFn("click", {});
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("needs_snapshot");
  });

  it("falls back to the selector when the ref is stale", () => {
    const fallback = makeFakeElement();
    globalThis.__jarelaAgentNodes = new Map();
    globalThis.document = { querySelector: () => fallback };
    const r = pageActFn("click", { ref: 999, selector: "#fallback" });
    expect(r).toMatchObject({ matched: true, via: "selector" });
  });

  it("sets the value and dispatches input + change", () => {
    const el = makeFakeElement({ tagName: "INPUT", value: "" });
    globalThis.document = { querySelector: () => el };
    const r = pageActFn("fill", { selector: "input", value: "hi" });
    expect(r.matched).toBe(true);
    expect(el.value).toBe("hi");
    const types = el._events.map((e) => e.type);
    expect(types).toContain("input");
    expect(types).toContain("change");
  });

  it("dispatches an Enter keydown when submit=true and no form is present", () => {
    const el = makeFakeElement({ tagName: "INPUT", value: "" });
    globalThis.document = { querySelector: () => el };
    pageActFn("fill", { selector: "input", value: "hi", submit: true });
    expect(el._events.map((e) => e.type)).toContain("keydown");
  });

  it("selects a native option by visible text", () => {
    const el = makeFakeElement({
      tagName: "SELECT",
      value: "",
      options: [
        { value: "a", textContent: "Alpha" },
        { value: "b", textContent: "Beta" },
      ],
    });
    globalThis.document = { querySelector: () => el };
    const r = pageActFn("fill", { selector: "select", value: "Beta" });
    expect(r.matched).toBe(true);
    expect(el.value).toBe("b");
  });

  it("reports the available options when a select value does not match", () => {
    const el = makeFakeElement({ tagName: "SELECT", value: "", options: [{ value: "a", textContent: "Alpha" }] });
    globalThis.document = { querySelector: () => el };
    const r = pageActFn("fill", { selector: "select", value: "Nope" });
    expect(r.matched).toBe(false);
    expect(r.reason).toBe("option_not_found");
    expect(r.options).toEqual([{ value: "a", label: "Alpha" }]);
  });

  it("presses a key on the resolved element", () => {
    const el = makeFakeElement({ tagName: "INPUT" });
    globalThis.document = { querySelector: () => el };
    const r = pageActFn("press", { selector: "input", key: "Escape" });
    expect(r.matched).toBe(true);
    expect(el._events.some((e) => e.type === "keydown" && e.key === "Escape")).toBe(true);
  });

  it("fills several fields and clicks the submit ref in one pass", () => {
    const email = makeFakeElement({ tagName: "INPUT", value: "" });
    const name = makeFakeElement({ tagName: "INPUT", value: "" });
    const submit = makeFakeElement({ tagName: "BUTTON", isConnected: true });
    globalThis.__jarelaAgentNodes = new Map([[7, { node: submit, role: "button", name: "Send" }]]);
    globalThis.document = {
      querySelector: (selector) => ({
        "input[name=email]": email,
        "input[name=name]": name,
      })[selector] ?? null,
    };
    const r = pageActFn("fill_many", {
      fields: [
        { selector: "input[name=email]", value: "a@example.com" },
        { selector: "input[name=name]", value: "Ada" },
      ],
      submit_ref: 7,
    });
    expect(r.matched).toBe(true);
    expect(r.matched_count).toBe(2);
    expect(email.value).toBe("a@example.com");
    expect(name.value).toBe("Ada");
    expect(submit._events.map((e) => e.type)).toContain("click");
  });

  it("does not include raw values in per-field results", () => {
    const el = makeFakeElement({ tagName: "INPUT", value: "" });
    globalThis.document = { querySelector: () => el };
    const r = pageActFn("fill_many", { fields: [{ selector: "input", value: "secret" }] });
    expect(JSON.stringify(r.fields)).not.toContain("secret");
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
    expect(r.next_offset).toBe(5);
  });

  it("continues extraction from offset", () => {
    const el = makeFakeElement({ innerText: "abcdefghij" });
    globalThis.document = { querySelector: () => el, body: el };
    const r = pageExtractFn(null, "text", 4, 4);
    expect(r.content).toBe("efgh");
    expect(r.offset).toBe(4);
    expect(r.next_offset).toBe(8);
  });

  it("returns matched=false when selector matches nothing", () => {
    globalThis.document = { querySelector: () => null };
    expect(pageExtractFn("#missing", "text", 100)).toEqual({ matched: false });
  });
});

// --------------------------------------------------------------------- //
// auto_snapshot piggyback + DOM-idle waiter
// --------------------------------------------------------------------- //

describe("dispatchCommand auto_snapshot piggyback", () => {
  it("attaches a snapshot to a click result when auto_snapshot=true", async () => {
    let call = 0;
    const fakeSnap = { url: "https://x", title: "x", interactive: [{ idx: 0, role: "button", name: "Go", selector: "#go" }] };
    const deps = {
      queryActiveTab: vi.fn().mockResolvedValue([{ id: 7, windowId: 1 }]),
      updateTab: vi.fn(),
      executeScript: vi.fn().mockImplementation((opts) => {
        call += 1;
        // 1) pageClickFn → matched=true. 2) pageWaitForDomIdleFn → idle. 3) pageSnapshotFn → fakeSnap.
        if (opts.func === pageWaitForDomIdleFn) return Promise.resolve([{ result: { idle: true, waited_ms: 12 } }]);
        if (opts.func === pageSnapshotFn) return Promise.resolve([{ result: fakeSnap }]);
        return Promise.resolve([{ result: { matched: true, tag: "BUTTON" } }]);
      }),
      captureVisibleTab: vi.fn(),
    };
    const r = await dispatchCommand(deps, { type: "click", selector: "#go", auto_snapshot: true });
    expect(r.ok).toBe(true);
    expect(r.data.matched).toBe(true);
    expect(r.data.snapshot).toBeDefined();
    expect(r.data.snapshot.tab_id).toBe(7);
    expect(r.data.snapshot.interactive[0].name).toBe("Go");
    expect(call).toBe(3);
  });

  it("omits snapshot when auto_snapshot is not set", async () => {
    const deps = {
      queryActiveTab: vi.fn().mockResolvedValue([{ id: 7, windowId: 1 }]),
      updateTab: vi.fn(),
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: true, tag: "BUTTON" } }]),
      captureVisibleTab: vi.fn(),
    };
    const r = await dispatchCommand(deps, { type: "click", selector: "#go" });
    expect(r.ok).toBe(true);
    expect(r.data.snapshot).toBeUndefined();
    expect(deps.executeScript).toHaveBeenCalledTimes(1);
  });

  it("does not fail the action when the snapshot step throws", async () => {
    let call = 0;
    const deps = {
      queryActiveTab: vi.fn().mockResolvedValue([{ id: 7, windowId: 1 }]),
      updateTab: vi.fn(),
      executeScript: vi.fn().mockImplementation((opts) => {
        call += 1;
        if (opts.func === pageWaitForDomIdleFn) return Promise.reject(new Error("MAIN world unavailable"));
        return Promise.resolve([{ result: { matched: true, tag: "BUTTON" } }]);
      }),
      captureVisibleTab: vi.fn(),
    };
    const r = await dispatchCommand(deps, { type: "fill", selector: "input", value: "hi", auto_snapshot: true });
    expect(r.ok).toBe(true);
    expect(r.data.matched).toBe(true);
    expect(r.data.snapshot).toBeUndefined();
    expect(call).toBe(2); // fill + (failing) idle wait
  });
});

describe("pageWaitForDomIdleFn (pure)", () => {
  // Vitest fake timers + a stub MutationObserver let us drive the
  // observer callback deterministically.
  it("resolves with idle=true once quietMs elapses without mutations", async () => {
    vi.useFakeTimers();
    let observerCb = null;
    globalThis.document = { documentElement: {} };
    class FakeObserver {
      constructor(cb) { observerCb = cb; }
      observe() {}
      disconnect() {}
    }
    globalThis.MutationObserver = FakeObserver;
    const promise = pageWaitForDomIdleFn(50, 1000);
    // No mutations triggered — the initial armQuiet timer fires.
    await vi.advanceTimersByTimeAsync(60);
    const r = await promise;
    expect(r.idle).toBe(true);
    expect(observerCb).toBeTypeOf("function");
    vi.useRealTimers();
  });

  it("resolves with idle=false once maxMs elapses while mutations keep firing", async () => {
    vi.useFakeTimers();
    let observerCb = null;
    globalThis.document = { documentElement: {} };
    class FakeObserver {
      constructor(cb) { observerCb = cb; }
      observe() {}
      disconnect() {}
    }
    globalThis.MutationObserver = FakeObserver;
    const promise = pageWaitForDomIdleFn(100, 200);
    // Keep firing mutations every 30ms so the quiet window never closes.
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30);
      observerCb?.([]);
    }
    const r = await promise;
    expect(r.idle).toBe(false);
    vi.useRealTimers();
  });
});

// --------------------------------------------------------------------- //
// ADR-0123 behaviour: live resolution, one-shot recovery, batching,     //
// wait, press, and capture of a non-active target.                      //
// --------------------------------------------------------------------- //

function isFn(func, name) {
  return typeof func === "function" && func.name === name;
}

describe("dispatchCommand — live locator resolution", () => {
  it("resolves role + name through one snapshot, then acts on the ref", async () => {
    const snap = { url: "https://x", interactive: [{ idx: 0, ref: 11, role: "button", name: "Save", selector: "#save" }] };
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation((opts) => {
        if (isFn(opts.func, "pageSnapshotFn")) return Promise.resolve([{ result: snap }]);
        return Promise.resolve([{ result: { matched: true, tag: "BUTTON", via: "ref" } }]);
      }),
    });
    const r = await dispatchCommand(deps, { type: "click", role: "button", name: "Save" });
    expect(r.ok).toBe(true);
    const actCall = deps.executeScript.mock.calls.find(([opts]) => isFn(opts.func, "pageActFn"));
    expect(actCall[0].args[1]).toMatchObject({ ref: 11, role: "button", name: "Save" });
  });

  it("refreshes once and retries when a ref went stale", async () => {
    const snap = { url: "https://x", interactive: [{ idx: 0, ref: 22, role: "button", name: "Save", selector: "#save" }] };
    let actCalls = 0;
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation((opts) => {
        if (isFn(opts.func, "pageSnapshotFn")) return Promise.resolve([{ result: snap }]);
        actCalls += 1;
        if (actCalls === 1) {
          return Promise.resolve([{ result: { matched: false, action: "click", reason: "stale_ref", stale: { role: "button", name: "Save" } } }]);
        }
        return Promise.resolve([{ result: { matched: true, tag: "BUTTON", via: "ref" } }]);
      }),
    });
    const r = await dispatchCommand(deps, { type: "click", ref: 5 });
    expect(r.ok).toBe(true);
    expect(r.data.recovered).toBe(true);
    const calls = deps.executeScript.mock.calls.filter(([opts]) => isFn(opts.func, "pageActFn"));
    expect(calls).toHaveLength(2);
    expect(calls[1][0].args[1]).toMatchObject({ ref: 22 });
  });

  it("reports candidates instead of guessing when a name matches nothing", async () => {
    const snap = { url: "https://x", interactive: [{ idx: 0, ref: 31, role: "button", name: "Cancel", selector: "#cancel" }] };
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation((opts) => {
        if (isFn(opts.func, "pageSnapshotFn")) return Promise.resolve([{ result: snap }]);
        return Promise.resolve([{ result: { matched: false, action: "click", reason: "no_match" } }]);
      }),
    });
    const r = await dispatchCommand(deps, { type: "click", role: "button", name: "Save" });
    expect(r.ok).toBe(false);
    expect(r.data.candidates[0]).toMatchObject({ ref: 31, name: "Cancel" });
  });
});

describe("dispatchCommand — press and wait", () => {
  it("presses a key through the action runtime", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: true, tag: "INPUT", via: "selector" } }]),
    });
    const r = await dispatchCommand(deps, { type: "press", selector: "input", key: "Escape" });
    expect(r.ok).toBe(true);
    const [opts] = deps.executeScript.mock.calls[0];
    expect(opts.args).toEqual(["press", { selector: "input", key: "Escape" }]);
  });

  it("surfaces a wait timeout with the observed duration", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockResolvedValue([{ result: { matched: false, for: "selector", waited_ms: 900, reason: "timeout" } }]),
    });
    const r = await dispatchCommand(deps, { type: "wait", for: "selector", selector: "#never", timeout_ms: 900 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out after 900ms/);
    expect(r.data.waited_ms).toBe(900);
  });
});

describe("dispatchCommand — batch", () => {
  const baseDeps = (responder) => makeDeps({
    executeScript: vi.fn().mockImplementation((opts) => {
      if (isFn(opts.func, "pageWaitForDomIdleFn")) return Promise.resolve([{ result: { idle: true } }]);
      if (isFn(opts.func, "pageSnapshotFn")) return Promise.resolve([{ result: { url: "https://x", interactive: [] } }]);
      return Promise.resolve([{ result: responder(opts) }]);
    }),
  });

  it("runs every step in one command and reports them all", async () => {
    const { deps, calls } = baseDeps(() => ({ matched: true, tag: "BUTTON", via: "ref" }));
    const r = await dispatchCommand(deps, {
      type: "batch",
      steps: [
        { action: "click", ref: 1 },
        { action: "fill", ref: 2, value: "hi" },
        { action: "press", key: "Enter" },
      ],
      auto_snapshot: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.halted_at).toBeNull();
    expect(r.data.steps.map((s) => s.ok)).toEqual([true, true, true]);
    expect(r.data.snapshot).toBeDefined();
    const acts = deps.executeScript.mock.calls.filter(([opts]) => isFn(opts.func, "pageActFn"));
    expect(acts).toHaveLength(3);
  });

  it("halts at the first failure and marks the rest as not executed", async () => {
    const { deps } = baseDeps((opts) => {
      const payload = opts.args[1];
      return payload.ref === 2
        ? { matched: false, action: "fill", reason: "no_match" }
        : { matched: true, tag: "BUTTON", via: "ref" };
    });
    const r = await dispatchCommand(deps, {
      type: "batch",
      steps: [
        { action: "click", ref: 1 },
        { action: "fill", ref: 2, value: "hi" },
        { action: "click", ref: 3 },
      ],
      auto_snapshot: true,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/step 1 \(fill\)/);
    expect(r.data.halted_at).toBe(1);
    expect(r.data.steps[2]).toMatchObject({ ok: false, skipped: true, error: "Not executed: an earlier action in this step list failed." });
  });

  it("fails the step whose expectation was not met", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation((opts) => {
        if (isFn(opts.func, "pageWaitForDomIdleFn")) return Promise.resolve([{ result: { idle: true } }]);
        if (isFn(opts.func, "pageSnapshotFn")) return Promise.resolve([{ result: { url: "https://x", interactive: [] } }]);
        if (isFn(opts.func, "pageWaitFn")) return Promise.resolve([{ result: { matched: false, for: "text", waited_ms: 400 } }]);
        return Promise.resolve([{ result: { matched: true, tag: "BUTTON", via: "ref" } }]);
      }),
    });
    const r = await dispatchCommand(deps, {
      type: "batch",
      steps: [{ action: "click", ref: 1, expect: { text: "Saved", timeout_ms: 400 } }],
      auto_snapshot: true,
    });
    expect(r.ok).toBe(false);
    expect(r.data.steps[0].error).toBe("expectation not met");
    expect(r.data.steps[0].waited_ms).toBe(400);
  });
});

describe("dispatchCommand — capture of a non-active target", () => {
  it("activates the target for capture and restores the previous tab", async () => {
    const { deps } = makeDeps({
      resolveTargetTab: vi.fn().mockResolvedValue({
        tab: { id: 9, windowId: 1, active: false, url: "https://example.com" },
        source: "pinned",
      }),
      queryTabs: vi.fn().mockResolvedValue([{ id: 7, windowId: 1, active: true }]),
    });
    const r = await dispatchCommand(deps, { type: "screenshot", format: "png" });
    expect(r.ok).toBe(true);
    expect(deps.activateTab).toHaveBeenNthCalledWith(1, 9);
    expect(deps.activateTab).toHaveBeenNthCalledWith(2, 7);
    expect(r.data.activated_for_capture).toBe(true);
    expect(deps.captureVisibleTab).toHaveBeenCalledWith(1, { format: "png" });
  });

  it("does not activate anything when the target is already active", async () => {
    const { deps } = makeDeps({
      resolveTargetTab: vi.fn().mockResolvedValue({ tab: { id: 9, windowId: 1, active: true, url: "https://example.com" } }),
    });
    const r = await dispatchCommand(deps, { type: "screenshot", format: "png" });
    expect(r.ok).toBe(true);
    expect(deps.activateTab).not.toHaveBeenCalled();
    expect(r.data.activated_for_capture).toBe(false);
  });
});

describe("pageSnapshotFn — tree and text", () => {
  it("returns an indented tree with refs and a text excerpt", () => {
    const button = makeFakeElement({ tagName: "BUTTON", textContent: "Sign in", innerText: "Sign in", getAttribute: () => null, children: [], isConnected: true });
    const heading = makeFakeElement({ tagName: "H1", textContent: "Welcome", innerText: "Welcome", getAttribute: () => null, children: [] });
    const body = {
      nodeType: 1,
      tagName: "BODY",
      hidden: false,
      innerText: "Welcome\nSign in",
      children: [heading, button],
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    };
    globalThis.location = { href: "https://example.com/login" };
    globalThis.window = {
      innerWidth: 1000,
      innerHeight: 800,
      scrollY: 0,
      getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    };
    globalThis.document = {
      title: "Login",
      body,
      documentElement: { scrollHeight: 900 },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector) => (selector.includes("button") ? [button] : []),
    };
    const snap = pageSnapshotFn({ filter: "text", max_chars: 200 });
    expect(snap.text).toContain("Welcome");
    const roles = snap.tree.map((node) => node.role);
    expect(roles).toContain("h1");
    expect(roles).toContain("button");
    const refs = snap.tree.filter((node) => typeof node.ref === "number");
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe("Sign in");
  });

  it("keeps a ref stable across repeated snapshots", () => {
    const button = makeFakeElement({ tagName: "BUTTON", textContent: "Go", innerText: "Go", getAttribute: () => null, children: [], isConnected: true });
    const body = { nodeType: 1, tagName: "BODY", hidden: false, innerText: "Go", children: [button], getAttribute: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }) };
    globalThis.location = { href: "https://example.com" };
    globalThis.window = { innerWidth: 800, innerHeight: 600, scrollY: 0, getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }) };
    globalThis.document = {
      title: "x",
      body,
      documentElement: { scrollHeight: 600 },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (selector) => (selector.includes("button") ? [button] : []),
    };
    const first = pageSnapshotFn({});
    const second = pageSnapshotFn({});
    expect(first.interactive[0].ref).toBe(second.interactive[0].ref);
  });
});

describe("round-trip budget", () => {
  it("collapses a five-step login flow into one command", async () => {
    const { deps } = makeDeps({
      executeScript: vi.fn().mockImplementation((opts) => {
        if (isFn(opts.func, "pageWaitForDomIdleFn")) return Promise.resolve([{ result: { idle: true } }]);
        if (isFn(opts.func, "pageSnapshotFn")) return Promise.resolve([{ result: { url: "https://x", tab_id: 7, interactive: [] } }]);
        if (isFn(opts.func, "pageWaitFn")) return Promise.resolve([{ result: { matched: true, waited_ms: 40 } }]);
        return Promise.resolve([{ result: { matched: true, tag: "INPUT", via: "ref" } }]);
      }),
    });
    // The same flow used to be five separate tool calls, each costing a
    // model turn plus a poll/result cycle.
    const r = await dispatchCommand(deps, {
      type: "batch",
      steps: [
        { action: "fill", ref: 1, value: "user@example.com" },
        { action: "fill", ref: 2, value: "hunter2" },
        { action: "press", ref: 3, key: "Enter" },
        { action: "wait", for: "url", url: "/dashboard" },
        { action: "click", ref: 4, expect: { selector: "#welcome" } },
      ],
      auto_snapshot: true,
    });
    expect(r.ok).toBe(true);
    expect(r.data.halted_at).toBeNull();
    // Four page actions, one snapshot settle, one final snapshot.
    const actions = deps.executeScript.mock.calls.filter(([opts]) => isFn(opts.func, "pageActFn"));
    expect(actions).toHaveLength(4);
    expect(r.data.snapshot.tab_id).toBe(7);
  });
});
