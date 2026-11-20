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

// Page-side node registry (ADR-0123 D1).
//
// `pageSnapshotFn` registers every actionable node and returns a durable
// `ref`. Commands then act on that ref, so a re-render between observation
// and action cannot invalidate the target the way a shipped CSS string
// could. The registry lives on the page's `globalThis`, which means it dies
// with the document — a ref from a previous page is never silently reused
// against a new one.
//
// IMPORTANT — every function in this file that is handed to
// `chrome.scripting.executeScript` is serialized with `Function.toString()`
// and re-evaluated inside the page. It therefore cannot see *any* binding
// from this module: not these constants, not a helper declared below, not an
// imported type. A reference to module scope throws
// `ReferenceError: <name> is not defined` inside the page, and Chrome then
// resolves the injection with `result: undefined` — which looks like a
// successful no-op to the caller. Duplicate the values locally (they are
// covered by `injection.test.mjs`, which runs each injected function in a
// bare context) instead of referencing the module constants below.
const NODE_REGISTRY_KEY = "__jarelaAgentNodes";
const NODE_REF_COUNTER_KEY = "__jarelaAgentNextRef";
const NODE_REF_BY_NODE_KEY = "__jarelaAgentRefByNode";
const REGISTRY_MAX_ENTRIES = 4000;

export const ACTIONABLE_SELECTOR =
  "a[href], button, select, textarea, input:not([type=hidden]), [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [role=switch], [role=combobox], [role=listbox], [contenteditable=true]";

// Click / fill / fill_many / press / scroll-into-view in one page payload.
//
// `payload` carries a locator (`ref`, `selector`, or both) plus the action
// input. Resolution order is ref → selector: a ref is the identity the
// snapshot handed out, and a selector is the escape hatch. Anything the page
// cannot resolve is reported as data (`reason`) instead of thrown, so the
// dispatcher can refresh once and retry instead of failing the agent turn.
export function pageActFn(action, payload) {
  // Local copy: this function is injected, so it cannot see module scope.
  const REGISTRY_KEY = "__jarelaAgentNodes";
  const p = payload && typeof payload === "object" ? payload : {};
  const registry = globalThis[REGISTRY_KEY];
  const report = (fields) => ({ matched: false, action, ...fields });

  function lookupRef(ref) {
    if (typeof ref !== "number" || !registry || typeof registry.get !== "function") return null;
    const entry = registry.get(ref);
    if (!entry) return { stale: true };
    const node = entry.node ?? entry;
    if (node.isConnected !== true) {
      try { registry.delete(ref); } catch { /* best-effort */ }
      // Report what the ref used to be so the dispatcher can re-resolve by
      // accessible name instead of failing the turn.
      return {
        stale: true,
        previous: entry.role || entry.name ? { role: entry.role, name: entry.name } : null,
      };
    }
    return { el: node };
  }

  function resolve() {
    if (typeof p.ref === "number") {
      const hit = lookupRef(p.ref);
      if (hit?.el) return { el: hit.el, via: "ref" };
      if (hit?.stale && !p.selector) return { stale: true, previous: hit.previous };
    }
    if (typeof p.selector === "string" && p.selector) {
      const el = document.querySelector(p.selector);
      return el ? { el, via: "selector" } : { miss: true };
    }
    return { needsSnapshot: true };
  }

  function pointerSequence(el) {
    const Ctor = typeof PointerEvent === "function" ? PointerEvent : typeof MouseEvent === "function" ? MouseEvent : null;
    if (!Ctor) return;
    const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
    const base = rect
      ? { clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + rect.height / 2) }
      : {};
    for (const type of ["pointerover", "pointerdown", "mousedown", "pointerup", "mouseup"]) {
      try {
        el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...base }));
      } catch { /* constructor differences are not fatal */ }
    }
  }

  // Whether another element paints over the target. Frameworks still often
  // accept the synthetic click, so this is a hint for the caller, not a
  // refusal.
  function isCovered(el) {
    try {
      const rect = el.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return false;
      const top = document.elementFromPoint(
        Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1),
        Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1),
      );
      if (!top || top === el) return false;
      return !el.contains(top) && !top.contains(el);
    } catch {
      return false;
    }
  }

  function setValue(el, value) {
    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const want = String(value ?? "");
      const options = Array.from(el.options || []);
      const option =
        options.find((o) => o.value === want) ||
        options.find((o) => (o.textContent || "").trim().toLowerCase() === want.trim().toLowerCase()) ||
        options.find((o) => (o.textContent || "").toLowerCase().includes(want.toLowerCase()));
      if (!option) {
        return { matched: false, reason: "option_not_found", options: options.slice(0, 12).map((o) => ({ value: o.value, label: (o.textContent || "").trim() })) };
      }
      el.value = option.value;
    } else if (el.isContentEditable) {
      el.textContent = String(value ?? "");
    } else if ("value" in el) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, String(value ?? ""));
      else el.value = String(value ?? "");
    } else {
      return { matched: false, reason: "not_fillable" };
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { matched: true };
  }

  function submitForm(el) {
    const form = el.form ?? el.closest?.("form") ?? null;
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    else if (form && typeof form.submit === "function") form.submit();
    else dispatchKey(el, "Enter");
  }

  function dispatchKey(el, key) {
    const parts = String(key || "").split("+");
    const combo = parts.length > 1;
    const primary = (combo ? parts[parts.length - 1] : parts[0]) || "Enter";
    const init = {
      key: primary,
      code: primary.length === 1 ? `Key${primary.toUpperCase()}` : primary,
      bubbles: true,
      cancelable: true,
      altKey: parts.includes("Alt"),
      ctrlKey: parts.includes("Control") || parts.includes("Ctrl"),
      metaKey: parts.includes("Meta"),
      shiftKey: parts.includes("Shift"),
    };
    const target = el || document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (primary.length === 1) target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return { matched: true };
  }

  if (action === "fill_many") {
    const fields = Array.isArray(p.fields) ? p.fields : [];
    const results = [];
    for (const field of fields) {
      const one = pageActFn("fill", field);
      results.push({ ...one, value_selector: field?.selector ?? null, value_ref: field?.ref ?? null });
    }
    let submit = null;
    if (typeof p.submit_ref === "number" || typeof p.submit_selector === "string") {
      submit = pageActFn("click", { ref: p.submit_ref, selector: p.submit_selector });
    }
    const matched = results.filter((r) => r.matched).length;
    return {
      matched: matched === results.length && results.length > 0,
      matched_count: matched,
      total: results.length,
      fields: results,
      ...(submit ? { submit } : {}),
      ...(matched === results.length ? {} : { reason: "field_miss" }),
    };
  }

  if (action === "press" && typeof p.ref !== "number" && !p.selector) {
    // With no locator the key goes to whatever is focused — that is how a
    // modal, a menu, or a combobox is dismissed.
    const focused = document.activeElement || document.body;
    if (!focused) return report({ reason: "no_focus_target" });
    return { ...dispatchKey(focused, p.key), action, via: "focus" };
  }

  const target = resolve();
  if (target.stale) return report({ reason: "stale_ref", ...(target.previous ? { stale: target.previous } : {}) });
  if (target.needsSnapshot) return report({ reason: "needs_snapshot" });
  if (!target.el) return report({ reason: "no_match" });
  const el = target.el;
  const via = target.via;

  if (action === "click") {
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "instant" });
    const covered = isCovered(el);
    pointerSequence(el);
    el.click();
    return { matched: true, action, tag: el.tagName, via, covered };
  }

  if (action === "fill") {
    el.focus?.();
    const set = setValue(el, p.value);
    if (!set.matched) return report({ reason: set.reason, via, tag: el.tagName, ...(set.options ? { options: set.options } : {}) });
    if (p.submit) submitForm(el);
    return { matched: true, action, tag: el.tagName, via };
  }

  if (action === "press") {
    el.focus?.();
    return { ...dispatchKey(el, p.key), action, tag: el.tagName, via };
  }

  if (action === "scroll") {
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center", behavior: "instant" });
    return { matched: true, action, tag: el.tagName, via, scrolled: "into-view" };
  }

  return report({ reason: `unknown_action:${action}` });
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

