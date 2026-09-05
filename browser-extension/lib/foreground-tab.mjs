// Foreground-tab tracker. Keeps a persistent record of the last
// content tab the user actually interacted with, so the agent can
// target it even after the browser focus moves to the popup, side
// panel, devtools, or another window.
//
// Why this exists: chrome.tabs.query({ active: true, currentWindow:
// true }) and even { lastFocusedWindow: true } are point-in-time
// reads that flip the moment the user clicks the toolbar icon, opens
// the side panel, alt-tabs to Jarela's window, or pops out an OAuth
// dialog. The live query then resolves to the wrong tab and the
// agent fails or — worse — drives the wrong page. We watch the
// chrome.tabs / chrome.windows event stream and remember the most
// recent usable http(s) tab the user actively focused; the resolver
// reads that record back instead of trusting a live query.
//
// All chrome.* surface is injected as deps so the tracker is pure
// and unit-testable from Node/vitest.

import { isUsableUrl } from "./tab-target.mjs";

export const FOREGROUND_STORAGE_KEY = "jarelaForegroundTab";

// --------------------------------------------------------------------- //
// Persistence                                                           //
// --------------------------------------------------------------------- //

export async function getForegroundTab(storage) {
  const raw = await storage.get(FOREGROUND_STORAGE_KEY);
  const v = raw?.[FOREGROUND_STORAGE_KEY];
  if (!v || typeof v !== "object") return null;
  if (typeof v.tabId !== "number" || v.tabId <= 0) return null;
  return {
    tabId: v.tabId,
    windowId: typeof v.windowId === "number" ? v.windowId : 0,
    url: typeof v.url === "string" ? v.url : "",
    title: typeof v.title === "string" ? v.title : "",
    host: typeof v.host === "string" ? v.host : "",
    recordedAt: typeof v.recordedAt === "number" ? v.recordedAt : 0,
  };
}

export async function clearForegroundTab(storage) {
  await storage.set({ [FOREGROUND_STORAGE_KEY]: null });
}

function deriveHost(url) {
  if (typeof url !== "string") return "";
  try { return new URL(url).hostname; } catch { return ""; }
}

// Record a tab as the current foreground, but only if it's a real
// content page. Skips chrome://, the extension's own pages, blank
// tabs, etc. — those would just confuse the resolver.
export async function recordForegroundTab(storage, tab) {
  if (!tab || typeof tab.id !== "number") return false;
  if (!isUsableUrl(tab.url)) return false;
  const value = {
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : 0,
    url: tab.url,
    title: typeof tab.title === "string" ? tab.title : "",
    host: deriveHost(tab.url),
    recordedAt: Date.now(),
  };
  await storage.set({ [FOREGROUND_STORAGE_KEY]: value });
  return true;
}

/**
 * Shape the ambient-surroundings push body (ADR-0082). Metadata only —
 * never page content. Returns null when there is nothing worth reporting,
 * so the caller can skip the request entirely.
 */
export function buildForegroundPushPayload(fg) {
  if (!fg || typeof fg.url !== "string" || !isUsableUrl(fg.url)) return null;
  return {
    url: fg.url,
    title: typeof fg.title === "string" ? fg.title : "",
    host: typeof fg.host === "string" ? fg.host : deriveHost(fg.url),
    ...(typeof fg.tabId === "number" && fg.tabId > 0 ? { tab_id: fg.tabId } : {}),
    ...(typeof fg.recordedAt === "number" && fg.recordedAt > 0 ? { recorded_at: fg.recordedAt } : {}),
  };
}

// --------------------------------------------------------------------- //
// Event handlers — pure functions returning storage writes              //
// --------------------------------------------------------------------- //

/**
 * Called from chrome.tabs.onActivated. Look up the activated tab and
 * record it if it's a usable content page.
 */
export async function handleTabActivated(deps, { tabId }) {
  if (typeof tabId !== "number") return false;
  try {
    const tab = await deps.getTab(tabId);
    return await recordForegroundTab(deps.storage, tab);
  } catch {
    return false;
  }
}

/**
 * Called from chrome.tabs.onUpdated. We only care when an *active*
 * tab finishes loading a new URL — that's the moment the user has
 * navigated the foreground.
 */
export async function handleTabUpdated(deps, tabId, changeInfo, tab) {
  if (!tab || !tab.active) return false;
  if (changeInfo?.status !== "complete" && typeof changeInfo?.url !== "string") return false;
  return await recordForegroundTab(deps.storage, tab);
}

/**
 * Called from chrome.windows.onFocusChanged. When the user switches
 * browser windows we want to capture the active tab in the newly
 * focused window — that's the new foreground.
 */
export async function handleWindowFocused(deps, windowId) {
  if (typeof windowId !== "number") return false;
  if (windowId < 0) return false; // WINDOW_ID_NONE = -1
  try {
    const tabs = await deps.queryTabs({ active: true, windowId });
    const tab = tabs?.[0];
    if (!tab) return false;
    return await recordForegroundTab(deps.storage, tab);
  } catch {
    return false;
  }
}

/**
 * Called at SW startup / install to seed the record from the
 * currently active tab in the last-focused window. Without this, the
 * tracker would only learn about tabs *after* the user next switches.
 */
export async function seedForegroundTab(deps) {
  try {
    const tabs = await deps.queryTabs({ active: true, lastFocusedWindow: true });
    for (const tab of tabs || []) {
      if (await recordForegroundTab(deps.storage, tab)) return true;
    }
    // Fallback: any active tab across windows.
    const all = await deps.queryTabs({ active: true });
    for (const tab of all || []) {
      if (await recordForegroundTab(deps.storage, tab)) return true;
    }
  } catch {
    /* swallow — we'll learn on the next event */
  }
  return false;
}

export async function recordSidePanelCurrentTab(deps) {
  try {
    if (typeof deps.getPinnedTab === "function") {
      const pin = await deps.getPinnedTab();
      if (pin?.tabId) return { recorded: false, reason: "pinned" };
    }
    const queries = [
      { active: true, currentWindow: true },
      { active: true, lastFocusedWindow: true },
    ];
    for (const query of queries) {
      const tabs = await deps.queryTabs(query);
      for (const tab of tabs || []) {
        if (await recordForegroundTab(deps.storage, tab)) {
          return { recorded: true, tabId: tab.id };
        }
      }
    }
  } catch {
    // The side panel is best-effort context. Normal tab activation/window
    // focus events will still keep the foreground tracker fresh.
  }
  return { recorded: false, reason: "no usable current tab" };
}

/**
 * Called from chrome.tabs.onRemoved. If the tracked foreground tab
 * went away, clear the record so the resolver knows to look fresh.
 */
export async function handleTabRemoved(deps, tabId) {
  const fg = await getForegroundTab(deps.storage);
  if (fg && fg.tabId === tabId) {
    await clearForegroundTab(deps.storage);
    return true;
  }
  return false;
}
