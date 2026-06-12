// Browser-control executor. The Jarela service worker long-polls
// `/api/v1/extension/browser/poll` and routes the returned command
// through this dispatcher; the outcome is POSTed back to
// `/api/v1/extension/browser/result`. See lib/api/browser-control.ts
// for the matching server side.
//
// All chrome.* surface is wrapped in injectable dependencies so the
// pure dispatch logic is testable from Node/vitest.

const DEFAULT_TIMEOUT_MS = 30_000;

// --------------------------------------------------------------------- //
// In-page payloads — serialized into chrome.scripting.executeScript args.
// --------------------------------------------------------------------- //

// Click the first element matching `selector`. Real click via .click() so
// the page's onclick handlers fire. Returns matched=false (not an error)
// when nothing matches — the agent can branch on that.
export function pageClickFn(selector) {
  const el = document.querySelector(selector);
  if (!el) return { matched: false };
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  }
  // dispatchEvent + .click() to cover both native buttons and custom
  // handlers wired via addEventListener.
  el.click();
  return { matched: true, tag: el.tagName };
}

// Fill an input/textarea/contenteditable. Dispatches input + change so
// React / Vue controlled components observe the new value.
export function pageFillFn(selector, value, submit) {
  const el = document.querySelector(selector);
  if (!el) return { matched: false };
  el.focus();
  if (el.isContentEditable) {
    el.textContent = value;
  } else if ("value" in el) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  } else {
    return { matched: false, reason: "element has no value property" };
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    const form = el.form ?? el.closest?.("form") ?? null;
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
    } else if (form && typeof form.submit === "function") {
      form.submit();
    } else {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }),
      );
    }
  }
  return { matched: true, tag: el.tagName };
}

export function pageScrollFn(selector, to) {
  if (to === "top") {
    window.scrollTo({ top: 0, behavior: "instant" });
    return { scrolled: "top" };
  }
  if (to === "bottom") {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });
    return { scrolled: "bottom" };
  }
  // into-view
  if (!selector) return { matched: false, reason: "selector required for to=into-view" };
  const el = document.querySelector(selector);
  if (!el) return { matched: false };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  return { matched: true, scrolled: "into-view" };
}

export function pageExtractFn(selector, format, maxChars) {
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) return { matched: false };
  let raw = "";
  if (format === "html") raw = el.innerHTML ?? "";
  else if (format === "outerHTML") raw = el.outerHTML ?? "";
  else raw = (el.innerText ?? el.textContent ?? "").trim();
  const cap = typeof maxChars === "number" && maxChars > 0 ? maxChars : 100_000;
  const truncated = raw.length > cap;
  return {
    matched: true,
    format,
    content: truncated ? raw.slice(0, cap) : raw,
    truncated,
    original_length: raw.length,
  };
}

export function pageWaitForSelectorFn(selector, timeoutMs) {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) {
      resolve({ found: true });
      return;
    }
    const start = Date.now();
    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve({ found: true });
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve({ found: false, waited_ms: Date.now() - start });
    }, timeoutMs);
  });
}

// --------------------------------------------------------------------- //
// Element-bounds capture for screenshot cropping.                       //
// chrome.tabs.captureVisibleTab can only grab the visible viewport, so  //
// we scroll the target into view first and report device-pixel-aware    //
// bounds back to the SW which then crops via OffscreenCanvas.           //
// --------------------------------------------------------------------- //

export function pageElementBoundsFn(selector) {
  const el = document.querySelector(selector);
  if (!el) return { matched: false };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  const rect = el.getBoundingClientRect();
  return {
    matched: true,
    dpr: window.devicePixelRatio || 1,
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    viewport_width: window.innerWidth,
    viewport_height: window.innerHeight,
  };
}

// --------------------------------------------------------------------- //
// Dispatcher                                                            //
// --------------------------------------------------------------------- //

/**
 * @typedef {Object} ChromeDeps
 * @property {(opts: { active: boolean, currentWindow: boolean }) => Promise<any[]>} queryActiveTab
 * @property {(opts: { tabId: number, url: string }) => Promise<any>} updateTab
 * @property {(opts: { target: { tabId: number }, func: Function, args?: any[] }) => Promise<any[]>} executeScript
 * @property {(opts: { tabId: number }, fn: () => void) => Promise<void>} [onTabComplete]
 * @property {(opts: { windowId?: number, format?: string }) => Promise<string>} captureVisibleTab
 * @property {() => Promise<{tab: any, source: string} | {tab: null, source: "none", reason: string}>} [resolveTargetTab]
 */

async function pickActiveTab(deps) {
  // Prefer the smarter resolver when the SW injected one (handles tab
  // pinning + last-focused-window fallback). Fall back to the old
  // active+currentWindow query for back-compat with unit tests that
  // don't construct a resolveTargetTab.
  if (typeof deps.resolveTargetTab === "function") {
    const r = await deps.resolveTargetTab();
    if (r?.tab?.id) return r.tab;
    return null;
  }
  const tabs = await deps.queryActiveTab({ active: true, currentWindow: true });
  const tab = tabs?.[0];
  if (!tab?.id) return null;
  return tab;
}