export function pageExtractFn(selector, format, maxChars, offset) {
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) return { matched: false };
  let raw = "";
  if (format === "html") raw = el.innerHTML ?? "";
  else if (format === "outerHTML") raw = el.outerHTML ?? "";
  else raw = (el.innerText ?? el.textContent ?? "").trim();
  const cap = typeof maxChars === "number" && maxChars > 0 ? maxChars : 100_000;
  const start = typeof offset === "number" && offset > 0 ? Math.min(offset, raw.length) : 0;
  const end = Math.min(raw.length, start + cap);
  const truncated = end < raw.length;
  return {
    matched: true,
    format,
    content: raw.slice(start, end),
    truncated,
    original_length: raw.length,
    offset: start,
    next_offset: truncated ? end : null,
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

// Resolve when the DOM has been quiet (no mutations) for `quietMs` or
// when `maxMs` elapses, whichever comes first. Used by the auto-snapshot
// hook so a snapshot taken right after a click/fill captures the
// committed state of the page rather than mid-render.
export function pageWaitForDomIdleFn(quietMs, maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    let observer = null;
    let quietTimer = null;
    let settled = false;
    function finish(idle) {
      if (settled) return;
      settled = true;
      try { if (observer) observer.disconnect(); } catch { /* noop */ }
      if (quietTimer) clearTimeout(quietTimer);
      resolve({ idle, waited_ms: Date.now() - start });
    }
    function armQuiet() {
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    }
    observer = new MutationObserver(() => {
      if (Date.now() - start >= maxMs) finish(false);
      else armQuiet();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    setTimeout(() => finish(false), maxMs);
    armQuiet();
  });
}

// Poll for a page condition. Used by `wait` commands and by batch
// expectations so an action that triggers a request or a render can be
// followed by "and now the list is there" in the same command instead of a
// blind retry from the model.
//
// `idle` means "the DOM stopped changing for quiet_ms and the document is
// complete" — the page exposes no reliable network signal from here, so the
// name promises exactly what it checks.
export function pageWaitFn(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const kind = o.for || "selector";
  const budgetMs = Math.max(50, Math.min(Number(o.timeout_ms) || 10_000, 60_000));
  const quietMs = Math.max(50, Math.min(Number(o.quiet_ms) || 500, 10_000));
  const start = Date.now();

  function bodyText() {
    const body = document.body;
    return String((body && (body.innerText || body.textContent)) || "");
  }
  function conditionMet() {
    if (kind === "selector") return Boolean(o.selector) && Boolean(document.querySelector(o.selector));
    if (kind === "text") {
      if (!o.text) return false;
      return bodyText().toLowerCase().includes(String(o.text).toLowerCase());
    }
    if (kind === "url") {
      if (!o.url) return false;
      return location.href.toLowerCase().includes(String(o.url).toLowerCase());
    }
    if (kind === "idle") return document.readyState === "complete" && Date.now() - start >= quietMs;
    if (kind === "time") return Date.now() - start >= budgetMs;
    return false;
  }

  return new Promise((resolve) => {
    if (conditionMet()) {
      resolve({ matched: true, for: kind, waited_ms: Date.now() - start });
      return;
    }
    const timer = setInterval(() => {
      const elapsed = Date.now() - start;
      if (conditionMet() || elapsed >= budgetMs) {
        clearInterval(timer);
        resolve({
          matched: conditionMet(),
          for: kind,
          waited_ms: elapsed,
          ...(conditionMet() ? {} : { reason: "timeout" }),
        });
      }
    }, 100);
  });
}

// --------------------------------------------------------------------- //
// Element-bounds capture for screenshot cropping.                       //
// chrome.tabs.captureVisibleTab can only grab the visible viewport, so  //
// we scroll the target into view first and report device-pixel-aware    //
// bounds back to the SW which then crops via OffscreenCanvas.           //
// --------------------------------------------------------------------- //

export function pageBoundsForTargetFn(locator) {
  // Local copy: this function is injected, so it cannot see module scope.
  const REGISTRY_KEY = "__jarelaAgentNodes";
  const p = locator && typeof locator === "object" ? locator : {};
  const registry = globalThis[REGISTRY_KEY];
  let el = null;
  if (typeof p.ref === "number" && registry && typeof registry.get === "function") {
    const entry = registry.get(p.ref);
    const node = entry?.node ?? entry;
    if (node && node.isConnected === true) el = node;
  }
  if (!el && p.selector) el = document.querySelector(p.selector);
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
// Page snapshot — gives the agent a compact, structured view of the     //
// page so it can decide what to click/fill WITHOUT a screenshot +       //
// vision round-trip on every step. Most navigation steps don't need     //
// pixels; they need "what interactive controls exist and what are       //
// they labelled". The shape is roughly:                                 //
//   { url, title, viewport, headings, landmarks, interactive: [        //
//     { idx, role, name, selector, value?, href?, disabled?, ... }     //
//   ] }                                                                //
// The selector is a short, stable CSS path that browser_click /         //
// browser_fill can consume directly.                                    //
// --------------------------------------------------------------------- //

export function pageSnapshotFn(opts) {
  // Locals: this function is injected, so it cannot see module scope.
  const REGISTRY_KEY = "__jarelaAgentNodes";
  const COUNTER_KEY = "__jarelaAgentNextRef";
  const REF_BY_NODE_KEY = "__jarelaAgentRefByNode";
  const MAX_ENTRIES = 4000;
  const ACTIONABLE =
    "a[href], button, select, textarea, input:not([type=hidden]), [role=button], [role=link], [role=checkbox], [role=radio], [role=menuitem], [role=tab], [role=switch], [role=combobox], [role=listbox], [contenteditable=true]";

  const maxItems = (opts && opts.max_items) || 80;
  const includeHidden = !!(opts && opts.include_hidden);
  const filter = (opts && opts.filter) || "interactive";
  const maxDepth = (opts && opts.depth) || 15;
  const maxChars = (opts && opts.max_chars) || 20_000;

  // The registry is created by this function and consumed by pageActFn.
  // `ref` ids are durable for the life of the document: a later command can
  // act on one without re-discovering the page, and a ref from a previous
  // document simply is not in the map.
  const registry = (() => {
    const g = globalThis;
    if (!(g[REGISTRY_KEY] instanceof Map)) g[REGISTRY_KEY] = new Map();
    return g[REGISTRY_KEY];
  })();
  const refByNode = (() => {
    const g = globalThis;
    if (!(g[REF_BY_NODE_KEY] instanceof WeakMap)) g[REF_BY_NODE_KEY] = new WeakMap();
    return g[REF_BY_NODE_KEY];
  })();
  // A ref is durable for the life of a node, not for the life of one
  // snapshot: re-registering a node that is still connected returns the ref
  // it already has, so an agent holding a ref across several snapshots keeps
  // acting on the same element.
  function refFor(el, meta) {
    const known = refByNode.get(el);
    if (typeof known === "number" && registry.has(known)) {
      if (meta) registry.set(known, meta);
      return known;
    }
    const next = Number(globalThis[COUNTER_KEY] || 1);
    globalThis[COUNTER_KEY] = next + 1;
    if (registry.size >= MAX_ENTRIES) registry.clear();
    registry.set(next, meta ?? { node: el });
    refByNode.set(el, next);
    return next;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
    return true;
  }

  function trim(s, n) {
    if (!s) return "";
    const t = String(s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  // Best-effort accessible name. Mirrors ARIA's name-calc lite: prefers
  // aria-label, then labelledby, then the linked <label>, then text
  // content / placeholder / alt / title.
  function accessibleName(el) {
    const al = el.getAttribute("aria-label");
    if (al) return trim(al, 120);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (parts.trim()) return trim(parts, 120);
    }
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl?.textContent) return trim(lbl.textContent, 120);
    }
    const parentLabel = el.closest && el.closest("label");
    if (parentLabel?.textContent) return trim(parentLabel.textContent, 120);
    if (el.placeholder) return trim(el.placeholder, 120);
    if (el.alt) return trim(el.alt, 120);
    if (el.title) return trim(el.title, 120);
    if (el.value && (el.tagName === "BUTTON" || el.tagName === "INPUT")) return trim(el.value, 120);
    return trim(el.innerText ?? el.textContent ?? "", 120);
  }

  // Tag + role classification. We intentionally collapse the long list
  // of ARIA roles into a small vocabulary the LLM can reason about.
  function classify(el) {
    if (!el || typeof el.tagName !== "string") return null;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (tag === "a" && el.href) return "link";
    if (tag === "button" || role === "button") return "button";
    if (tag === "select" || role === "combobox" || role === "listbox") return "select";
    if (tag === "textarea") return "textarea";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button") return "button";
      if (t === "hidden") return null;
      return "textbox";
    }
    if (role === "link") return "link";
    if (role === "checkbox") return "checkbox";
    if (role === "radio") return "radio";
    if (role === "menuitem") return "menuitem";
    if (role === "tab") return "tab";
    if (role === "switch") return "switch";
    return null;
  }

  // Build a short stable selector. Preference order: #id (escaped),
  // [data-testid], [name=], aria-label, then nth-of-type fallback.
  // We aim for selectors short enough for the LLM to copy without
  // mangling and unique enough to survive small DOM churn.
  function buildSelector(el) {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    if (el.id) return `[id="${cssEscape(el.id)}"]`;
    const testid = el.getAttribute("data-testid");
    if (testid) return `[data-testid="${cssEscape(testid)}"]`;
    const name = el.getAttribute("name");
    if (name) return `${el.tagName.toLowerCase()}[name="${cssEscape(name)}"]`;
    const al = el.getAttribute("aria-label");
    if (al && al.length <= 60) return `${el.tagName.toLowerCase()}[aria-label="${cssEscape(al)}"]`;
    // Fallback: tag + nth-of-type within parent.
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    let i = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) i += 1;
      sib = sib.previousElementSibling;
    }
    const parentSel = parent.id && /^[A-Za-z][\w-]*$/.test(parent.id) ? `#${parent.id} > ` : "";
    return `${parentSel}${el.tagName.toLowerCase()}:nth-of-type(${i})`;
  }

  // CSS.escape exists in all modern browsers; trivial polyfill for safety.
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
  }

  const headings = [];
  document.querySelectorAll("h1, h2, h3").forEach((h) => {
    if (headings.length >= 20) return;
    if (!includeHidden && !isVisible(h)) return;
    const t = trim(h.textContent, 100);
    if (t) headings.push({ level: Number(h.tagName.slice(1)), text: t });
  });

  const landmarks = [];
  document.querySelectorAll("main, nav, header, footer, aside, form, [role=main], [role=navigation], [role=banner], [role=contentinfo], [role=search], [role=form]").forEach((el) => {
    if (landmarks.length >= 12) return;
    if (!includeHidden && !isVisible(el)) return;
    landmarks.push({
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: trim(el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || "", 80),
    });
  });

  const interactive = [];
  const seen = new Set();
  const selector = ACTIONABLE;
  const nodes = document.querySelectorAll(selector);
  for (const el of nodes) {
    if (interactive.length >= maxItems) break;
    if (seen.has(el)) continue;
    seen.add(el);
    if (!includeHidden && !isVisible(el)) continue;
    const role = classify(el);
    if (!role) continue;
    const name = accessibleName(el);
    const cssSelector = buildSelector(el);
    const item = {
      idx: interactive.length,
      ref: refFor(el, { node: el, role, name, selector: cssSelector }),
      role,
      name,
      selector: cssSelector,
      in_viewport: inViewport(el),
    };
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") item.disabled = true;
    if (role === "link" && el.href) item.href = el.href;
    if (role === "textbox" || role === "textarea") {
      item.value = trim(el.value, 80);
      if (el.placeholder) item.placeholder = trim(el.placeholder, 80);
      if (el.required) item.required = true;
      if (el.type) item.input_type = el.type;
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      item.checked = el.checked === true || el.getAttribute("aria-checked") === "true";
    }
    if (role === "select") {
      const opts = Array.from(el.options || []).slice(0, 12).map((o) => ({ value: o.value, label: trim(o.textContent, 60) }));
      if (opts.length) item.options = opts;
      item.value = el.value ?? "";
    }
    interactive.push(item);
  }

  // Accessibility-style tree. This is the model's reading surface: one call
  // gives structure, labels, and the refs needed to act, so a read no longer
  // needs a follow-up `browser_extract`. Text-bearing nodes are included only
  // when the caller asks for them, which keeps the default payload compact.
  const TEXT_TAGS = new Set(["P", "LI", "TD", "TH", "DD", "DT", "BLOCKQUOTE", "PRE", "FIGCAPTION", "SUMMARY", "LABEL"]);
  const CONTAINER_TAGS = new Set(["MAIN", "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "SECTION", "ARTICLE"]);
  const TREE_MAX_NODES = 200;
  const scopeNode = typeof opts?.ref === "number" ? registry.get(opts.ref) : null;
  const scopeEl = scopeNode?.node ?? scopeNode;
  const scope = scopeEl && scopeEl.nodeType === 1 ? scopeEl : (document.body || document.documentElement || null);
  if (!scope) {
    return {
      url: location.href,
      title: document.title,
      fingerprint: null,
      tree: [],
      text: "",
      interactive: [],
      filter,
      error: "no document body to inspect",
    };
  }

  function describeNode(el) {
    const role = classify(el);
    if (role) return { role, name: accessibleName(el), actionable: true };
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const heading = trim(el.innerText ?? el.textContent, 140);
      return heading ? { role: `h${tag.slice(1)}`, name: heading, actionable: false } : null;
    }
    if (filter === "all" && CONTAINER_TAGS.has(tag)) {
      return { role: tag.toLowerCase(), name: trim(el.getAttribute("aria-label") || "", 80), actionable: false };
    }
    if (filter !== "interactive" && TEXT_TAGS.has(tag)) {
      const text = trim(el.innerText ?? el.textContent, 160);
      return text ? { role: tag.toLowerCase(), name: text, actionable: false } : null;
    }
    return null;
  }

  const tree = [];
  function walk(el, depth) {
    if (tree.length >= TREE_MAX_NODES || depth > maxDepth) return;
    if (!el || el.nodeType !== 1) return;
    if (!includeHidden && !isVisible(el)) return;
    const described = describeNode(el);
    if (described && (filter !== "interactive" || described.actionable)) {
      tree.push({
        depth,
        role: described.role,
        name: described.name,
        ...(described.actionable ? { ref: refFor(el, { node: el, role: described.role, name: described.name }) } : {}),
      });
    }
    for (const child of el.children) walk(child, depth + 1);
  }
  walk(scope, 0);

  const textBudget = filter === "interactive" ? Math.min(maxChars, 2_000) : maxChars;
  const rawText = String(scope.innerText ?? scope.textContent ?? "");
  const compactText = rawText.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const text = compactText.length > textBudget ? `${compactText.slice(0, textBudget - 1)}…` : compactText;

  // Local copy: this function is injected, so the helper cannot live at
  // module scope (that was the cause of a shipped `data: null` snapshot).
  function hashSnapshot(value) {
    const raw = JSON.stringify(value);
    let h = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  const fingerprint = hashSnapshot({
    url: location.href,
    title: document.title,
    headings,
    landmarks,
    interactive: interactive.map((item) => ({ role: item.role, name: item.name, selector: item.selector, disabled: item.disabled === true })),
    total_interactive: nodes.length,
  });

  return {
    url: location.href,
    title: document.title,
    fingerprint,
    viewport: { width: window.innerWidth, height: window.innerHeight, scroll_y: window.scrollY, doc_height: document.documentElement.scrollHeight },
    headings,
    landmarks,
    interactive,
    tree,
    tree_truncated: tree.length >= TREE_MAX_NODES,
    text,
    text_length: compactText.length,
    text_truncated: compactText.length > textBudget,
    filter,
    scope_ref: typeof opts?.ref === "number" ? opts.ref : null,
    truncated: nodes.length > interactive.length,
    total_interactive: nodes.length,
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

function tabHost(url) {
  if (typeof url !== "string" || url.length === 0) return "";
  try { return new URL(url).hostname; } catch { return ""; }
}

function isScriptableTabUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const u = new URL(url);
    return !["chrome:", "chrome-extension:", "edge:", "about:", "devtools:", "view-source:"].includes(u.protocol);
  } catch {
    return false;
  }
}

async function listTabs(deps, includeUnusable) {
  if (typeof deps.queryTabs !== "function") {
    return { ok: false, error: "tab inventory is unavailable in this extension build" };
  }
  const [tabs, pin, foreground, focusedWindow] = await Promise.all([
    deps.queryTabs({}),
    typeof deps.getPinnedTab === "function" ? deps.getPinnedTab() : null,
    typeof deps.getForegroundTab === "function" ? deps.getForegroundTab() : null,
    typeof deps.getLastFocusedWindow === "function" ? deps.getLastFocusedWindow().catch(() => null) : null,
  ]);
  const focusedWindowId = typeof focusedWindow?.id === "number" ? focusedWindow.id : null;
  const pinnedTabId = typeof pin?.tabId === "number" ? pin.tabId : null;
  const foregroundTabId = typeof foreground?.tabId === "number" ? foreground.tabId : null;
  const summarized = (tabs || []).map((tab) => {
    const url = typeof tab.url === "string" ? tab.url : typeof tab.pendingUrl === "string" ? tab.pendingUrl : "";
    const usable = isScriptableTabUrl(url);
    return {
      tab_id: tab.id,
      window_id: tab.windowId,
      index: tab.index,
      active: Boolean(tab.active),
      focused_window: focusedWindowId !== null && tab.windowId === focusedWindowId,
      pinned_target: pinnedTabId !== null && tab.id === pinnedTabId,
      foreground: foregroundTabId !== null && tab.id === foregroundTabId,
      title: typeof tab.title === "string" ? tab.title : "",
      url,
      host: tabHost(url),
      status: typeof tab.status === "string" ? tab.status : "unknown",
      usable,
      ...(usable ? {} : { unusable_reason: url ? "unsupported URL" : "URL unavailable; grant host access or tabs permission for metadata" }),
    };
  }).filter((tab) => includeUnusable || tab.usable);
  return {
    ok: true,
    data: {
      tabs: summarized,
      total: summarized.length,
      current_tab_id: foregroundTabId ?? summarized.find((tab) => tab.active && tab.focused_window)?.tab_id ?? null,
      foreground_tab_id: foregroundTabId,
      pinned_tab_id: pinnedTabId,
    },
  };
}

async function activateTab(deps, tabId) {
  if (typeof deps.activateTab !== "function") {
    return { ok: false, error: "tab activation is unavailable in this extension build" };
  }
  const tab = await deps.activateTab(tabId);
  if (!tab?.id) return { ok: false, error: `tab ${tabId} was not found` };
  if (typeof deps.focusWindow === "function" && typeof tab.windowId === "number") {
    await deps.focusWindow(tab.windowId);
  }
  return {
    ok: true,
    data: {
      tab_id: tab.id,
      window_id: tab.windowId,
      title: typeof tab.title === "string" ? tab.title : "",
      url: typeof tab.url === "string" ? tab.url : "",
      host: tabHost(tab.url),
      focused: true,
    },
  };
}

async function reportProgress(deps, command, phase) {
  if (!command?.cmd_id || typeof deps.reportProgress !== "function") return;
  try { await deps.reportProgress(command.cmd_id, phase); } catch { /* best-effort */ }
}

// Best-effort post-action snapshot. Used by navigate/click/fill when the
// server flips `auto_snapshot: true` so the agent can chain the next
// step without an explicit `browser_snapshot` round-trip. We wait for
// the DOM to settle (300ms quiet window, 2s ceiling) before snapshotting
// so dynamic UIs (modal that pops, validation errors that appear, list
// that re-renders) are captured in their committed form. Failures are
// swallowed — the action itself already succeeded and the agent will
// fall back to calling `browser_snapshot` explicitly if needed.
async function captureAutoSnapshot(deps, tabId, command) {
  if (!command || !command.auto_snapshot) return undefined;
  try {
    await execInTabAsync(deps, tabId, pageWaitForDomIdleFn, [300, 2000]);
    const snap = await execInTab(deps, tabId, pageSnapshotFn, [
      { max_items: 80, include_hidden: false },
    ]);
    if (!snap) return undefined;
    return { ...snap, tab_id: tabId };
  } catch {
    return undefined;
  }
}

async function waitForTabComplete(deps, tabId, timeoutMs) {
  if (!deps.onTabComplete) return;
  await deps.onTabComplete({ tabId }, () => {});
  // Caller helper actually awaits an event-based promise — see service
  // worker implementation. Here we keep the dependency interface tiny
  // and let the SW supply the real waiter.
  void timeoutMs;
}

// --------------------------------------------------------------------- //
// Target execution — resolve against the live page, act, recover once.   //
// --------------------------------------------------------------------- //
//
// The server no longer turns a handle into a CSS string before dispatch.
// That conversion was the single largest failure source in the command
// ledger: the selector described the page as it was when the agent looked,
// and `querySelector` then ran against the page as it is now. Instead:
//
//   1. a `ref` from the last snapshot is the durable identity;
//   2. `role` + `name` is resolved through one fresh snapshot when needed;
//   3. a miss refreshes the page map once, re-resolves by accessible name,
//      and retries a single time before reporting candidates.
const NOT_EXECUTED = "Not executed: an earlier action in this step list failed.";
const SNAPSHOT_DEFAULTS = { max_items: 80, include_hidden: false, filter: "interactive" };

function describeTarget(locator) {
  if (locator?.selector) return `selector \`${locator.selector}\``;
  if (locator?.role && locator?.name) return `${locator.role} "${locator.name}"`;
  if (typeof locator?.ref === "number") return `ref ${locator.ref}`;
  return "target";
}

// Commands carry transport fields that mean nothing to the page function.
// Strip them so a page payload is only what the action needs.
function toPagePayload(command) {
  const {
    type: _type,
    cmd_id: _cmd,
    timeout_ms: _timeout,
    enqueued_at: _at,
    auto_snapshot: _auto,
    ...payload
  } = command ?? {};
  void _type; void _cmd; void _timeout; void _at; void _auto;
  return payload;
}

// One place that turns a failed page action into the sentence the agent
// reads. A silent no-op (page script returned nothing) must never be
// reported as "no element matched" — that sends the agent looking for a
// selector bug that does not exist.
function actError(command, result) {
  if (result?.reason === "no_result") {
    return result.hint || "the page script returned nothing — reload the extension and retry";
  }
  if (result?.reason === "option_not_found") {
    return `no option matched the supplied value in ${describeTarget(command)}`;
  }
  return `no element matched ${describeTarget(command)}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function snapshotInTab(deps, tabId, opts = {}) {
  return execInTab(deps, tabId, pageSnapshotFn, [{ ...SNAPSHOT_DEFAULTS, ...opts }]);
}

function findInteractive(snapshot, { role, name } = {}) {
  const items = Array.isArray(snapshot?.interactive) ? snapshot.interactive : [];
  if (items.length === 0) return null;
  const pool = role ? items.filter((item) => item.role === role) : items;
  if (pool.length === 0) return null;
  const want = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!want) return pool.length === 1 ? pool[0] : null;
  const exact = pool.filter((item) => String(item.name || "").trim().toLowerCase() === want);
  if (exact.length > 0) return exact[0];
  const partial = pool.filter((item) => String(item.name || "").toLowerCase().includes(want));
  return partial[0] ?? null;
}

function candidateList(snapshot, limit = 8) {
  const items = Array.isArray(snapshot?.interactive) ? snapshot.interactive : [];
  return items.slice(0, limit).map((item) => ({ ref: item.ref, role: item.role, name: item.name }));
}

function needsNameResolution(locator) {
  return typeof locator?.ref !== "number" && !locator?.selector && Boolean(locator?.role) && Boolean(locator?.name);
}

// Turn name-based locators into refs. `snapshot` is reused when the caller
// already paid for one; otherwise the first name-based locator triggers a
// single snapshot for the whole payload.
async function preparePayload(deps, tabId, action, payload, snapshot) {
  const effective = { ...payload };
  let snap = snapshot ?? null;
  const resolveOne = (locator) => {
    if (!needsNameResolution(locator) || !snap) return locator;
    const hit = findInteractive(snap, locator);
    return typeof hit?.ref === "number" ? { ...locator, ref: hit.ref } : locator;
  };

  if (action === "fill_many") {
    const fields = Array.isArray(effective.fields) ? effective.fields : [];
    if (fields.some(needsNameResolution)) {
      snap = snap ?? await snapshotInTab(deps, tabId);
      effective.fields = fields.map(resolveOne);
      if (needsNameResolution(effective)) {
        const hit = findInteractive(snap, effective);
        if (typeof hit?.ref === "number") effective.submit_ref = hit.ref;
      }
    }
  } else if (needsNameResolution(effective)) {
    snap = snap ?? await snapshotInTab(deps, tabId);
    const hit = findInteractive(snap, effective);
    if (typeof hit?.ref === "number") effective.ref = hit.ref;
  }
  return { effective, snapshot: snap };
}

function isRetryableMiss(result) {
  if (!result || result.matched !== false) return false;
  return result.reason === "stale_ref" || result.reason === "no_match" || result.reason === "needs_snapshot";
}

async function runAct(deps, tabId, action, payload) {
  const first = await preparePayload(deps, tabId, action, payload);
  const result = await execInTab(deps, tabId, pageActFn, [action, first.effective]);
  if (result === undefined) {
    // The injected script returned nothing. That is what a closed-over
    // module reference looks like from here, and reporting it as "no element
    // matched" would send the agent chasing a phantom selector.
    return {
      result: {
        matched: false,
        action,
        reason: "no_result",
        hint: "the page script returned nothing — reload the extension so the service worker picks up its current code",
      },
      snapshot: first.snapshot,
    };
  }
  if (!isRetryableMiss(result)) return { result, snapshot: first.snapshot };

  // One recovery attempt against a freshly discovered page map. A stale ref
  // reports what it used to be, so the refresh can re-find the same control
  // by accessible name — that is the case a shipped CSS string could never
  // recover from.
  const fresh = await snapshotInTab(deps, tabId);
  const hint = result?.stale && result.stale.role && result.stale.name ? result.stale : payload;
  const second = await preparePayload(deps, tabId, action, hint, fresh);
  if (JSON.stringify(second.effective) === JSON.stringify(first.effective)) {
    return { result: { ...result, candidates: candidateList(fresh) }, snapshot: fresh };
  }
  const retried = await execInTab(deps, tabId, pageActFn, [action, second.effective]);
  return {
    result: retried?.matched
      ? { ...retried, recovered: true }
      : { ...retried, recovered: true, candidates: candidateList(fresh) },
    snapshot: fresh,
  };
}

async function runNavigate(deps, tab, command, timeout) {
  if (!command.url && !command.to) return { ok: false, error: "navigate needs `url` or `to`" };
  // Navigating the Jarela app tab destroys the user's own chat surface. The
  // agent can still open the app in a different tab; it just cannot steer the
  // tab the user is having the conversation in without saying so.
  if (!command.allow_app_tab && typeof deps.isAppTabUrl === "function" && deps.isAppTabUrl(tab.url)) {
    return {
      ok: false,
      error:
        "this tab is the Jarela app itself — navigating it would close the conversation the user is watching. " +
        "Target another tab, or pass allow_app_tab when the user explicitly asked for it.",
      data: { needs_tab: "non_app" },
    };
  }
  await reportProgress(deps, command, "navigating");
  if (command.to === "back" || command.to === "forward") {
    const navigateHistory = command.to === "back" ? deps.goBack : deps.goForward;
    if (typeof navigateHistory !== "function") {
      return { ok: false, error: `history ${command.to} is unavailable in this extension build` };
    }
    await navigateHistory(tab.id);
  } else if (command.to === "reload") {
    if (typeof deps.reloadTab !== "function") return { ok: false, error: "reload is unavailable in this extension build" };
    await deps.reloadTab(tab.id);
  } else {
    if (!isHttpUrl(command.url)) return { ok: false, error: "only http and https URLs can be opened" };
    await deps.updateTab({ tabId: tab.id, url: command.url });
  }
  if (deps.waitTabLoaded) {
    await reportProgress(deps, command, "waiting_for_load");
    await deps.waitTabLoaded(tab.id, timeout);
  }
  if (typeof deps.getTab === "function") {
    const after = await deps.getTab(tab.id).catch(() => null);
    if (after && (after.status === "unloaded" || after.discarded === true)) {
      return {
        ok: false,
        error: `tab ${after.status === "unloaded" ? "crashed" : "was discarded"} during navigation — retry after reopening the page`,
        data: { tab_id: tab.id, status: after.status ?? "unknown", discarded: Boolean(after.discarded) },
      };
    }
  }
  if (command.wait_for_selector) {
    await reportProgress(deps, command, "waiting_for_selector");
    const found = await execInTabAsync(deps, tab.id, pageWaitForSelectorFn, [
      command.wait_for_selector,
      Math.min(timeout, 15_000),
    ]);
    if (!found?.found) {
      return { ok: false, error: `wait_for_selector \`${command.wait_for_selector}\` not found within ${timeout}ms` };
    }
  }
  const after = typeof deps.getTab === "function" ? await deps.getTab(tab.id).catch(() => null) : null;
  return { ok: true, url: after?.url ?? command.url ?? null };
}

