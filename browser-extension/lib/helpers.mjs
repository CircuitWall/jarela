// Pure helpers shared between the content script and unit tests.
//
// The content script imports this module at runtime via
// `chrome.runtime.getURL("lib/helpers.mjs")`, so it is a single source of
// truth. Vitest also imports it directly for the test suite. Keep it free
// of `chrome.*` API calls and DOM-shape assumptions beyond the duck-typed
// element interface buildCssSelector accepts.

// Build a CSS selector path from an element up to either an ancestor with
// an id or the document root. Heuristics:
//   - If the element has an id, just use `#id` and stop.
//   - Walk up via parentElement, accumulating `tag` segments.
//   - Disambiguate same-tag siblings with :nth-of-type.
//   - Add a single class disambiguator if it's the *only* non-tag info we
//     have for this segment (helps server-side display, not required for
//     correctness — the path is for the agent's reading, not for re-finding
//     the element later).
//
// The element shape: { tagName, id, classList (array-like), parentElement,
// _prev (array of prior-sibling tag names), _next (array of later-sibling
// tag names) }. Production DOM Elements satisfy this shape via standard
// properties; tests pass plain objects.
export function buildCssSelector(el) {
  if (!el) return "";
  if (el.id) return `#${el.id}`;
  const segments = [];
  let cur = el;
  let stoppedAtId = false;
  while (cur && !stoppedAtId) {
    if (cur.id) {
      segments.unshift(`#${cur.id}`);
      stoppedAtId = true;
      break;
    }
    let segment = (cur.tagName ?? "").toLowerCase();
    const sameTagBefore = countSameTag(cur._prev ?? prevSiblingsOf(cur), cur.tagName);
    const sameTagAfter = countSameTag(cur._next ?? nextSiblingsOf(cur), cur.tagName);
    if (sameTagBefore + sameTagAfter > 0) {
      segment += `:nth-of-type(${sameTagBefore + 1})`;
    } else if (cur.classList && cur.classList.length === 1 && segments.length === 0) {
      // Anchor the leaf with its single class for legibility. Skip when
      // there are multiple classes — picking the "right" one is guesswork.
      segment += `.${cur.classList[0]}`;
    }
    segments.unshift(segment);
    cur = cur.parentElement;
  }
  return segments.join(" > ");
}

function countSameTag(siblings, tagName) {
  if (!siblings || !tagName) return 0;
  const target = tagName.toUpperCase();
  let n = 0;
  for (const t of siblings) {
    if ((t ?? "").toUpperCase() === target) n++;
  }
  return n;
}

// DOM-flavoured fallbacks: when running in the content script against a
// real Element, `_prev` / `_next` aren't defined; we walk the live sibling
// chain instead. Tests inject `_prev` / `_next` directly to bypass this.
function prevSiblingsOf(el) {
  const out = [];
  let s = el?.previousElementSibling;
  while (s) { out.unshift(s.tagName); s = s.previousElementSibling; }
  return out;
}
function nextSiblingsOf(el) {
  const out = [];
  let s = el?.nextElementSibling;
  while (s) { out.push(s.tagName); s = s.nextElementSibling; }
  return out;
}

// Build the request payload, omitting absent optional fields so the
// server's zod `optional()` validators don't reject explicit nulls.
export function composePayload({ url, title, selector, tagName, text, capturedAt, screenshot, screenshotMediaType }) {
  const p = { url, text, capturedAt };
  const t = typeof title === "string" ? title.trim() : "";
  if (t) p.title = t;
  if (selector) p.selector = selector;
  if (tagName) p.tagName = tagName;
  if (typeof screenshot === "string" && screenshot.length > 0) {
    p.screenshot = screenshot;
    if (typeof screenshotMediaType === "string" && screenshotMediaType.length > 0) {
      p.screenshotMediaType = screenshotMediaType;
    }
  }
  return p;
}