async function execInTab(deps, tabId, func, args = []) {
  const out = await deps.executeScript({ target: { tabId }, func, args });
  return out?.[0]?.result;
}

async function execInTabAsync(deps, tabId, func, args = []) {
  const out = await deps.executeScript({
    target: { tabId },
    func,
    args,
    world: "MAIN",
  });
  return out?.[0]?.result;
}

async function waitForTabComplete(deps, tabId, timeoutMs) {
  if (!deps.onTabComplete) return;
  await deps.onTabComplete({ tabId }, () => {});
  // Caller helper actually awaits an event-based promise — see service
  // worker implementation. Here we keep the dependency interface tiny
  // and let the SW supply the real waiter.
  void timeoutMs;
}

/**
 * Run a command against the active tab via the supplied chrome.* deps.
 * Returns `{ ok, data }` on success or `{ ok: false, error }` on failure.
 */
export async function dispatchCommand(deps, command) {
  if (!command || typeof command !== "object") {
    return { ok: false, error: "invalid command" };
  }
  const timeout = command.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  // Surface a precise reason from the resolver when available — e.g.
  // "pinned tab navigated to chrome://settings/" tells the user exactly
  // what went wrong without them having to inspect the popup.
  let resolutionReason = "no active tab — open an http/https page and retry";
  let tab = null;
  if (typeof deps.resolveTargetTab === "function") {
    const r = await deps.resolveTargetTab();
    if (r?.tab?.id) {
      tab = r.tab;
    } else if (r?.reason) {
      resolutionReason = r.reason;
    }
  } else {
    tab = await pickActiveTab(deps);
  }
  if (!tab) {
    return { ok: false, error: resolutionReason };
  }

  try {
    switch (command.type) {
      case "navigate": {
        await deps.updateTab({ tabId: tab.id, url: command.url });
        if (deps.waitTabLoaded) {
          await deps.waitTabLoaded(tab.id, timeout);
        }
        if (command.wait_for_selector) {
          const found = await execInTabAsync(deps, tab.id, pageWaitForSelectorFn, [
            command.wait_for_selector,
            Math.min(timeout, 15_000),
          ]);
          if (!found?.found) {
            return { ok: false, error: `wait_for_selector \`${command.wait_for_selector}\` not found within ${timeout}ms` };
          }
        }
        return { ok: true, data: { tab_id: tab.id, url: command.url } };
      }
      case "click": {
        const result = await execInTab(deps, tab.id, pageClickFn, [command.selector]);
        if (!result?.matched) {
          return { ok: false, error: `no element matched selector \`${command.selector}\`` };
        }
        return { ok: true, data: result };
      }
      case "fill": {
        const result = await execInTab(deps, tab.id, pageFillFn, [
          command.selector,
          command.value,
          Boolean(command.submit),
        ]);
        if (!result?.matched) {
          return { ok: false, error: `no fillable element matched selector \`${command.selector}\`` };
        }
        return { ok: true, data: result };
      }
      case "scroll": {
        const result = await execInTab(deps, tab.id, pageScrollFn, [command.selector ?? null, command.to]);
        if (result?.matched === false && command.to === "into-view") {
          return { ok: false, error: `no element matched selector \`${command.selector ?? ""}\`` };
        }
        return { ok: true, data: result };
      }
      case "extract": {
        const result = await execInTab(deps, tab.id, pageExtractFn, [
          command.selector ?? null,
          command.format ?? "text",
          command.max_chars ?? null,
        ]);
        if (!result?.matched) {
          return { ok: false, error: `no element matched selector \`${command.selector ?? ""}\`` };
        }
        return { ok: true, data: result };
      }
      case "screenshot": {
        // 1. If selector supplied, read element bounds to crop later.
        let bounds = null;
        if (command.selector) {
          bounds = await execInTab(deps, tab.id, pageElementBoundsFn, [command.selector]);
          if (!bounds?.matched) {
            return { ok: false, error: `no element matched selector \`${command.selector}\`` };
          }
        }
        // 2. Capture the visible viewport.
        const format = command.format === "jpeg" ? "jpeg" : "png";
        const dataUrl = await deps.captureVisibleTab(tab.windowId ?? undefined, { format });
        const commaIdx = dataUrl.indexOf(",");
        const base64Full = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        // 3. Crop only when the agent asked for an element-scoped shot.
        let base64 = base64Full;
        let cropped = false;
        if (bounds && deps.cropPngBase64) {
          try {
            base64 = await deps.cropPngBase64(base64Full, bounds, format);
            cropped = true;
          } catch (err) {
            // Fall back to the full viewport rather than failing — the
            // agent still gets a useful screenshot, just uncropped.
            cropped = false;
            base64 = base64Full;
            void err;
          }
        }
        return {
          ok: true,
          data: {
            base64,
            media_type: format === "jpeg" ? "image/jpeg" : "image/png",
            cropped,
            full_page: Boolean(command.full_page),
          },
        };
      }
      default:
        return { ok: false, error: `unknown command type \`${command.type}\`` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
