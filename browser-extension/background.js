// Service worker — heartbeat + toolbar-icon state machine + click router.
//
// MV3 service workers get killed after ~30s idle. We use chrome.alarms to
// revive ourselves on a 15s cadence; each tick pings GET /api/v1/health
// and updates the action icon + tooltip accordingly. State lives in a
// SW-local var; if the SW is killed mid-cycle the next alarm tick simply
// re-evaluates from a fresh fetch.

import {
  STORAGE_KEY,
  DEFAULT_CONFIG,
  parseConfig,
  healthUrl,
  captureUrl,
  extensionRefineUrl,
  extensionFillUrl,
  extensionTurnUrl,
  extensionAgentsUrl,
  buildBase,
} from "./lib/config.mjs";

const ALARM_NAME = "jarela-health";
const HEALTH_INTERVAL_MIN = 0.25; // 15s
const HEALTH_TIMEOUT_MS = 2000;
const STORAGE_SELECTED_AGENT_ID = "jarelaSelectedAgentId";
const MENU_FILL_FIELD = "jarela-fill-field";
const MENU_REWRITE_PARENT = "jarela-rewrite-parent";
const MENU_REWRITE_PREFIX = "jarela-rewrite-";
const REWRITE_DIRECTIONS = {
  neutral: "Rewrite the selected text to improve clarity while preserving meaning.",
  concise: "Rewrite the selected text to be concise while preserving meaning.",
  formal: "Rewrite the selected text in a formal, polished tone while preserving meaning.",
  friendly: "Rewrite the selected text in a friendly, approachable tone while preserving meaning.",
  technical: "Rewrite the selected text with technical precision and explicit details while preserving meaning.",
};
const REWRITE_DIRECTION_LABELS = {
  neutral: "Rewrite direction: neutral",
  concise: "Rewrite direction: concise",
  formal: "Rewrite direction: formal",
  friendly: "Rewrite direction: friendly",
  technical: "Rewrite direction: technical",
};

let currentAgentIconKey = "auto"; // auto | blue | white

async function ensureContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch {
    // Ignore cleanup errors.
  }
  try {
    await chrome.contextMenus.create({
      id: MENU_FILL_FIELD,
      title: "Jarela: fill focused field",
      contexts: ["editable", "selection"],
    });
    await chrome.contextMenus.create({
      id: MENU_REWRITE_PARENT,
      title: "Jarela: rewrite selection to clipboard",
      contexts: ["selection"],
    });
    for (const key of Object.keys(REWRITE_DIRECTIONS)) {
      await chrome.contextMenus.create({
        id: `${MENU_REWRITE_PREFIX}${key}`,
        parentId: MENU_REWRITE_PARENT,
        title: REWRITE_DIRECTION_LABELS[key] ?? key,
        contexts: ["selection"],
      });
    }
  } catch (err) {
    console.warn("[jarela] failed to create context menu:", err);
  }
}

// Cached config — refreshed from chrome.storage on each tick and whenever
// the user saves new values via the options page.
let currentConfig = { ...DEFAULT_CONFIG };

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    currentConfig = parseConfig(stored?.[STORAGE_KEY]);
  } catch {
    currentConfig = { ...DEFAULT_CONFIG };
  }
  return currentConfig;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  currentConfig = parseConfig(changes[STORAGE_KEY].newValue);
  // Re-evaluate health immediately so the icon reflects the new target.
  void tickHealth();
});

let lastHealthy = false;

function normalizeAgentIconKey(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "blue" || v === "white" || v === "auto") return v;
  return null;
}

async function detectPrefersDarkFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return false;
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Boolean(globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches),
    });
    return Boolean(result);
  } catch {
    return false;
  }
}

function pickIconStem(prefersDark) {
  if (currentAgentIconKey === "white") return "icon-white";
  if (currentAgentIconKey === "blue") return "icon";
  return prefersDark ? "icon-white" : "icon";
}

async function applyAgentIconHintFromBody(body) {
  const key = normalizeAgentIconKey(body?.agent_icon_key);
  if (!key) return;
  currentAgentIconKey = key;
  await applyHealthState(lastHealthy);
}