async function runExpect(deps, tabId, expect, timeout) {
  if (!expect) return { met: true };
  const budget = expect.timeout_ms ?? Math.min(timeout, 15_000);
  let opts = null;
  if (expect.selector) opts = { for: "selector", selector: expect.selector };
  else if (expect.text) opts = { for: "text", text: expect.text };
  else if (expect.url) opts = { for: "url", url: expect.url };
  else if (expect.idle) opts = { for: "idle", quiet_ms: 500 };
  if (!opts) return { met: true };
  const waited = await execInTab(deps, tabId, pageWaitFn, [{ ...opts, timeout_ms: budget }]);
  return waited?.matched
    ? { met: true, waited_ms: waited.waited_ms }
    : { met: false, waited_ms: waited?.waited_ms ?? budget };
}

async function runBatchStep(deps, tab, step, timeout) {
  try {
    if (step.action === "navigate") {
      const nav = await runNavigate(deps, tab, { url: step.url, to: step.to }, timeout);
      if (!nav.ok) return { ok: false, error: nav.error };
    } else if (step.action === "wait") {
      const waited = await execInTab(deps, tab.id, pageWaitFn, [{
        for: step.for ?? "time",
        selector: step.selector,
        text: step.text,
        url: step.url,
        timeout_ms: step.timeout_ms ?? Math.min(timeout, 15_000),
      }]);
      if (!waited?.matched) {
        return { ok: false, error: `wait for ${step.for ?? "time"} timed out`, data: waited };
      }
    } else if (step.action === "scroll" && (step.to === "top" || step.to === "bottom")) {
      await execInTab(deps, tab.id, pageScrollFn, [step.selector ?? null, step.to]);
    } else {
      const { result } = await runAct(deps, tab.id, step.action, step);
      if (!result?.matched) return { ok: false, error: actError(step, result), data: result };
    }
    const expectation = await runExpect(deps, tab.id, step.expect, timeout);
    if (!expectation.met) {
      return { ok: false, error: "expectation not met", expect: step.expect, waited_ms: expectation.waited_ms };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run a command against the active tab via the supplied chrome.* deps.
 * Returns `{ ok, data }` on success or `{ ok: false, error }` on failure.
 */
export async function dispatchCommand(deps, command) {
  if (!command || typeof command !== "object") {
    return { ok: false, error: "invalid command" };
  }
  if (command.type === "tabs") {
    return listTabs(deps, command.include_unusable ?? false);
  }
  if (command.type === "activate_tab") {
    return activateTab(deps, command.tab_id);
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
        const nav = await runNavigate(deps, tab, command, timeout);
        if (!nav.ok) return nav;
        await reportProgress(deps, command, "snapshotting");
        const snapshot = await captureAutoSnapshot(deps, tab.id, command);
        return {
          ok: true,
          data: { tab_id: tab.id, url: nav.url, ...(snapshot ? { snapshot } : {}) },
        };
      }
      case "click": {
        await reportProgress(deps, command, "clicking");
        const { result } = await runAct(deps, tab.id, "click", toPagePayload(command));
        if (!result?.matched) {
          return { ok: false, error: actError(command, result), data: result };
        }
        const after = await captureAutoSnapshot(deps, tab.id, command);
        return { ok: true, data: { ...result, ...(after ? { snapshot: after } : {}) } };
      }
      case "press": {
        await reportProgress(deps, command, "pressing");
        const { result } = await runAct(deps, tab.id, "press", toPagePayload(command));
        if (!result?.matched) return { ok: false, error: actError(command, result), data: result };
        const after = await captureAutoSnapshot(deps, tab.id, command);
        return { ok: true, data: { ...result, ...(after ? { snapshot: after } : {}) } };
      }
      case "fill": {
        await reportProgress(deps, command, "filling");
        const { result } = await runAct(deps, tab.id, "fill", toPagePayload(command));
        if (!result?.matched) {
          return { ok: false, error: actError(command, result), data: result };
        }
        const after = await captureAutoSnapshot(deps, tab.id, command);
        return { ok: true, data: { ...result, ...(after ? { snapshot: after } : {}) } };
      }
      case "fill_many": {
        await reportProgress(deps, command, "filling_many");
        const { result } = await runAct(deps, tab.id, "fill_many", toPagePayload(command));
        if (!result?.matched) {
          const failed = Array.isArray(result?.fields) ? result.fields.filter((field) => !field.matched) : [];
          return {
            ok: false,
            error: result?.reason === "no_result"
              ? actError(command, result)
              : failed.length > 0
                ? `${failed.length} of ${result.total ?? command.fields.length} fields did not match`
                : "no fillable elements matched the supplied fields",
            data: result,
          };
        }
        const after = await captureAutoSnapshot(deps, tab.id, command);
        return { ok: true, data: { ...result, ...(after ? { snapshot: after } : {}) } };
      }
      case "scroll": {
        if (command.to === "into-view") {
          const { result } = await runAct(deps, tab.id, "scroll", toPagePayload(command));
          if (!result?.matched) return { ok: false, error: actError(command, result), data: result };
          return { ok: true, data: result };
        }
        const result = await execInTab(deps, tab.id, pageScrollFn, [command.selector ?? null, command.to]);
        return { ok: true, data: result };
      }
      case "wait": {
        await reportProgress(deps, command, "waiting");
        const waited = await execInTab(deps, tab.id, pageWaitFn, [{
          for: command.for,
          selector: command.selector,
          text: command.text,
          url: command.url,
          quiet_ms: command.quiet_ms,
          timeout_ms: command.timeout_ms ?? timeout,
        }]);
        if (!waited?.matched) {
          return {
            ok: false,
            error: `wait for ${command.for} timed out after ${waited?.waited_ms ?? timeout}ms`,
            data: waited,
          };
        }
        return { ok: true, data: waited };
      }
      case "batch": {
        const outcomes = [];
        let halted = null;
        for (const [index, step] of command.steps.entries()) {
          if (halted !== null) {
            outcomes.push({ index, action: step.action, ok: false, skipped: true, error: NOT_EXECUTED });
            continue;
          }
          await reportProgress(deps, command, `step_${index + 1}`);
          const outcome = await runBatchStep(deps, tab, step, timeout);
          outcomes.push({ index, action: step.action, ...outcome });
          if (!outcome.ok) halted = index;
        }
        await reportProgress(deps, command, "snapshotting");
        const snapshot = await captureAutoSnapshot(deps, tab.id, { auto_snapshot: true });
        return {
          ok: halted === null,
          ...(halted === null
            ? {}
            : { error: `step ${halted} (${command.steps[halted].action}): ${outcomes[halted].error}` }),
          data: { steps: outcomes, halted_at: halted, ...(snapshot ? { snapshot } : {}) },
        };
      }
      case "extract": {
        await reportProgress(deps, command, "extracting");
        const result = await execInTab(deps, tab.id, pageExtractFn, [
          command.selector ?? null,
          command.format ?? "text",
          command.max_chars ?? null,
          command.offset ?? 0,
        ]);
        if (!result?.matched) {
          return { ok: false, error: `no element matched selector \`${command.selector ?? ""}\`` };
        }
        return { ok: true, data: result };
      }
      case "snapshot": {
        await reportProgress(deps, command, "snapshotting");
        const result = await snapshotInTab(deps, tab.id, {
          max_items: command.max_items ?? 80,
          include_hidden: command.include_hidden ?? false,
          filter: command.filter ?? "interactive",
          depth: command.depth,
          ref: command.ref,
          max_chars: command.max_chars,
        });
        if (!result) return { ok: false, error: "page snapshot returned no data" };
        return { ok: true, data: { ...result, tab_id: tab.id } };
      }
      case "screenshot": {
        await reportProgress(deps, command, "screenshotting");
        // 1. If a selector or ref was supplied, read element bounds to crop later.
        let bounds = null;
        if (command.selector || typeof command.ref === "number") {
          bounds = await execInTab(deps, tab.id, pageBoundsForTargetFn, [{
            ref: command.ref,
            selector: command.selector,
          }]);
          if (!bounds?.matched) {
            return { ok: false, error: `no element matched ${describeTarget(command)}` };
          }
        }
        // 2. Capture. captureVisibleTab only ever sees the *active* tab of a
        // window, which is why every screenshot of a pinned or background
        // target used to fail. Activate it for the capture, then put the
        // user's tab back exactly as it was.
        const format = command.format === "jpeg" ? "jpeg" : "png";
        let restoredTabId = null;
        if (tab.active === false && typeof deps.activateTab === "function") {
          try {
            const [previous] = await deps.queryTabs({ windowId: tab.windowId, active: true });
            if (previous?.id && previous.id !== tab.id) restoredTabId = previous.id;
            await deps.activateTab(tab.id);
            await new Promise((resolve) => setTimeout(resolve, 120));
          } catch { /* capture will fail with its own error */ }
        }
        let dataUrl = null;
        let captureError = null;
        try {
          dataUrl = await deps.captureVisibleTab(tab.windowId ?? undefined, { format });
        } catch (err) {
          captureError = err;
        } finally {
          if (restoredTabId !== null) {
            try { await deps.activateTab(restoredTabId); } catch { /* best-effort */ }
          }
        }
        if (captureError) {
          const raw = captureError instanceof Error ? captureError.message : String(captureError);
          const host = tabHost(tab.url);
          // Chrome grants captureVisibleTab to a tab only through activeTab
          // (which needs a user gesture the agent does not have) or a host
          // permission. Say so instead of surfacing a bare Chrome error that
          // reads like a bug in Jarela.
          if (/activeTab|<all_urls>|permission/i.test(raw)) {
            return {
              ok: false,
              error:
                `Chrome will not let the extension capture ${host || "this tab"} without host access. ` +
                `Grant host access for ${host || "that site"} in the Jarela extension options, then retry.`,
              data: { needs_permission: "host", host: host || null, raw },
            };
          }
          throw captureError;
        }
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
            captured_tab_id: tab.id,
            activated_for_capture: restoredTabId !== null,
            // captureVisibleTab cannot see beyond the viewport; say so rather
            // than echoing a flag we did not honour.
            full_page: false,
            ...(command.full_page ? { full_page_unavailable: "raise the window or capture a selector instead" } : {}),
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
