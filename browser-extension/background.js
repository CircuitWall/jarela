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
const MENU_FILL_FIELD_CUSTOM = "jarela-fill-field-custom";
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
      id: MENU_FILL_FIELD_CUSTOM,
      title: "Jarela: fill focused field with custom intent…",
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
        document.querySelectorAll("[data-jarela-fill-caret]").forEach((n) => n.remove());
        el.setAttribute("data-jarela-fill-target", "1");

        // Capture caret position NOW, while focus is still on the field.
        // The context menu + spinner + LLM round-trip all blur the field,
        // and by fill-time selectionStart/End on inputs has reset to
        // value.length and contentEditable selection has collapsed. We
        // need to remember where the user actually was.
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
          const s = Number(el.selectionStart ?? el.value.length);
          const e = Number(el.selectionEnd ?? el.value.length);
          el.dataset.jarelaFillStart = String(s);
          el.dataset.jarelaFillEnd = String(e);
        } else if (el.isContentEditable) {
          try {
            const doc = el.ownerDocument || document;
            const win = doc.defaultView || window;
            const sel = win.getSelection?.();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              if (el.contains(range.startContainer)) {
                const marker = doc.createElement("span");
                marker.setAttribute("data-jarela-fill-caret", "1");
                marker.style.cssText = "display:inline-block;width:0;height:0;font-size:0;line-height:0;color:transparent;";
                marker.textContent = "\u200B";
                // Insert at the range's start so the caret lands here
                // even if the range was a selection (we collapse later).
                const insertRange = range.cloneRange();
                insertRange.collapse(true);
                insertRange.insertNode(marker);
              }
            }
          } catch {
            // Best-effort — fall back to end-of-field insertion.
          }
        }
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
          delete n.dataset?.jarelaFillStart;
          delete n.dataset?.jarelaFillEnd;
        });
        document.querySelectorAll("[data-jarela-fill-caret]").forEach((n) => n.remove());
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
        // Restore the caret to the marker dropped at mark time so we
        // insert where the user was, not at the end of the field.
        const marker = active.querySelector("[data-jarela-fill-caret]");
        try {
          const sel = window.getSelection();
          const range = document.createRange();
          if (marker) {
            range.setStartBefore(marker);
            range.setEndBefore(marker);
            marker.remove();
          } else {
            // No marker captured (e.g. shadow-root host or detached frame).
            // Fall back to end-of-field so we at least insert *something*.
            range.selectNodeContents(active);
            range.collapse(false);
          }
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

  // No page-context collection for rewrite: the selection is the input.
  // Bundling URL/headings/surrounding text encourages the model to echo
  // the page H1 instead of rewriting the selection.
  const payload = await withSelectedAgent({
    action: "rewrite_clipboard",
    instruction,
    text: selected,
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
      instruction: [
        "Fill the focused field with text the user would plausibly put there.",
        "page_context gives you Field kind (heuristic guess) + raw HTML signals",
        "(tag, type, maxlength, label, placeholder, aria-label, host).",
        "If Field kind is missing or wrong, infer it from Host, URL, title/",
        "headings/meta and the raw signals (gmail/outlook -> email; github",
        "pull/issue -> code review or issue comment; x/linkedin -> social",
        "post with platform length norms; jira/linear/asana -> ticket",
        "comment; banking/billing -> short factual, no smalltalk).",
        "Match that kind's conventions: search/form = bare keywords, respect",
        "maxlength; email reply = greeting + substantive body + sign-off;",
        "comment/forum = terse on-topic, no greeting; chat/social = short,",
        "no sign-off, respect length caps (e.g. <=280 for X); title/subject",
        "= one line.",
        "For long-form bodies, read the page text and write a real reply",
        "addressing the visible thread/item/form; skip chrome (nav, ads,",
        "sidebars, unrelated previews). Don't stop at a generic greeting.",
        "Write in the SAME LANGUAGE as the surrounding context, not this",
        "instruction. Only fall back to English if the context language is",
        "genuinely unclear.",
        "Return ONLY the final text to insert: no preamble, quotes, markdown",
        "fencing, or explanation.",
      ].join(" "),
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

// Centered modal injected into the page asking the user what they want to
// say. Resolves to the typed string, or null if they cancel / press Esc.
// The modal lives outside the page's own DOM concerns: high z-index,
// scrollable, dismissed on backdrop click. We don't use chrome.windows
// because a popup loses tab focus (and Gmail blurs the reply box).
async function promptForCustomIntent(tabId, frameId, defaultText) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
    args: [defaultText || ""],
    func: (initial) => new Promise((resolve) => {
      document.getElementById("jarela-fill-custom-modal")?.remove();

      const backdrop = document.createElement("div");
      backdrop.id = "jarela-fill-custom-modal";
      backdrop.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "background:rgba(15,23,42,0.55)",
        "display:flex", "align-items:center", "justify-content:center",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      ].join(";");

      const dialog = document.createElement("div");
      dialog.style.cssText = [
        "background:#fff", "color:#0f172a",
        "border-radius:12px", "padding:20px",
        "width:min(560px,92vw)",
        "box-shadow:0 20px 50px rgba(0,0,0,0.35)",
        "display:flex", "flex-direction:column", "gap:12px",
      ].join(";");

      const heading = document.createElement("div");
      heading.textContent = "What would you like to say?";
      heading.style.cssText = "font-size:15px;font-weight:600;";

      const subheading = document.createElement("div");
      subheading.textContent = "Jarela will polish your wording into a reply that fits the surrounding context (tone, language, length).";
      subheading.style.cssText = "font-size:12px;color:#475569;line-height:1.4;";

      const textarea = document.createElement("textarea");
      textarea.value = initial;
      textarea.placeholder = "e.g. accept the meeting, ask for a Monday slot instead";
      textarea.rows = 5;
      textarea.style.cssText = [
        "width:100%", "box-sizing:border-box",
        "padding:10px 12px", "font-size:14px", "line-height:1.45",
        "border:1px solid #cbd5e1", "border-radius:8px",
        "resize:vertical", "min-height:96px",
        "font-family:inherit", "color:#0f172a", "background:#fff",
        "outline:none",
      ].join(";");

      const buttons = document.createElement("div");
      buttons.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText = [
        "padding:8px 14px", "font-size:13px", "border-radius:8px",
        "border:1px solid #cbd5e1", "background:#fff", "color:#0f172a",
        "cursor:pointer",
      ].join(";");

      const submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = "Polish & fill";
      submit.style.cssText = [
        "padding:8px 14px", "font-size:13px", "border-radius:8px",
        "border:1px solid #4f46e5", "background:#4f46e5", "color:#fff",
        "cursor:pointer", "font-weight:600",
      ].join(";");

      function cleanup(value) {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          e.stopPropagation();
          cleanup(null);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.stopPropagation();
          cleanup(textarea.value.trim() || null);
        }
      }
      cancel.addEventListener("click", () => cleanup(null));
      submit.addEventListener("click", () => cleanup(textarea.value.trim() || null));
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(null); });
      document.addEventListener("keydown", onKey, true);

      buttons.appendChild(cancel);
      buttons.appendChild(submit);
      dialog.appendChild(heading);
      dialog.appendChild(subheading);
      dialog.appendChild(textarea);
      dialog.appendChild(buttons);
      backdrop.appendChild(dialog);
      document.documentElement.appendChild(backdrop);
      setTimeout(() => textarea.focus(), 0);
    }),
  });
  return typeof result === "string" ? result : null;
}