async function checkHealth() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(healthUrl(currentConfig), { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function applyHealthState(healthy) {
  lastHealthy = healthy;
  const prefersDark = await detectPrefersDarkFromActiveTab();
  const stem = pickIconStem(prefersDark);
  const suffix = healthy ? "" : "-disabled";
  await chrome.action.setIcon({
    path: {
      16: `icons/${stem}-16${suffix}.png`,
      32: `icons/${stem}-32${suffix}.png`,
      128: `icons/${stem}-128${suffix}.png`,
    },
  });
  const where = buildBase(currentConfig);
  await chrome.action.setTitle({
    title: healthy
      ? `Capture an element to Jarela (${where})`
      : `Jarela isn't reachable at ${where} — click to open settings`,
  });
}

async function tickHealth() {
  await loadConfig();
  const ok = await checkHealth();
  await applyHealthState(ok);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: HEALTH_INTERVAL_MIN });
  void ensureContextMenus();
  void tickHealth();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: HEALTH_INTERVAL_MIN });
  void ensureContextMenus();
  void tickHealth();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void tickHealth();
});

chrome.tabs.onActivated.addListener(() => {
  void applyHealthState(lastHealthy);
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete") void applyHealthState(lastHealthy);
});

async function startPickerInTab(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["content.css"],
  });
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  return { ok: res.ok, status: res.status, body: json };
}

async function getJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { error: text }; }
  return { ok: res.ok, status: res.status, body: json };
}

async function listAgentsCompat() {
  const primary = await getJson(extensionAgentsUrl(currentConfig));
  if (primary?.ok) return primary;

  const fallback = await getJson(`${buildBase(currentConfig)}/api/v1/agents`);
  if (!fallback?.ok) return primary;

  const list = Array.isArray(fallback.body) ? fallback.body : [];
  const agents = list.map((a) => {
    const iconRaw = typeof a?.icon === "string" ? a.icon.trim().toLowerCase() : "";
    const icon_key = iconRaw === "bundle:white" || iconRaw === "white"
      ? "white"
      : iconRaw === "bundle:blue" || iconRaw === "blue"
        ? "blue"
        : null;
    return {
      id: a?.id,
      name: a?.name,
      icon: typeof a?.icon === "string" ? a.icon : null,
      icon_key,
      is_default: Boolean(a?.is_default),
    };
  }).filter((a) => typeof a.id === "string" && a.id.length > 0 && typeof a.name === "string");

  const defaultAgent = agents.find((a) => a.is_default) ?? null;
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      default_agent_id: defaultAgent?.id ?? null,
      agents,
      fallback_from: "v1_agents",
    },
  };
}

async function getSelectedAgentId() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_SELECTED_AGENT_ID);
    const v = stored?.[STORAGE_SELECTED_AGENT_ID];
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function setSelectedAgentId(agentId) {
  if (typeof agentId === "string" && agentId.trim().length > 0) {
    await chrome.storage.local.set({ [STORAGE_SELECTED_AGENT_ID]: agentId.trim() });
    return;
  }
  await chrome.storage.local.remove(STORAGE_SELECTED_AGENT_ID);
}

async function withSelectedAgent(payload) {
  const selected = await getSelectedAgentId();
  if (!selected) return payload;
  const existing = typeof payload?.agent_id === "string" ? payload.agent_id.trim() : "";
  if (existing.length > 0) return payload;
  return { ...(payload ?? {}), agent_id: selected };
}

