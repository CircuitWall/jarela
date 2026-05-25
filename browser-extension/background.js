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
  buildBase,
} from "./lib/config.mjs";

const ALARM_NAME = "jarela-health";
const HEALTH_INTERVAL_MIN = 0.25; // 15s
const HEALTH_TIMEOUT_MS = 2000;

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
  const suffix = healthy ? "" : "-disabled";
  await chrome.action.setIcon({
    path: {
      16: `icons/icon-16${suffix}.png`,
      32: `icons/icon-32${suffix}.png`,
      128: `icons/icon-128${suffix}.png`,
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
  void tickHealth();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: HEALTH_INTERVAL_MIN });
  void tickHealth();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void tickHealth();
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
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"],
    });
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
  if (msg?.type !== "jarela-capture") return false;
  (async () => {
    try {
      const res = await fetch(captureUrl(currentConfig), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(msg.payload),
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { error: text }; }
      sendResponse({ ok: res.ok, status: res.status, body: json });
    } catch (err) {
      sendResponse({ ok: false, status: 0, body: { error: String(err) } });
    }
  })();
  return true; // async response
});