async function runFillFocusedFieldCustom(tabId, selectionText, hintFrameId) {
  const marker = await markFillTarget(tabId, hintFrameId);
  if (!marker.ok) {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "No focused field",
      message: "Click into an input/textarea first, then run Fill with custom intent.",
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
      message: "Click into an input/textarea first, then run Fill with custom intent.",
      priority: 1,
    });
    return;
  }

  const intent = await promptForCustomIntent(tabId, frameId, "");
  if (!intent) {
    await clearFillTarget(tabId, frameId);
    return;
  }

  await showFillSpinner(tabId, frameId);
  try {
    const payload = await withSelectedAgent({
      action: "fill",
      instruction: [
        `User intent: "${intent.replace(/"/g, '\\"')}".`,
        "Polish that intent into the final text for the focused field.",
        "The intent is the message; the surrounding page is the situation",
        "(tone, language, length, greeting/sign-off).",
        "page_context gives you Field kind (heuristic guess) + raw HTML",
        "signals (tag, type, maxlength, label, placeholder, aria-label,",
        "host). If Field kind is missing or wrong, infer it from Host,",
        "URL, title/headings/meta and the raw signals (gmail/outlook ->",
        "email; github -> code review/issue comment; x/linkedin -> social",
        "post with length norms; jira/linear/asana -> ticket; banking ->",
        "short factual). Match that kind: email = greeting + sign-off;",
        "chat = terse no sign-off; comment = on-topic no greeting; search",
        "= bare keywords; short field = respect maxlength.",
        "Write in the SAME LANGUAGE as the surrounding context, not this",
        "instruction nor necessarily the intent. Only keep the intent's",
        "language when the context language is genuinely unclear.",
        "Faithfully convey the intent: no new content, no commitments or",
        "facts the user didn't ask for, no softening a refusal into",
        "agreement. You may expand a one-liner into greeting + body +",
        "sign-off when the context calls for it, but the substance stays",
        "the user's.",
        "Return ONLY the final text to insert: no preamble, quotes,",
        "markdown fencing, or explanation.",
      ].join(" "),
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
        ? "The focused field was filled with the polished text."
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
    if (info.menuItemId === MENU_FILL_FIELD_CUSTOM) {
      await runFillFocusedFieldCustom(tab.id, info.selectionText ?? "", info.frameId);
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

// Keyboard shortcuts — for hosts that hijack the right-click menu (Outlook
// PWA, some Office apps, sites with custom context menus). Bindings are
// declared in manifest.json under "commands"; users can rebind them at
// chrome://extensions/shortcuts.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;
  (async () => {
    if (command === "fill-focused-field") {
      await runFillFocusedField(tab.id, "", undefined);
      return;
    }
    if (command === "fill-focused-field-custom") {
      await runFillFocusedFieldCustom(tab.id, "", undefined);
      return;
    }
  })().catch((err) => {
    console.warn("[jarela] keyboard command failed:", err);
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
