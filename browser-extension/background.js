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
  allowedSitesUrl,
  allowedSiteHostUrl,
  browserPollUrl,
  browserResultUrl,
  buildBase,
} from "./lib/config.mjs";
import { dispatchCommand } from "./lib/browser-control.mjs";
import { gateCommand, setApproval } from "./lib/approvals.mjs";

const ALARM_NAME = "jarela-health";
const BROWSER_POLL_ALARM_NAME = "jarela-browser-poll";
const HEALTH_INTERVAL_MIN = 0.25; // 15s
const HEALTH_TIMEOUT_MS = 2000;
const STORAGE_SELECTED_AGENT_ID = "jarelaSelectedAgentId";
const MENU_OPEN = "jarela-open";
const REWRITE_DIRECTIONS = {
  neutral: "Rewrite the selected text to improve clarity while preserving meaning.",
  concise: "Rewrite the selected text to be concise while preserving meaning.",
  formal: "Rewrite the selected text in a formal, polished tone while preserving meaning.",
  friendly: "Rewrite the selected text in a friendly, approachable tone while preserving meaning.",
  technical: "Rewrite the selected text with technical precision and explicit details while preserving meaning.",
};
const REWRITE_PRESETS = [
  { key: "neutral", label: "Improve clarity" },
  { key: "concise", label: "Make it concise" },
  { key: "formal", label: "Make it formal" },
  { key: "friendly", label: "Make it friendly" },
  { key: "technical", label: "Make it technical" },
];

let currentAgentIconKey = "auto"; // auto | blue | white

async function ensureContextMenus() {
  try {
    await chrome.contextMenus.removeAll();
  } catch {
    // Ignore cleanup errors.
  }
  try {
    await chrome.contextMenus.create({
      id: MENU_OPEN,
      title: "Jarela: fill or rewrite…",
      contexts: ["editable", "selection"],
    });
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
  const wasHealthy = lastHealthy;
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
  if (healthy && !wasHealthy) resumeBrowserPollLoop();
}

async function tickHealth() {
  await loadConfig();
  const ok = await checkHealth();
  await applyHealthState(ok);
  // Cookie watcher rides the same heartbeat — refresh the allow-list
  // cache from the server whenever we already know we can talk to it.
  if (ok) void refreshAllowedSites();
}

// ---------------------------------------------------------------------------
// Cookie passthrough — sync browser cookies for allow-listed hosts.
// ---------------------------------------------------------------------------
//
// On each health tick we fetch GET /api/v1/allowed-sites and rebuild a
// local Set of approved hostnames. A single chrome.cookies.onChanged
// listener filters events through that Set; on a hit we debounce per-host
// 500ms then snapshot the host's full cookie set via chrome.cookies.getAll
// and PUT it to /api/v1/allowed-sites/<host>. Keeps the server-side cookie
// blob fresh without the user clicking "sync".
//
// chrome.cookies.getAll requires host_permissions for the origin. The
// extension declares optional_host_permissions: ["http://*/*", "https://*/*"]
// which the user grants per host on demand. Until granted, getAll returns
// nothing and the PUT is a no-op — no spam, no error toast.

const COOKIE_DEBOUNCE_MS = 500;
const allowedHosts = new Set();
const cookiePushTimers = new Map();

async function refreshAllowedSites() {
  try {
    const res = await getJson(allowedSitesUrl(currentConfig));
    if (!res.ok || !Array.isArray(res.body?.sites)) return;
    allowedHosts.clear();
    for (const s of res.body.sites) {
      if (s && typeof s.hostname === "string") allowedHosts.add(s.hostname.toLowerCase());
    }
  } catch {
    // Server unreachable — keep the previous cache. The next health tick
    // will retry.
  }
}

// Suffix-match the cookie's domain against the persistent allow-list.
// Mirror of the server-side rule: a request to `foo.bar.example.com`
// matches an entry of `bar.example.com` or `example.com` but not
// `notexample.com`. Returns the matched allow-list hostname (so we PUT
// to the canonical entry, not the cookie's possibly-leading-dot domain).
function matchAllowedHost(cookieDomain) {
  if (typeof cookieDomain !== "string") return null;
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  if (!d) return null;
  if (allowedHosts.has(d)) return d;
  for (const host of allowedHosts) {
    if (d.endsWith("." + host)) return host;
  }
  return null;
}

async function hasCookieAccess(host) {
  try {
    return await chrome.permissions.contains({
      origins: [`https://${host}/*`, `http://${host}/*`],
    });
  } catch {
    return false;
  }
}

async function pushCookiesForHost(host) {
  // chrome.cookies.getAll requires host_permissions for the origin.
  // Without it, getAll returns nothing — indistinguishable from "no
  // cookies set". Gate the push on permissions first so we don't
  // mistakenly clobber the server's blob with an empty array.
  const granted = await hasCookieAccess(host);
  if (!granted) return;
  let cookies;
  try {
    cookies = await chrome.cookies.getAll({ domain: host });
  } catch {
    return;
  }
  const payload = {
    cookies: (cookies ?? []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      // chrome.cookies.Cookie.expirationDate is seconds since epoch;
      // session cookies omit it. Pass through unchanged.
      ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
    })),
  };
  try {
    await fetch(allowedSiteHostUrl(currentConfig, host), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Treat any non-2xx as benign (e.g., 403 if the user just removed
    // the host from the allow-list between our cache refresh and the
    // PUT). The next refreshAllowedSites tick will reconcile.
  } catch {
    // Server unreachable; the next cookie change will retry.
  }
}

function scheduleCookiePush(host) {
  const existing = cookiePushTimers.get(host);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    cookiePushTimers.delete(host);
    void pushCookiesForHost(host);
  }, COOKIE_DEBOUNCE_MS);
  cookiePushTimers.set(host, t);
}