async function collectPageInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function normalize(v, max = 4000) {
        return (v || "").replace(/\s+/g, " ").trim().slice(0, max);
      }

      const h1 = normalize(document.querySelector("h1")?.textContent || "", 300);
      const h2 = normalize(document.querySelector("h2")?.textContent || "", 300);
      const description = normalize(
        document.querySelector('meta[name="description"]')?.getAttribute("content") || "",
        400,
      );

      // Pull a snippet around the user's selection so the rewrite turn
      // knows what came before/after the highlighted span. We anchor on
      // the nearest block-level ancestor of the selection's start node so
      // a one-sentence selection still carries paragraph-level context.
      let surrounding = "";
      let beforeSnippet = "";
      let afterSnippet = "";
      try {
        const sel = window.getSelection?.();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0);
          let node = range.startContainer;
          if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
          const BLOCK = /^(P|LI|TD|TH|BLOCKQUOTE|ARTICLE|SECTION|DIV|MAIN|H[1-6])$/;
          let block = node;
          while (block && block !== document.body && !BLOCK.test(block.tagName || "")) {
            block = block.parentElement;
          }
          block = block || node;
          const full = (block?.innerText || "").replace(/\s+/g, " ").trim();
          const selText = sel.toString().replace(/\s+/g, " ").trim();
          if (full && selText) {
            const idx = full.indexOf(selText);
            if (idx >= 0) {
              beforeSnippet = full.slice(Math.max(0, idx - 600), idx).trim();
              afterSnippet = full.slice(idx + selText.length, idx + selText.length + 600).trim();
            } else {
              surrounding = full.slice(0, 1200);
            }
          } else if (full) {
            surrounding = full.slice(0, 1200);
          }
        }
      } catch {
        // Selection inspection is best-effort; fall back to metadata only.
      }

      const contextLines = [
        `Host: ${location.host}`,
        h1 ? `Main heading: ${h1}` : "",
        h2 ? `Secondary heading: ${h2}` : "",
        description ? `Meta description: ${description}` : "",
        beforeSnippet ? `Text before selection:\n${beforeSnippet}` : "",
        afterSnippet ? `Text after selection:\n${afterSnippet}` : "",
        surrounding ? `Surrounding block:\n${surrounding}` : "",
      ].filter(Boolean);

      return {
        url: location.href,
        title: document.title,
        page_context: contextLines.join("\n"),
      };
    },
  });
  return result;
}

async function copyTextToClipboard(tabId, text) {
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

// Resolves the focused editable across shadow DOM + same-origin iframes
// and stamps it with `data-jarela-fill-target` so the rest of the fill
// flow can find it again after the LLM round-trip — even if the page
// (e.g. LinkedIn's post composer dialog) shifts focus in the meantime.
// Returns `{ ok, frameId }` for the frame that owns the marker so we can
// scope subsequent injections to it.
async function markFillTarget(tabId, hintFrameId) {
  const target = typeof hintFrameId === "number"
    ? { tabId, frameIds: [hintFrameId] }
    : { tabId, allFrames: true };
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target,
      func: () => {
        function dig(root) {
          let el = root?.activeElement || null;
          while (el && el.shadowRoot && el.shadowRoot.activeElement) {
            el = el.shadowRoot.activeElement;
          }
          return el;
        }
        function isEditable(el) {
          if (!el) return false;
          if (el instanceof HTMLTextAreaElement) return true;
          if (el instanceof HTMLInputElement) {
            return /^(text|search|email|url|tel)$/i.test(el.type || "text");
          }
          return Boolean(el.isContentEditable);
        }
        let el = dig(document);
        // Drill through nested same-origin iframes when activeElement is one.
        while (el && el.tagName === "IFRAME") {
          try {
            const doc = el.contentDocument;
            if (!doc) break;
            const inner = dig(doc);
            if (!inner) break;
            el = inner;
          } catch {
            break;
          }
        }
        // Walk up to find a contenteditable ancestor when activeElement is
        // a non-editable child (common with rich editors like Quill).
        if (el && !isEditable(el) && typeof el.closest === "function") {
          const ce = el.closest("[contenteditable=''], [contenteditable='true']");
          if (ce) el = ce;
        }
        // Last-resort fallback: pick the first editable inside an open
        // dialog (LinkedIn's post composer renders as role=dialog with
        // exactly one ql-editor).
        if (!isEditable(el)) {
          const dialog = document.querySelector("[role='dialog'], dialog[open]");
          if (dialog) {
            el = dialog.querySelector(
              "textarea, input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], [contenteditable=''], [contenteditable='true']",
            );
          }
        }
        if (!isEditable(el)) return { ok: false };
        document.querySelectorAll("[data-jarela-fill-target]").forEach((n) => {
          n.removeAttribute("data-jarela-fill-target");
        });
        el.setAttribute("data-jarela-fill-target", "1");
        return { ok: true };
      },
    });
  } catch {
    return { ok: false };
  }
  const winner = (results || []).find((r) => r?.result?.ok);
  return winner ? { ok: true, frameId: winner.frameId ?? 0 } : { ok: false };
}

