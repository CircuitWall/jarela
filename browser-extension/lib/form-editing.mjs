function runFieldOperation(operation, value) {
  function roots() {
    const found = [document];
    for (let index = 0; index < found.length; index++) {
      for (const element of found[index].querySelectorAll("*")) {
        if (element.shadowRoot) found.push(element.shadowRoot);
      }
    }
    return found;
  }

  function queryAll(selector) {
    return roots().flatMap((root) => [...root.querySelectorAll(selector)]);
  }

  function isEditable(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (element instanceof HTMLInputElement) return /^(text|search|email|url|tel)$/i.test(element.type || "text");
    return Boolean(element?.isContentEditable);
  }

  function findTarget() {
    const pinned = queryAll("[data-jarela-fill-target]").find(isEditable);
    if (pinned) return pinned;
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (isEditable(active)) return active;
    const editableParent = active?.closest?.("[contenteditable=''], [contenteditable='true']");
    if (isEditable(editableParent)) return editableParent;
    const dialog = queryAll("[role='dialog'], dialog[open]")[0];
    const field = dialog?.querySelector("textarea, input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], [contenteditable=''], [contenteditable='true']");
    return isEditable(field) ? field : null;
  }

  function capture() {



        const sel = window.getSelection?.();
        const trimmedSelection = (sel?.toString() || "").trim();

        // Reuse an existing mark if a prior call already pinned the
        // editable in this frame (e.g. the menu has stolen focus).
        const el = findTarget();

        if (!isEditable(el)) {
          // Selection-only state (no field focused in this frame).
          return trimmedSelection ? { hasField: false, original: trimmedSelection } : null;
        }

        // Clear stale marks on siblings, then pin this one.
        queryAll("[data-jarela-fill-target]").forEach((n) => {
          if (n !== el) {
            n.removeAttribute("data-jarela-fill-target");
            delete n.dataset?.jarelaFillStart;
            delete n.dataset?.jarelaFillEnd;
            delete n.dataset?.jarelaFillCaretOffset;
            delete n.dataset?.jarelaFillCaretEndOffset;
          }
        });
        queryAll("[data-jarela-fill-caret]").forEach((n) => n.remove());
        el.setAttribute("data-jarela-fill-target", "1");

        // Capture range NOW (start..end). For input/textarea: selection
        // indices. For contenteditable: text-offsets from the editable's
        // start, measured via synthetic range so element-node containers
        // (multi-paragraph selections in Gmail/Outlook) work the same as
        // text-node containers. Dataset on the editable root survives
        // framework reconciliation where a marker <span> would be
        // stripped. `original` is empty when the selection is collapsed.
        let original = "";
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          const s = Number(el.selectionStart ?? el.value.length);
          const e = Number(el.selectionEnd ?? el.value.length);
          el.dataset.jarelaFillStart = String(s);
          el.dataset.jarelaFillEnd = String(e);
          if (s !== e) original = String(el.value || "").slice(Math.min(s, e), Math.max(s, e));
        } else if (el.isContentEditable) {
          try {
            const doc = el.ownerDocument || document;
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              if (el.contains(range.startContainer) && el.contains(range.endContainer)) {
                function offsetFromStart(container, offsetInContainer) {
                  const r = doc.createRange();
                  r.selectNodeContents(el);
                  r.setEnd(container, offsetInContainer);
                  return r.toString().length;
                }
                const startOffset = offsetFromStart(range.startContainer, range.startOffset);
                const endOffset = offsetFromStart(range.endContainer, range.endOffset);
                el.dataset.jarelaFillCaretOffset = String(startOffset);
                el.dataset.jarelaFillCaretEndOffset = String(endOffset);
                if (startOffset !== endOffset) original = range.toString();
              }
            }
          } catch {
            // Best-effort — fall back to end-of-field insertion.
          }
        }

        return { hasField: true, original };

  }

  function clear() {
        queryAll("[data-jarela-fill-target]").forEach((n) => {
          n.removeAttribute("data-jarela-fill-target");
          delete n.dataset?.jarelaFillStart;
          delete n.dataset?.jarelaFillEnd;
          delete n.dataset?.jarelaFillCaretOffset;
          delete n.dataset?.jarelaFillCaretEndOffset;
        });
        queryAll("[data-jarela-fill-caret]").forEach((n) => n.remove());

  }

  function context(selectedTextOverride) {
      function normalizeText(v, max = 5000) {
        return (v || "").replace(/\s+/g, " ").trim().slice(0, max);
      }

      const active = findTarget();
      const isTextarea = active instanceof HTMLTextAreaElement;
      const isTextInput = active instanceof HTMLInputElement && /^(text|search|email|url|tel)$/i.test(active.type || "text");
      const target = active;

      let selectedText = normalizeText(selectedTextOverride || "", 3000);
      if (!selectedText) {
        if (isTextarea || isTextInput) {
          const start = Number(active.selectionStart ?? 0);
          const end = Number(active.selectionEnd ?? 0);
          selectedText = normalizeText(String(active.value || "").slice(Math.min(start, end), Math.max(start, end)), 3000);
        } else {
          selectedText = normalizeText(window.getSelection?.()?.toString() || "", 3000);
        }
      }

      const title = document.title;
      const url = location.href;
      const h1 = normalizeText(document.querySelector("h1")?.textContent || "", 300);
      const h2 = normalizeText(document.querySelector("h2")?.textContent || "", 300);
      const meta = normalizeText(document.querySelector('meta[name="description"]')?.getAttribute("content") || "", 400);

      // Find the nearest meaningful container around the focused field.
      // Walk up the DOM and keep the largest ancestor whose text content is
      // "reasonable" (>= 200 chars, <= 20000). This picks the email thread
      // around a Gmail reply, the issue around a GitHub comment box, the
      // dialog around a compose form — but stops short of containers that
      // have already absorbed the whole page chrome (nav, sidebars, inbox
      // listing). Empty when there's no focused field.
      function findScope(field) {
        let node = field?.parentElement || null;
        let best = null;
        while (node && node !== document.body) {
          const len = (node.innerText || "").trim().length;
          if (len > 20000) break;
          if (len >= 200) best = node;
          node = node.parentElement;
        }
        return best;
      }

      // Pull the scope's text minus the field's own current draft (so the
      // model doesn't see its own future output reflected back). Keep the
      // tail when truncating because email threads / comment threads put
      // the message being replied to closest to the reply box.
      function scopeText(scope, field, max = 6000) {
        if (!scope) return "";
        let raw = scope.innerText || "";
        let draft = "";
        if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
          draft = String(field.value || "");
        } else if (field?.isContentEditable) {
          draft = field.innerText || "";
        }
        if (draft && draft.trim().length > 0 && raw.includes(draft)) {
          raw = raw.split(draft).join(" ");
        }
        const cleaned = raw.replace(/\s+/g, " ").trim();
        if (cleaned.length <= max) return cleaned;
        return "... " + cleaned.slice(-max);
      }

      // Coarse classification of WHAT the field is for. The model already
      // gets the raw signals (tag, type, label, placeholder, host) and is
      // free to override this hint, but stating an explicit kind makes the
      // output style much more consistent: "search query" stays a bare
      // keyword list, "email reply" gets a greeting + sign-off, "chat
      // message" stays terse, etc.
      function detectFieldKind(field, hostName) {
        if (!field) return "";
        const tag = (field.tagName || "").toLowerCase();
        const type = (field.type || "").toLowerCase();
        const role = (field.getAttribute?.("role") || "").toLowerCase();
        const label = String(
          (field.id ? document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent : "")
          || field.closest?.("label")?.textContent
          || field.getAttribute?.("aria-label")
          || field.placeholder
          || field.name
          || "",
        ).toLowerCase();
        const host = (hostName || "").toLowerCase();

        if (type === "search" || role === "searchbox" || /\bsearch\b|\bquery\b/.test(label)) return "search query";
        if (type === "email") return "email address";
        if (type === "url") return "url";
        if (type === "tel") return "phone number";
        if (type === "number") return "numeric value";
        if (type === "password") return "password";

        const emailHost = /(^|\.)mail\.google\.com$|(^|\.)outlook\.(live|office)\.com$|(^|\.)mail\.yahoo\.com$|(^|\.)proton\.me$/.test(host);
        const isLongForm = tag === "textarea" || field.isContentEditable;

        if (emailHost && isLongForm) return "email reply";
        if (emailHost && /subject/.test(label)) return "email subject";
        if (/(^|\.)github\.com$/.test(host) && isLongForm) return "github comment";
        if (/(^|\.)(x|twitter)\.com$/.test(host) && isLongForm) return "social post";
        if (/(^|\.)linkedin\.com$/.test(host) && isLongForm) return "social post";
        if (/(^|\.)slack\.com$|(^|\.)discord\.com$/.test(host) && isLongForm) return "chat message";
        if (/(^|\.)reddit\.com$|(^|\.)stackoverflow\.com$/.test(host) && isLongForm) return "forum post";

        if (/reply|response/.test(label)) return "reply";
        if (/comment/.test(label)) return "comment";
        if (/message|chat|send/.test(label) && isLongForm) return "chat message";
        if (/subject|title|headline/.test(label)) return "short title";
        if (/description|bio|about/.test(label) && isLongForm) return "description";

        if (isLongForm) return "long-form text";
        if (tag === "input") return "short form field";
        return "";
      }

      let targetInfo = "";
      const scope = target ? findScope(target) : null;
      if (target) {
        const label = target.id
          ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`)?.textContent
          : target.closest("label")?.textContent;
        const placeholder = "placeholder" in target ? String(target.placeholder || "") : "";
        const name = "name" in target ? String(target.name || "") : "";
        const aria = target.getAttribute?.("aria-label") || "";
        const tag = (target.tagName || "").toLowerCase();
        const type = "type" in target ? String(target.type || "") : "";
        const role = target.getAttribute?.("role") || "";
        const maxlen = "maxLength" in target && Number(target.maxLength) > 0 ? Number(target.maxLength) : 0;
        const kind = detectFieldKind(target, location.host);
        targetInfo = [
          kind ? `Field kind: ${kind}` : "",
          `Field tag: ${tag}${target.isContentEditable ? " (contenteditable)" : ""}`,
          type ? `Field type: ${type}` : "",
          role ? `Field role: ${role}` : "",
          maxlen ? `Field maxlength: ${maxlen}` : "",
          `Field label: ${normalizeText(label || "", 200)}`,
          `Field name: ${normalizeText(name, 120)}`,
          `Field placeholder: ${normalizeText(placeholder, 200)}`,
          `Field aria-label: ${normalizeText(aria, 200)}`,
        ].filter((line) => line && !line.endsWith(": ")).join("\n");
      }

      const pageContext = [
        `Host: ${location.host}`,
        h1 ? `Main heading: ${h1}` : "",
        h2 ? `Secondary heading: ${h2}` : "",
        meta ? `Meta description: ${meta}` : "",
        targetInfo,
      ].filter(Boolean).join("\n");

      // Priority order for the primary text payload:
      //   1. user's explicit selection (always wins)
      //   2. scope text around the focused field (the thread / form / dialog
      //      the field actually belongs to)
      //   3. document.body.innerText cap 5000 (only when there's no focused
      //      field at all — context-menu fill on a passive page region)
      let text;
      if (selectedText) text = selectedText;
      else if (target) text = scopeText(scope, target) || "";
      else text = normalizeText(document.body?.innerText || "", 5000);
      return { url, title, text, page_context: pageContext, has_target: Boolean(target) };

  }

  function fill(nextText) {
      const active = findTarget();
      if (!active) return { ok: false, reason: "No focused field" };

      if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|email|url|tel)$/i.test(active.type || "text"))) {
        active.focus();
        // Prefer the caret captured at mark time \u2014 the context menu +
        // spinner + LLM round-trip blur the field, after which
        // selectionStart/End reset to value.length and we'd append.
        const savedStart = active.dataset?.jarelaFillStart;
        const savedEnd = active.dataset?.jarelaFillEnd;
        const start = savedStart !== undefined
          ? Number(savedStart)
          : Number(active.selectionStart ?? active.value.length);
        const end = savedEnd !== undefined
          ? Number(savedEnd)
          : Number(active.selectionEnd ?? active.value.length);
        const left = active.value.slice(0, Math.min(start, end));
        const right = active.value.slice(Math.max(start, end));
        active.value = `${left}${nextText}${right}`;
        const cursor = left.length + nextText.length;
        active.selectionStart = cursor;
        active.selectionEnd = cursor;
        active.dispatchEvent(new Event("input", { bubbles: true }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }

      if (active.isContentEditable) {
        active.focus();
        // Restore the saved range (start..end) so insertText REPLACES any
        // selected text. Falls back to caret-only or end-of-field if the
        // field's text shrank between mark and fill.
        const savedStart = active.dataset?.jarelaFillCaretOffset;
        const savedEnd = active.dataset?.jarelaFillCaretEndOffset ?? savedStart;
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          if (savedStart !== undefined) {
            const startTarget = Number(savedStart);
            const endTarget = Number(savedEnd);
            const walker = document.createTreeWalker(active, NodeFilter.SHOW_TEXT);
            let n;
            let acc = 0;
            let placedStart = false;
            let placedEnd = false;
            while ((n = walker.nextNode())) {
              const len = (n.nodeValue || "").length;
              if (!placedStart && startTarget <= acc + len) {
                range.setStart(n, startTarget - acc);
                placedStart = true;
              }
              if (!placedEnd && endTarget <= acc + len) {
                range.setEnd(n, endTarget - acc);
                placedEnd = true;
              }
              if (placedStart && placedEnd) break;
              acc += len;
            }
            if (!placedStart || !placedEnd) {
              // Field shrank or text changed; clamp to end.
              range.selectNodeContents(active);
              range.collapse(false);
            }
          } else {
            // No offset captured (shadow-root host or detached frame).
            range.selectNodeContents(active);
            range.collapse(false);
          }
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          // Selection APIs throw inside detached frames; fall through to insertText.
        }
        delete active.dataset?.jarelaFillCaretOffset;
        delete active.dataset?.jarelaFillCaretEndOffset;
        const inserted = document.execCommand("insertText", false, nextText);
        if (!inserted) {
          // execCommand can be a no-op in some shadow roots / custom editors —
          // fall back to a plain textContent assignment + input event so the
          // host framework still sees the change.
          active.textContent = `${active.textContent || ""}${nextText}`;
        }
        active.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true };
      }

      return { ok: false, reason: "Focused element is not editable" };

  }

  function show() {
        const active = findTarget();
        if (!active || typeof active.getBoundingClientRect !== "function") return;
        const rect = active.getBoundingClientRect();
        document.getElementById("jarela-fill-spinner")?.remove();
        const el = document.createElement("div");
        el.id = "jarela-fill-spinner";
        el.innerHTML = '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5"/></svg>';
        el.style.top = `${Math.max(2, rect.top + 4)}px`;
        el.style.left = `${Math.max(2, rect.right - 22)}px`;
        document.body.appendChild(el);

  }

  function hide() { document.getElementById("jarela-fill-spinner")?.remove();
  }

  const handlers = { capture, clear, context, fill, show, hide };
  return handlers[operation](value);
}

function frameTarget(tabId, frameId) {
  return typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId };
}

export async function copyTextToClipboard(tabId, text) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [text],
    func: async (value) => {
      try {
        await navigator.clipboard.writeText(value);
        return { ok: true };
      } catch {
        try {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          ta.style.top = "0";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          const copied = document.execCommand("copy");
          ta.remove();
          return { ok: copied };
        } catch {
          return { ok: false };
        }
      }
    },
  });
  return Boolean(result?.ok);
}


// Unified capture: in one pass per same-origin frame, find the focused
// editable (and pin it with `data-jarela-fill-target` + dataset offsets
// so we can restore the caret/selection after the LLM round-trip blurs
// the field) AND/OR snapshot the current selection text. Returns:
//   { ok, frameId, hasField, original }
// where `original` is the selected text inside the editable (rewrite
// mode) or the loose page selection (clipboard mode), and is empty for
// pure-fill mode (caret-only). Picks the frame with an editable; falls
// back to the longest selection-only frame.
export async function captureField(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: ["capture"],
      func: runFieldOperation,
    });
  } catch {
    return { ok: false };
  }

  let fieldHit = null;
  let selHit = null;
  for (const r of results || []) {
    const v = r?.result;
    if (!v) continue;
    if (v.hasField) {
      if (!fieldHit) fieldHit = { ...v, frameId: r.frameId ?? 0 };
    } else if (!selHit || (v.original?.length ?? 0) > (selHit.original?.length ?? 0)) {
      selHit = { ...v, frameId: r.frameId ?? 0 };
    }
  }
  const winner = fieldHit || selHit;
  return winner ? { ok: true, ...winner } : { ok: false };
}


export async function clearFillTarget(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      args: ["clear"],
      func: runFieldOperation,
    });
  } catch {
    // Tab/frame may be gone — nothing to clean up.
  }
}


export async function getFillContext(tabId, frameId, selectionOverride) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: frameTarget(tabId, frameId),
    args: ["context", selectionOverride ?? ""],
    func: runFieldOperation,
  });
  return result;
}


export async function fillFocusedField(tabId, frameId, value) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: frameTarget(tabId, frameId),
    args: ["fill", value],
    func: runFieldOperation,
  });
  return result;
}


// Anchors a small rotating SVG spinner to the focused field so the user
// gets visual confirmation that a fill turn is running. Mirrors the chat
// CountdownRing geometry (r=5.5, viewBox 14×14) at field-sized scale.
export async function showFillSpinner(tabId, frameId) {
  try {
    await chrome.scripting.insertCSS({
      target: frameTarget(tabId, frameId),
      css: `
        #jarela-fill-spinner { position: fixed; z-index: 2147483647; pointer-events: none;
          width: 18px; height: 18px; border-radius: 50%;
          background: rgba(15, 23, 42, 0.92); box-shadow: 0 1px 4px rgba(0,0,0,0.4);
          display: flex; align-items: center; justify-content: center; }
        #jarela-fill-spinner svg { width: 14px; height: 14px; animation: jarela-fill-spin 1s linear infinite; }
        #jarela-fill-spinner circle { fill: none; stroke: #818cf8; stroke-width: 1.5;
          stroke-linecap: round; stroke-dasharray: 8.6 26; }
        @keyframes jarela-fill-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { #jarela-fill-spinner svg { animation: none; } }
      `,
    });
    await chrome.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      args: ["show"],
      func: runFieldOperation,
    });
  } catch (err) {
    console.warn("[jarela] showFillSpinner failed:", err);
  }
}


export async function hideFillSpinner(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: frameTarget(tabId, frameId),
      args: ["hide"],
      func: runFieldOperation,
    });
  } catch {
    // Tab may have navigated away — nothing to clean up.
  }
}