if (chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener((change) => {
    const cookie = change?.cookie;
    if (!cookie) return;
    const matched = matchAllowedHost(cookie.domain);
    if (!matched) return;
    scheduleCookiePush(matched);
  });
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
  if (alarm.name === BROWSER_POLL_ALARM_NAME) void resumeBrowserPollLoop();
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

// Unified capture: in one pass per same-origin frame, find the focused
// editable (and pin it with `data-jarela-fill-target` + dataset offsets
// so we can restore the caret/selection after the LLM round-trip blurs
// the field) AND/OR snapshot the current selection text. Returns:
//   { ok, frameId, hasField, original }
// where `original` is the selected text inside the editable (rewrite
// mode) or the loose page selection (clipboard mode), and is empty for
// pure-fill mode (caret-only). Picks the frame with an editable; falls
// back to the longest selection-only frame.
async function captureField(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
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
          if (el instanceof HTMLInputElement) return /^(text|search|email|url|tel)$/i.test(el.type || "text");
          return Boolean(el.isContentEditable);
        }

        const sel = window.getSelection?.();
        const trimmedSelection = (sel?.toString() || "").trim();

        // Reuse an existing mark if a prior call already pinned the
        // editable in this frame (e.g. the menu has stolen focus).
        let el = document.querySelector("[data-jarela-fill-target]");
        if (!el) {
          el = dig(document);
          if (el && !isEditable(el) && typeof el.closest === "function") {
            const ce = el.closest("[contenteditable=''], [contenteditable='true']");
            if (ce) el = ce;
          }
          if (!isEditable(el)) {
            const dialog = document.querySelector("[role='dialog'], dialog[open]");
            if (dialog) {
              el = dialog.querySelector(
                "textarea, input[type='text'], input[type='search'], input[type='email'], input[type='url'], input[type='tel'], [contenteditable=''], [contenteditable='true']",
              );
            }
          }
        }

        if (!isEditable(el)) {
          // Selection-only state (no field focused in this frame).
          return trimmedSelection ? { hasField: false, original: trimmedSelection } : null;
        }

        // Clear stale marks on siblings, then pin this one.
        document.querySelectorAll("[data-jarela-fill-target]").forEach((n) => {
          if (n !== el) {
            n.removeAttribute("data-jarela-fill-target");
            delete n.dataset?.jarelaFillStart;
            delete n.dataset?.jarelaFillEnd;
            delete n.dataset?.jarelaFillCaretOffset;
            delete n.dataset?.jarelaFillCaretEndOffset;
          }
        });
        document.querySelectorAll("[data-jarela-fill-caret]").forEach((n) => n.remove());
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
      },
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

