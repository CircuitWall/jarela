// Guard for a failure mode that unit tests hide by construction.
//
// Every function handed to `chrome.scripting.executeScript` is serialized
// with `Function.toString()` and re-evaluated inside the page, so it cannot
// see this module's scope. Importing the module and calling the function
// in-process therefore proves nothing: the closure is still intact.
//
// That gap shipped once. `pageSnapshotFn` called a module-level
// `hashSnapshot`, so inside the page it threw `ReferenceError`, and Chrome
// resolved the injection with `result: undefined`. The command still
// reported success, the tool returned `{ ok: true, data: null }`, and the
// whole structural path (snapshot, role/name locators, refs) was dead.
//
// So: run each injected function the way the browser does — in a bare
// context with only page globals — and fail if it throws or returns nothing.
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import * as browserControl from "./browser-control.mjs";

const INJECTED = [
  "pageActFn",
  "pageSnapshotFn",
  "pageBoundsForTargetFn",
  "pageElementBoundsFn",
  "pageExtractFn",
  "pageScrollFn",
  "pageWaitFn",
  "pageWaitForSelectorFn",
  "pageWaitForDomIdleFn",
];

// Module-scope names that must never appear inside an injected function.
const MODULE_ONLY_TOKENS = [
  "NODE_REGISTRY_KEY",
  "NODE_REF_COUNTER_KEY",
  "NODE_REF_BY_NODE_KEY",
  "REGISTRY_MAX_ENTRIES",
  "ACTIONABLE_SELECTOR",
];

function fakeElement(extra = {}) {
  return {
    nodeType: 1,
    tagName: "BUTTON",
    hidden: false,
    isConnected: true,
    children: [],
    options: [],
    innerText: "Go",
    textContent: "Go",
    value: "",
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    scrollIntoView() {},
    focus() {},
    click() {},
    dispatchEvent: () => true,
    ...extra,
  };
}

function pageSandbox() {
  const node = fakeElement();
  const body = fakeElement({ tagName: "BODY", children: [node], innerText: "Go" });
  const document = {
    title: "Example",
    body,
    documentElement: { scrollHeight: 600 },
    activeElement: node,
    querySelector: () => node,
    querySelectorAll: () => [node],
    getElementById: () => null,
  };
  const window = {
    innerWidth: 800,
    innerHeight: 600,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
    scrollTo() {},
  };
  return {
    document,
    window,
    location: { href: "https://example.com" },
    globalThis: {},
    setTimeout,
    setInterval,
    clearInterval,
    clearTimeout,
    MutationObserver: class { observe() {} disconnect() {} },
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    MouseEvent: class { constructor(type) { this.type = type; } },
  };
}

const CALLS = {
  pageActFn: ["click", { selector: "button" }],
  pageSnapshotFn: [{ max_items: 5 }],
  pageBoundsForTargetFn: [{ selector: "button" }],
  pageElementBoundsFn: ["button"],
  pageExtractFn: [null, "text", 200],
  pageScrollFn: [null, "top"],
  pageWaitFn: [{ for: "time", timeout_ms: 60 }],
  pageWaitForSelectorFn: ["button", 50],
  pageWaitForDomIdleFn: [20, 60],
};

describe("injected page functions", () => {
  it("covers every function the dispatcher injects", () => {
    // If a page function is added, add it here — the whole point is that a
    // new one cannot quietly depend on module scope.
    for (const name of INJECTED) {
      expect(typeof browserControl[name], name).toBe("function");
    }
  });

  for (const name of INJECTED) {
    it(`${name} runs without the module closure`, async () => {
      const source = browserControl[name].toString();
      for (const token of MODULE_ONLY_TOKENS) {
        expect(source.includes(token), `${name} references module scope: ${token}`).toBe(false);
      }
      const sandbox = pageSandbox();
      const fn = vm.runInNewContext(`(${source})`, sandbox);
      const result = await fn(...CALLS[name]);
      expect(result, `${name} returned nothing — the page would report a silent no-op`).not.toBeUndefined();
    });
  }
});