async function clearFillTarget(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
      func: () => {
        document.querySelectorAll("[data-jarela-fill-target]").forEach((n) => {
          n.removeAttribute("data-jarela-fill-target");
        });
      },
    });
  } catch {
    // Tab/frame may be gone — nothing to clean up.
  }
}

async function getFillContext(tabId, frameId, selectionOverride) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
    args: [selectionOverride ?? ""],
    func: (selectedTextOverride) => {
      function normalizeText(v, max = 5000) {
        return (v || "").replace(/\s+/g, " ").trim().slice(0, max);
      }

      const marked = document.querySelector("[data-jarela-fill-target]");
      const active = marked || document.activeElement;
      const isTextarea = active instanceof HTMLTextAreaElement;
      const isTextInput = active instanceof HTMLInputElement && /^(text|search|email|url|tel)$/i.test(active.type || "text");
      const isEditable = Boolean(active && (isTextarea || isTextInput || active.isContentEditable));
      const target = isEditable ? active : null;

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

      let around = "";
      let targetInfo = "";
      if (target) {
        const root = target.closest("form") || target.parentElement || target;
        const label = target.id
          ? document.querySelector(`label[for="${CSS.escape(target.id)}"]`)?.textContent
          : target.closest("label")?.textContent;
        const placeholder = "placeholder" in target ? String(target.placeholder || "") : "";
        const name = "name" in target ? String(target.name || "") : "";
        const aria = target.getAttribute?.("aria-label") || "";
        const nearbyText = normalizeText(root?.innerText || "", 4000);
        around = nearbyText;
        targetInfo = [
          `Field label: ${normalizeText(label || "", 200)}`,
          `Field name: ${normalizeText(name, 120)}`,
          `Field placeholder: ${normalizeText(placeholder, 200)}`,
          `Field aria-label: ${normalizeText(aria, 200)}`,
        ].filter((line) => !line.endsWith(": ")).join("\n");
      }

      const pageContext = [
        `Host: ${location.host}`,
        h1 ? `Main heading: ${h1}` : "",
        h2 ? `Secondary heading: ${h2}` : "",
        meta ? `Meta description: ${meta}` : "",
        targetInfo,
        around ? `Nearby section text:\n${around}` : "",
      ].filter(Boolean).join("\n");

      const text = selectedText || normalizeText(document.body?.innerText || "", 5000);
      return { url, title, text, page_context: pageContext, has_target: Boolean(target) };
    },
  });
  return result;
}

async function fillFocusedField(tabId, frameId, value) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
    args: [value],
    func: (nextText) => {
      const marked = document.querySelector("[data-jarela-fill-target]");
      const active = marked || document.activeElement;
      if (!active) return { ok: false, reason: "No focused field" };

      if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && /^(text|search|email|url|tel)$/i.test(active.type || "text"))) {
        active.focus();
        const start = Number(active.selectionStart ?? active.value.length);
        const end = Number(active.selectionEnd ?? active.value.length);
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
        // Place caret at end of the editable before inserting so frameworks
        // like Quill don't drop the text into a stale selection range.
        try {
          const range = document.createRange();
          range.selectNodeContents(active);
          range.collapse(false);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {
          // Selection APIs throw inside detached frames; fall through to insertText.
        }
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
    },
  });
  return result;
}

// Anchors a small rotating SVG spinner to the focused field so the user
// gets visual confirmation that a fill turn is running. Mirrors the chat
// CountdownRing geometry (r=5.5, viewBox 14×14) at field-sized scale.
async function showFillSpinner(tabId, frameId) {
  try {
    await chrome.scripting.insertCSS({
      target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
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
      target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
      func: () => {
        const marked = document.querySelector("[data-jarela-fill-target]");
        const active = marked || document.activeElement;
        if (!active || typeof active.getBoundingClientRect !== "function") return;
        const rect = active.getBoundingClientRect();
        document.getElementById("jarela-fill-spinner")?.remove();
        const el = document.createElement("div");
        el.id = "jarela-fill-spinner";
        el.innerHTML = '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5"/></svg>';
        el.style.top = `${Math.max(2, rect.top + 4)}px`;
        el.style.left = `${Math.max(2, rect.right - 22)}px`;
        document.body.appendChild(el);
      },
    });
  } catch (err) {
    console.warn("[jarela] showFillSpinner failed:", err);
  }
}