async function clearFillTarget(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
      func: () => {
        document.querySelectorAll("[data-jarela-fill-target]").forEach((n) => {
          n.removeAttribute("data-jarela-fill-target");
          delete n.dataset?.jarelaFillStart;
          delete n.dataset?.jarelaFillEnd;
          delete n.dataset?.jarelaFillCaretOffset;
          delete n.dataset?.jarelaFillCaretEndOffset;
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

// Prompt templates for the unified write path. Auto-fill (no user
// intent) reads the field/page and drafts something plausible.
// Custom-intent fill polishes the user's wording into a reply that fits
// the surrounding context.
const AUTO_FILL_PROMPT = [
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
].join(" ");

function buildCustomIntentFillPrompt(intent) {
  return [
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
  ].join(" ");
}

// Rewrite instruction = (preset baked direction) + (optional user
// extra direction). Empty + empty = neutral preset.
function buildRewriteInstruction(presetKey, customDirection) {
  const base = presetKey ? REWRITE_DIRECTIONS[presetKey] : null;
  const custom = (customDirection || "").trim();
  if (base && custom) return `${base} Additional direction: ${custom}`;
  if (base) return base;
  if (custom) {
    return `Rewrite the selected text per this direction: ${custom}. Preserve the original meaning unless the direction explicitly changes it.`;
  }
  return REWRITE_DIRECTIONS.neutral;
}

async function notify(title, message, ok = true) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: ok ? "icons/icon-128.png" : "icons/icon-128-disabled.png",
      title,
      message,
      priority: 1,
    });
  } catch {
    // Notifications are best-effort.
  }
}

// Single write path. Decides fill vs rewrite from `state.original` and
// in-place vs clipboard from `state.hasField`. The captured range on
// state lets fillFocusedField replace exactly that span.
//   state:  { ok, frameId, hasField, original }
//   choice: { intent, presetKey }
async function runWrite(tabId, state, choice) {
  const frameId = state.frameId;
  await showFillSpinner(tabId, frameId);
  try {
    let payload;
    const isRewrite = Boolean(state.original);
    if (isRewrite) {
      const instruction = buildRewriteInstruction(choice.presetKey, choice.intent);
      payload = await withSelectedAgent({
        action: "rewrite_clipboard",
        instruction,
        text: state.original.trim(),
      });
    } else {
      const ctx = await getFillContext(tabId, frameId, "");
      if (!ctx?.has_target) {
        await notify("No focused field", "Click into an input/textarea first.", false);
        return;
      }
      const intent = (choice.intent || "").trim();
      payload = await withSelectedAgent({
        action: "fill",
        instruction: intent ? buildCustomIntentFillPrompt(intent) : AUTO_FILL_PROMPT,
        url: ctx.url,
        title: ctx.title,
        text: ctx.text,
        page_context: ctx.page_context,
      });
    }

    const apiRes = await postJson(extensionTurnUrl(currentConfig), payload);
    await applyAgentIconHintFromBody(apiRes?.body);
    if (!apiRes?.ok) {
      await notify(isRewrite ? "Rewrite failed" : "Fill failed", apiRes?.body?.error ?? `HTTP ${apiRes?.status ?? "?"}`, false);
      return;
    }

    const out = String(apiRes.body?.assistant ?? "").trim();
    if (!out) {
      await notify("Empty response", "The agent returned no content.", false);
      return;
    }

    if (state.hasField) {
      const applied = await fillFocusedField(tabId, frameId, out);
      if (applied?.ok) {
        await notify(
          isRewrite ? "Selection rewritten" : "Field filled",
          isRewrite ? "Replaced the selected text in place." : "The focused field was filled.",
        );
      } else {
        // Field went away between capture and write — fall back to
        // clipboard so the result isn't lost.
        const copied = await copyTextToClipboard(tabId, out);
        await notify(
          copied ? "Field gone, copied instead" : "Generated but couldn't apply",
          copied
            ? "Couldn't write back to the field, so the result is on your clipboard."
            : `Couldn't insert or copy: ${applied?.reason ?? "unknown"}`,
          copied,
        );
      }
    } else {
      const copied = await copyTextToClipboard(tabId, out);
      await notify(
        copied ? "Rewritten text copied" : "Rewrite complete",
        copied ? "The rewritten result is on your clipboard." : "Clipboard write failed, but the rewrite was generated.",
        copied,
      );
    }
  } finally {
    await hideFillSpinner(tabId, frameId);
    if (state.hasField) await clearFillTarget(tabId, frameId);
  }
}

// Centered floating menu — single textarea + optional preset chips +
// the captured selection preview. Replaces the old per-action button
// list and the separate custom-intent modal: presets are baked intents
// applied as ${preset} ${user text}. Resolves to:
//   { intent: string, presetKey: string|null } or null on cancel.
// Right-click is hijacked on many editors (Outlook PWA, custom rich
// editors), so this lives in a high-z-index overlay inside the page.
async function promptForAction(tabId, frameId, state) {
  const presets = state.original ? REWRITE_PRESETS : [];
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: typeof frameId === "number" ? { tabId, frameIds: [frameId] } : { tabId },
    args: [{ state, presets }],
    func: ({ state, presets }) => new Promise((resolve) => {
      document.getElementById("jarela-action-menu")?.remove();

      const backdrop = document.createElement("div");
      backdrop.id = "jarela-action-menu";
      backdrop.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483647",
        "background:rgba(15,23,42,0.55)",
        "display:flex", "align-items:center", "justify-content:center",
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
        "animation:jarela-menu-fade 120ms ease-out",
      ].join(";");

      const style = document.createElement("style");
      style.textContent = `
        @keyframes jarela-menu-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes jarela-menu-pop { from { opacity: 0; transform: translateY(8px) scale(0.98) } to { opacity: 1; transform: none } }
      `;
      backdrop.appendChild(style);

      const dialog = document.createElement("div");
      dialog.style.cssText = [
        "background:#fff", "color:#0f172a",
        "border-radius:14px", "padding:18px",
        "width:min(480px,92vw)",
        "max-height:80vh", "overflow:auto",
        "box-shadow:0 24px 60px rgba(15,23,42,0.35), 0 2px 6px rgba(15,23,42,0.12)",
        "display:flex", "flex-direction:column", "gap:12px",
        "animation:jarela-menu-pop 140ms ease-out",
      ].join(";");

      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;gap:10px;";
      const dot = document.createElement("div");
      dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#4f46e5;flex:0 0 auto;";
      const heading = document.createElement("div");
      heading.textContent = "Jarela";
      heading.style.cssText = "font-size:13px;font-weight:600;color:#475569;letter-spacing:0.02em;text-transform:uppercase;";
      header.appendChild(dot);
      header.appendChild(heading);

      const subheading = document.createElement("div");
      subheading.style.cssText = "font-size:13px;color:#475569;line-height:1.45;";
      if (state.original && state.hasField) {
        subheading.textContent = "Rewrite the selected text in place. Pick a preset, type a direction, or both.";
      } else if (state.original) {
        subheading.textContent = "Rewrite the selected text to your clipboard. Pick a preset, type a direction, or both.";
      } else {
        subheading.textContent = "Fill the focused field. Leave the box empty for auto, or describe what to say.";
      }

      const previewWrap = document.createElement("div");
      if (state.original) {
        const previewText = state.original.length > 240 ? `${state.original.slice(0, 240)}…` : state.original;
        previewWrap.textContent = `"${previewText}"`;
        previewWrap.style.cssText = "font-size:12px;color:#475569;background:#f1f5f9;padding:8px 10px;border-radius:8px;line-height:1.4;font-style:italic;white-space:pre-wrap;max-height:120px;overflow:auto;";
      }

      // Preset chips (rewrite only). Clicking toggles selection; the
      // selected preset is combined with whatever the user types.
      const chipsWrap = document.createElement("div");
      chipsWrap.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
      let selectedPreset = null;
      const chipBtns = [];
      function paintChips() {
        for (const b of chipBtns) {
          const isSel = b.dataset.key === selectedPreset;
          b.style.background = isSel ? "#4f46e5" : "#fff";
          b.style.color = isSel ? "#fff" : "#0f172a";
          b.style.borderColor = isSel ? "#4f46e5" : "#e2e8f0";
        }
      }
      for (const p of presets) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.key = p.key;
        chip.textContent = p.label;
        chip.style.cssText = [
          "padding:6px 10px", "font-size:12px", "border-radius:999px",
          "border:1px solid #e2e8f0", "background:#fff", "color:#0f172a",
          "cursor:pointer", "font-family:inherit",
          "transition:background 80ms, border-color 80ms, color 80ms",
        ].join(";");
        chip.addEventListener("click", () => {
          selectedPreset = selectedPreset === p.key ? null : p.key;
          paintChips();
          textarea.focus();
        });
        chipBtns.push(chip);
        chipsWrap.appendChild(chip);
      }

      const customWrap = document.createElement("div");
      customWrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
      const customToggle = document.createElement("button");
      customToggle.type = "button";
      customToggle.style.cssText = [
        "align-self:flex-start", "background:transparent", "border:none",
        "padding:0", "cursor:pointer", "color:#4f46e5",
        "font-size:12px", "font-weight:600", "font-family:inherit",
        "display:flex", "align-items:center", "gap:4px",
      ].join(";");
      const customCaret = document.createElement("span");
      customCaret.textContent = "▸";
      customCaret.style.cssText = "display:inline-block;transition:transform 120ms;";
      const customLabel = document.createElement("span");
      customLabel.textContent = state.original ? "Custom direction" : "Add custom direction (optional)";
      customToggle.appendChild(customCaret);
      customToggle.appendChild(customLabel);

      const textarea = document.createElement("textarea");
      textarea.rows = 4;
      textarea.placeholder = state.original
        ? "e.g. translate to swedish, keep under 280 chars, rewrite as a bulleted list"
        : "e.g. accept the meeting, ask for a Monday slot instead";
      textarea.style.cssText = [
        "width:100%", "box-sizing:border-box",
        "padding:10px 12px", "font-size:14px", "line-height:1.45",
        "border:1px solid #cbd5e1", "border-radius:8px",
        "resize:vertical", "min-height:80px",
        "font-family:inherit", "color:#0f172a", "background:#fff",
        "outline:none", "display:none",
      ].join(";");

      let customOpen = false;
      function setCustomOpen(open) {
        customOpen = open;
        textarea.style.display = open ? "block" : "none";
        customCaret.style.transform = open ? "rotate(90deg)" : "none";
        if (open) setTimeout(() => textarea.focus(), 0);
      }
      customToggle.addEventListener("click", () => setCustomOpen(!customOpen));

      customWrap.appendChild(customToggle);
      customWrap.appendChild(textarea);

      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;";
      const hint = document.createElement("div");
      hint.textContent = "Esc cancels · Enter submits · Shift+Enter for newline";
      hint.style.cssText = "font-size:11px;color:#94a3b8;";
      const actions = document.createElement("div");
      actions.style.cssText = "display:flex;gap:8px;";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText = "padding:8px 14px;font-size:13px;border-radius:8px;border:1px solid #cbd5e1;background:#fff;color:#0f172a;cursor:pointer;font-family:inherit;";
      const submit = document.createElement("button");
      submit.type = "button";
      submit.textContent = state.hasField ? "Apply" : "Rewrite & copy";
      submit.style.cssText = "padding:8px 14px;font-size:13px;border-radius:8px;border:1px solid #4f46e5;background:#4f46e5;color:#fff;cursor:pointer;font-weight:600;font-family:inherit;";
      actions.appendChild(cancel);
      actions.appendChild(submit);
      footer.appendChild(hint);
      footer.appendChild(actions);

      function cleanup(value) {
        backdrop.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      }
      function submitNow() {
        cleanup({ intent: textarea.value.trim(), presetKey: selectedPreset });
      }
      function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); cleanup(null); return; }
        // Plain Enter submits from anywhere inside the dialog. Shift+Enter
        // keeps its native newline behaviour inside the textarea so users
        // can still write multi-line custom directions.
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
          e.stopPropagation();
          e.preventDefault();
          submitNow();
        }
      }
      cancel.addEventListener("click", () => cleanup(null));
      submit.addEventListener("click", submitNow);
      backdrop.addEventListener("click", (e) => { if (e.target === backdrop) cleanup(null); });
      document.addEventListener("keydown", onKey, true);

      dialog.appendChild(header);
      dialog.appendChild(subheading);
      if (state.original) dialog.appendChild(previewWrap);
      if (presets.length) dialog.appendChild(chipsWrap);
      dialog.appendChild(customWrap);
      dialog.appendChild(footer);
      backdrop.appendChild(dialog);
      document.documentElement.appendChild(backdrop);

      paintChips();
      // Both paths default collapsed: the dialog stays compact and the
      // submit button is the focused affordance, so plain Enter fires the
      // fast path (auto-fill or preset rewrite) without the user having
      // to click anywhere. Click the toggle to expand for a custom
      // direction.
      setCustomOpen(false);
      submit.focus();
    }),
  });
  return result ?? null;
}