async function hideFillSpinner(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
      func: () => { document.getElementById("jarela-fill-spinner")?.remove(); },
    });
  } catch {
    // Tab may have navigated away — nothing to clean up.
  }
}

async function runRewriteToClipboard(tabId, selectionText, instruction) {
  const selected = (selectionText ?? "").trim();
  if (!selected) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Nothing selected",
      message: "Select text first, then use a Jarela rewrite option.",
      priority: 1,
    });
    return;
  }

  const page = await collectPageInfo(tabId);
  const payload = await withSelectedAgent({
    action: "rewrite_clipboard",
    instruction,
    text: selected,
    url: page?.url,
    title: page?.title,
    page_context: page?.page_context,
  });
  const apiRes = await postJson(extensionTurnUrl(currentConfig), payload);
  await applyAgentIconHintFromBody(apiRes?.body);

  if (!apiRes?.ok) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Rewrite failed",
      message: apiRes?.body?.error ?? `HTTP ${apiRes?.status ?? "?"}`,
      priority: 1,
    });
    return;
  }

  const out = String(apiRes.body?.assistant ?? "").trim();
  if (!out) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Rewrite failed",
      message: "The agent returned no content to copy.",
      priority: 1,
    });
    return;
  }

  const copied = await copyTextToClipboard(tabId, out);
  await chrome.notifications.create({
    type: "basic",
    iconUrl: copied ? "icons/icon-128.png" : "icons/icon-128-disabled.png",
    title: copied ? "Rewritten text copied" : "Rewrite complete",
    message: copied
      ? "The rewritten result is now in your clipboard."
      : "Clipboard write failed, but the rewrite was generated.",
    priority: 1,
  });
}

async function runFillFocusedField(tabId, selectionText, hintFrameId) {
  const marker = await markFillTarget(tabId, hintFrameId);
  if (!marker.ok) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "No focused field",
      message: "Click into an input/textarea first, then run Fill focused field.",
      priority: 1,
    });
    return;
  }
  const frameId = marker.frameId;

  const ctx = await getFillContext(tabId, frameId, selectionText);
  if (!ctx?.has_target) {
    await clearFillTarget(tabId, frameId);
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "No focused field",
      message: "Click into an input/textarea first, then run Fill focused field.",
      priority: 1,
    });
    return;
  }

  // Mirror the chat-window CountdownRing on the focused field so the user
  // sees the request is in flight — same drain + spin SVG anchored to the
  // field's bounding rect, removed in finally so errors don't leak it.
  await showFillSpinner(tabId, frameId);

  try {
    const payload = await withSelectedAgent({
      action: "fill",
      instruction: "Fill the currently focused field using page/form context and any selected text. Return only the final field text.",
      url: ctx.url,
      title: ctx.title,
      text: ctx.text,
      page_context: ctx.page_context,
    });
    const apiRes = await postJson(extensionTurnUrl(currentConfig), payload);
    await applyAgentIconHintFromBody(apiRes?.body);

    if (!apiRes?.ok) {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Fill failed",
        message: apiRes?.body?.error ?? `HTTP ${apiRes?.status ?? "?"}`,
        priority: 1,
      });
      return;
    }

    const out = String(apiRes.body?.assistant ?? "").trim();
    if (!out) {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Fill failed",
        message: "The agent returned no content to insert.",
        priority: 1,
      });
      return;
    }

    const applied = await fillFocusedField(tabId, frameId, out);
    await chrome.notifications.create({
      type: "basic",
      iconUrl: applied?.ok ? "icons/icon-128.png" : "icons/icon-128-disabled.png",
      title: applied?.ok ? "Field filled" : "Fill generated",
      message: applied?.ok
        ? "The focused field was filled with the generated text."
        : `Could not apply text automatically: ${applied?.reason ?? "unknown reason"}`,
      priority: 1,
    });
  } finally {
    await hideFillSpinner(tabId, frameId);
    await clearFillTarget(tabId, frameId);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;

  (async () => {
    if (info.menuItemId === MENU_FILL_FIELD) {
      await runFillFocusedField(tab.id, info.selectionText ?? "", info.frameId);
      return;
    }
    if (typeof info.menuItemId === "string" && info.menuItemId.startsWith(MENU_REWRITE_PREFIX)) {
      const direction = info.menuItemId.slice(MENU_REWRITE_PREFIX.length);
      const instruction = REWRITE_DIRECTIONS[direction];
      if (!instruction) return;
      await runRewriteToClipboard(tab.id, info.selectionText ?? "", instruction);
      return;
    }
  })().catch((err) => {
    console.warn("[jarela] context menu action failed:", err);
  });
});