// FIFO queue for write turns. Server-side `enqueueThreadRun` already
// serialises by thread, but two overlapping client runs would still
// trample each other's spinner element + `[data-jarela-fill-target]`
// markers. This keeps every spinner-visible-to-spinner-cleared cycle
// non-overlapping so the user always sees one fill in progress at a
// time. Capture and the dialog stay synchronous to the user gesture —
// only the network + DOM-write phase queues.
let writeQueue = Promise.resolve();
function enqueueWrite(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

// Unified entry point used by both context menu and Alt+J. Captures
// state (field + selection) in one pass, opens the menu, dispatches to
// the single write path.
async function openActionMenu(tabId) {
  const state = await captureField(tabId);
  if (!state?.ok) {
    await notify("Nothing to act on", "Click into a field or select some text first.", false);
    return;
  }
  const choice = await promptForAction(tabId, state.frameId, state);
  if (!choice) {
    if (state.hasField) await clearFillTarget(tabId, state.frameId);
    return;
  }
  await enqueueWrite(() => runWrite(tabId, state, choice));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId !== MENU_OPEN) return;
  openActionMenu(tab.id).catch((err) => {
    console.warn("[jarela] context menu action failed:", err);
  });
});

// Keyboard shortcut for sites that hijack right-click (Outlook PWA,
// custom editors). Binding declared in manifest.json under "commands";
// users can rebind at chrome://extensions/shortcuts.
chrome.commands?.onCommand.addListener((command, tab) => {
  if (!tab?.id) return;
  if (command !== "fill-focused-field") return;
  openActionMenu(tab.id).catch((err) => {
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
      if (msg.type === "jarela-capture-visible-tab") {
        // Content scripts can't call chrome.tabs.captureVisibleTab themselves
        // (no "tabs"/"<all_urls>" permission). The picker requests a PNG of
        // the currently visible viewport here and crops it to the picked
        // element's bounding rect on its side. devicePixelRatio is read in
        // the content script (the dataURL is at that scale already).
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || tab.id !== _sender?.tab?.id) {
          sendResponse({ ok: false, status: 0, body: { error: "tab mismatch" } });
          return;
        }
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
          sendResponse({ ok: true, status: 200, body: { dataUrl } });
        } catch (err) {
          sendResponse({ ok: false, status: 0, body: { error: String(err?.message ?? err) } });
        }
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

// --------------------------------------------------------------------- //
// Browser-control long-poll loop                                        //
// --------------------------------------------------------------------- //
//
// The Jarela agent enqueues browser commands (navigate, click, fill,
// scroll, screenshot, extract) on the server queue at
// /api/v1/extension/browser/poll. The SW long-polls (~25s) for the next
// command, dispatches it through ./lib/browser-control.mjs into the
// active tab, then POSTs the outcome to /browser/result.
//
// MV3 SWs get killed at ~30s idle. The 1-minute alarm
// (BROWSER_POLL_ALARM_NAME) revives us so the loop self-heals after a
// kill or a network blip.

let browserPollLoopActive = false;

async function pollOnceForCommand() {
  const ctrl = new AbortController();
  // Slightly above POLL_WAIT_MS on the server (25s) so a server-side
  // idle resolve always lands before this client abort fires.
  const t = setTimeout(() => ctrl.abort(), 28_000);
  try {
    const res = await fetch(browserPollUrl(currentConfig), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wait_ms: 25_000 }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.command ?? null;
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function postCommandResult(cmdId, outcome) {
  try {
    await fetch(browserResultUrl(currentConfig), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd_id: cmdId, ...outcome }),
    });
  } catch (err) {
    console.warn("[jarela] failed to POST browser-control result:", err);
  }
}

// chrome.tabs.captureVisibleTab ? base64 dataUrl. We expose it via the
// dependency interface so the dispatcher stays mockable.
function captureVisibleTabDep(windowId, opts) {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(windowId ?? null, { format: opts?.format ?? "png" }, (dataUrl) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message ?? "captureVisibleTab failed"));
        return;
      }
      resolve(dataUrl);
    });
  });
}

// Wait until a navigated tab reports `status === "complete"`. Returns
// even if the timeout elapses so the dispatcher can continue.
function waitTabLoaded(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch { /* */ }
      resolve();
    };
    const listener = (changedId, info) => {
      if (changedId === tabId && info.status === "complete") settle();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(settle, Math.max(1000, timeoutMs ?? 30_000));
  });
}

// Crop a base64 PNG/JPEG to the element bounds reported by the page.
// Runs in the SW via OffscreenCanvas (available in MV3 service workers
// since Chrome 119; manifest already requires >= 120).
async function cropBase64Image(base64Full, bounds, format) {
  const blob = await (await fetch(`data:image/${format};base64,${base64Full}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const dpr = bounds.dpr ?? 1;
  const x = Math.max(0, Math.round(bounds.x * dpr));
  const y = Math.max(0, Math.round(bounds.y * dpr));
  const w = Math.min(bitmap.width - x, Math.round(bounds.width * dpr));
  const h = Math.min(bitmap.height - y, Math.round(bounds.height * dpr));
  if (w <= 0 || h <= 0) throw new Error("element bounds reduced to zero after clipping to viewport");
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
  const cropped = await canvas.convertToBlob({ type: `image/${format}` });
  const buf = await cropped.arrayBuffer();
  // Convert to base64 without exhausting the call stack on large images.
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// chrome.* dependency bundle handed to the pure dispatcher.
const chromeDeps = {
  queryActiveTab: (opts) => chrome.tabs.query(opts),
  updateTab: (opts) => chrome.tabs.update(opts.tabId, { url: opts.url }),
  executeScript: (opts) => chrome.scripting.executeScript(opts),
  captureVisibleTab: captureVisibleTabDep,
  waitTabLoaded,
  cropPngBase64: cropBase64Image,
};

async function browserPollLoop() {
  if (browserPollLoopActive) return;
  browserPollLoopActive = true;
  try {
    while (true) {
      const cmd = await pollOnceForCommand();
      if (!cmd) {
        // Either the server idled out (200 with null) or the request
        // errored. Loop again � pollOnceForCommand has its own timeout
        // so we don't tight-loop on a wedged connection.
        continue;
      }
      let outcome;
      try {
        outcome = await gateAndDispatch(cmd);
      } catch (err) {
        outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      await postCommandResult(cmd.cmd_id, outcome);
    }
  } finally {
    browserPollLoopActive = false;
  }
}

function resumeBrowserPollLoop() {
  if (!lastHealthy) return;
  if (browserPollLoopActive) return;
  void browserPollLoop();
}

// Re-arm the loop whenever the server first becomes reachable.
// (Hook lives inside applyHealthState; this comment kept as a marker so
// future readers don't add a duplicate.)

// 1-minute revival alarm � MV3 kills idle SWs at ~30s, so we ensure the
// loop is back up on the next alarm tick after any kill.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(BROWSER_POLL_ALARM_NAME, { periodInMinutes: 1 });
  resumeBrowserPollLoop();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(BROWSER_POLL_ALARM_NAME, { periodInMinutes: 1 });
  resumeBrowserPollLoop();
});

// ====================================================================== //
// Approval gate + content-script overlay coordination
// ====================================================================== //

// Browser-control commands originate from the agent, not the user, so we
// MUST get an explicit per-origin opt-in before driving the page. The
// gate also injects a status banner content script for the duration of
// each command so the user can never be unsure who is in control.

const APPROVAL_TIMEOUT_MS = 60_000;
const pendingApprovals = new Map(); // requestId -> { resolve, reject, timer }

function newRequestId() {
  return `appr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureOverlayInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["agent-overlay.js"],
    });
  } catch (err) {
    // chrome:// pages, the Web Store, PDF viewer, etc. block scripting.
    // We let dispatchCommand fail with its own error in that case.
    console.warn("[jarela] could not inject overlay:", err);
  }
}