// Toolbar click → enter picker mode in the active tab. If Jarela isn't
// reachable, open the options page so the user can fix the port (and tell
// them why — silence is bad UX when they asked something to happen).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  // Re-check health right now in case the SW just woke up.
  const healthyNow = await checkHealth();
  await applyHealthState(healthyNow);
  if (!healthyNow) {
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128-disabled.png",
        title: `Can't reach Jarela`,
        message: `${buildBase(currentConfig)} didn't respond. Opening settings — confirm the host and port, or start the Jarela server.`,
        priority: 1,
      });
    } catch { /* notifications optional */ }
    try {
      await chrome.runtime.openOptionsPage();
    } catch (err) {
      console.warn("[jarela] failed to open options page:", err);
    }
    return;
  }
  try {
    await startPickerInTab(tab.id);
  } catch (err) {
    // Most common: the page disallows content scripts (chrome://, web store).
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title: "Can't capture this page",
        message: "Chrome blocks content scripts on this URL. Try a regular http(s) page.",
        priority: 1,
      });
    } catch { /* */ }
    console.warn("[jarela] picker injection failed:", err);
  }
});

// Content script POSTs through the service worker so it can use the host
// permissions granted to this extension (content scripts share the page
// origin and would hit CORS without manifest host_permissions; routing
// through the SW sidesteps that and centralises the URL).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;
  (async () => {
    try {
      if (msg.type === "jarela-start-picker") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, status: 0, body: { error: "No active tab" } });
          return;
        }
        await startPickerInTab(tab.id);
        sendResponse({ ok: true, status: 200, body: { started: true } });
        return;
      }
      if (msg.type === "jarela-capture") {
        const out = await postJson(captureUrl(currentConfig), msg.payload);
        await applyAgentIconHintFromBody(out?.body);
        sendResponse(out);
        return;
      }
      if (msg.type === "jarela-refine") {
        const payload = await withSelectedAgent(msg.payload);
        const out = await postJson(extensionRefineUrl(currentConfig), payload);
        await applyAgentIconHintFromBody(out?.body);
        sendResponse(out);
        return;
      }
      if (msg.type === "jarela-fill") {
        const payload = await withSelectedAgent(msg.payload);
        const out = await postJson(extensionFillUrl(currentConfig), payload);
        await applyAgentIconHintFromBody(out?.body);
        sendResponse(out);
        return;
      }
      if (msg.type === "jarela-turn") {
        const payload = await withSelectedAgent(msg.payload);
        const out = await postJson(extensionTurnUrl(currentConfig), payload);
        await applyAgentIconHintFromBody(out?.body);
        sendResponse(out);
        return;
      }
      if (msg.type === "jarela-list-agents") {
        sendResponse(await listAgentsCompat());
        return;
      }
      if (msg.type === "jarela-get-agent") {
        sendResponse({ ok: true, status: 200, body: { agent_id: await getSelectedAgentId() } });
        return;
      }
      if (msg.type === "jarela-set-agent") {
        await setSelectedAgentId(msg.payload?.agent_id ?? null);
        sendResponse({ ok: true, status: 200, body: { saved: true } });
        return;
      }
      if (msg.type === "jarela-open-sidepanel") {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) {
          sendResponse({ ok: false, status: 0, body: { error: "No active tab" } });
          return;
        }
        await chrome.sidePanel.setOptions({
          tabId: tab.id,
          path: "panel.html",
          enabled: true,
        });
        await chrome.sidePanel.open({ tabId: tab.id });
        sendResponse({ ok: true, status: 200, body: { opened: true } });
        return;
      }
      sendResponse({ ok: false, status: 0, body: { error: `Unknown message type: ${msg.type}` } });
    } catch (err) {
      sendResponse({ ok: false, status: 0, body: { error: String(err) } });
    }
  })();
  return true; // async response
});