async function sendOverlay(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, { __jarela: true, ...msg });
  } catch {
    // The tab may have been closed / navigated. Ignore.
  }
}

function requestUserApproval(tabId, host, action) {
  const requestId = newRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pendingApprovals.has(requestId)) {
        pendingApprovals.delete(requestId);
        void sendOverlay(tabId, { type: "agent-overlay:cancel-approval" });
        resolve(undefined); // soft-dismiss → gate rejects without persisting
      }
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(requestId, { resolve, reject, timer, tabId });
    void chrome.tabs
      .sendMessage(tabId, {
        __jarela: true,
        type: "agent-overlay:request-approval",
        requestId,
        host,
        action,
      })
      .catch((err) => {
        clearTimeout(timer);
        pendingApprovals.delete(requestId);
        reject(err);
      });
  });
}

function deriveCommandHost(tab, command) {
  // For navigate commands the user's decision is about the *destination*,
  // not the page they happen to be on right now (often blank / new tab).
  if (command?.type === "navigate" && typeof command.url === "string") {
    try { return new URL(command.url).hostname; } catch { /* fall through */ }
  }
  if (typeof tab?.url === "string") {
    try { return new URL(tab.url).hostname; } catch { /* fall through */ }
  }
  return "";
}

async function gateAndDispatch(cmd) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "no active tab" };
  const host = deriveCommandHost(tab, cmd);
  if (!host) {
    return {
      ok: false,
      error: "cannot determine target origin for approval (chrome:// or empty tab)",
    };
  }

  await ensureOverlayInjected(tab.id);

  const gate = await gateCommand({
    storage: chrome.storage.local,
    host,
    action: cmd.type,
    prompt: ({ host: h, action }) => requestUserApproval(tab.id, h, action),
  });
  if (!gate.allow) return { ok: false, error: gate.reason };

  await sendOverlay(tab.id, { type: "agent-overlay:show", action: cmd.type });
  try {
    return await dispatchCommand(chromeDeps, cmd);
  } finally {
    await sendOverlay(tab.id, { type: "agent-overlay:hide" });
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.__jarela !== true) return undefined;
  if (msg.type === "agent-overlay:approval-response") {
    const entry = pendingApprovals.get(msg.requestId);
    if (entry) {
      pendingApprovals.delete(msg.requestId);
      clearTimeout(entry.timer);
      entry.resolve(msg.choice);
    }
    return undefined;
  }
  if (msg.type === "agent-overlay:stop-requested") {
    // Best-effort kill switch: remember the active host as denied so any
    // follow-up commands in the queue bounce without prompting again.
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return;
        const host = new URL(tab.url).hostname;
        if (!host) return;
        await setApproval(chrome.storage.local, host, "denied");
      } catch (err) {
        console.warn("[jarela] stop-requested handler failed:", err);
      }
    })();
    return undefined;
  }
  return undefined;
});