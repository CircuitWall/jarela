// Resolves which browser tab the agent should target when running a
// command. Two failure modes the v1 dispatcher hit in production:
//
//   1) When the user focuses the Jarela popup or side panel,
//      chrome.tabs.query({ active: true, currentWindow: true }) returns
//      the popup/panel tab (or no tab at all), so the agent silently
//      retargets the wrong thing.
//   2) When the user switches browser windows or pops out an SSO flow
//      (BankID, OAuth) into a new window, the "current window" the
//      query resolves to is whichever window has focus right now —
//      which may not be the one the user is talking about.
//
// The fix is two-tiered:
//   - The user can PIN a specific tab in the popup. We then target that
//     tabId for as long as it exists, ignoring focus entirely.
//   - When no pin is set, we walk a fallback ladder that prefers usable
//     http(s) tabs in the last-focused window over chrome:// / blank /
//     extension pages that obviously can't be scripted.
//
// All chrome.* surface is injected as deps so the resolver is pure and
// unit-testable from Node/vitest.

export const STORAGE_KEY = "jarelaPinnedTab";

// URLs we never bother scripting — they either reject executeScript
// outright (chrome://) or have nothing the agent could meaningfully
// drive (new-tab page, blank page, the extension's own panel).
const UNUSABLE_SCHEMES = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:", "view-source:"];

export function isUsableUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const u = new URL(url);
    if (UNUSABLE_SCHEMES.includes(u.protocol)) return false;
    // Treat the new-tab page as unusable even though its scheme might be
    // http(s) in some browsers (it has no meaningful DOM for the agent).
    if (u.href === "about:blank") return false;
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- //
// Pin persistence                                                       //
// --------------------------------------------------------------------- //

export async function getPinnedTab(storage) {
  const raw = await storage.get(STORAGE_KEY);
  const v = raw?.[STORAGE_KEY];
  if (!v || typeof v !== "object") return null;
  if (typeof v.tabId !== "number" || v.tabId <= 0) return null;
  return {
    tabId: v.tabId,
    url: typeof v.url === "string" ? v.url : "",
    title: typeof v.title === "string" ? v.title : "",
    host: typeof v.host === "string" ? v.host : "",
    pinnedAt: typeof v.pinnedAt === "number" ? v.pinnedAt : 0,
  };
}

export async function setPinnedTab(storage, tab) {
  if (!tab || typeof tab.id !== "number") {
    throw new Error("pin: invalid tab");
  }
  const value = {
    tabId: tab.id,
    url: typeof tab.url === "string" ? tab.url : "",
    title: typeof tab.title === "string" ? tab.title : "",
    host: deriveHost(tab.url),
    pinnedAt: Date.now(),
  };
  await storage.set({ [STORAGE_KEY]: value });
  return value;
}

export async function clearPinnedTab(storage) {
  await storage.set({ [STORAGE_KEY]: null });
}

function deriveHost(url) {
  if (typeof url !== "string") return "";
  try { return new URL(url).hostname; } catch { return ""; }
}

// --------------------------------------------------------------------- //
// Fallback ladder                                                       //
// --------------------------------------------------------------------- //

// Score a tab. Higher = better candidate. Negative = unusable.
//   +100 if active
//   +50  if in lastFocusedWindow
//   +20  if http/https (most pages)
//   +1   per minute since lastAccessed is recent (we don't have it, so 0)
//   -∞   if URL is unusable
function scoreTab(tab) {
  if (!tab || !isUsableUrl(tab.url)) return -Infinity;
  let s = 0;
  if (tab.active) s += 100;
  if (tab.lastFocusedWindow) s += 50;
  try {
    const proto = new URL(tab.url).protocol;
    if (proto === "https:" || proto === "http:") s += 20;
  } catch { /* unreachable — isUsableUrl already parsed */ }
  return s;
}

export async function findFallbackTab(deps) {
  // First pass: tabs in the last-focused window. This is the closest
  // thing to "what the user was looking at before they clicked the
  // toolbar icon".
  const lastFocused = await deps.queryTabs({ lastFocusedWindow: true });
  const scored = (lastFocused || [])
    .map((t) => ({ tab: t, score: scoreTab({ ...t, lastFocusedWindow: true }) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  if (scored[0]) return scored[0].tab;

  // Second pass: any usable tab anywhere. Avoids hard-failing when the
  // last-focused window only has chrome:// pages.
  const all = await deps.queryTabs({});
  const anyScored = (all || [])
    .map((t) => ({ tab: t, score: scoreTab(t) }))
    .filter((x) => Number.isFinite(x.score))
    .sort((a, b) => b.score - a.score);
  return anyScored[0]?.tab ?? null;
}

// --------------------------------------------------------------------- //
// Public resolver                                                       //
// --------------------------------------------------------------------- //

/**
 * Resolve the tab the agent should target.
 *
 * Priority:
 *   1. Pinned tab (if the user explicitly pinned one).
 *   2. Last-known foreground tab from the tracker (`deps.getForegroundTab`,
 *      optional). This is what we actually want most of the time — it
 *      survives the popup / side panel / devtools stealing focus.
 *   3. Live `findFallbackTab` query (last-focused window's active
 *      http(s) tab, then any usable tab).
 *
 * @returns {Promise<{tab: object, source: "pinned" | "foreground" | "active" | "fallback"} | {tab: null, source: "none", reason: string}>}
 */
export async function resolveTargetTab(deps) {
  // 1) Pinned tab takes priority, but only if it still exists. We
  // explicitly do NOT require the pinned tab to be active or focused —
  // that's the whole point of pinning.
  const pin = await getPinnedTab(deps.storage);
  if (pin) {
    try {
      const tab = await deps.getTab(pin.tabId);
      if (tab && isUsableUrl(tab.url)) {
        return { tab, source: "pinned" };
      }
      // Pinned tab still open but navigated somewhere unusable
      // (chrome://, blank). Surface this clearly instead of silently
      // retargeting — the user's mental model is "I pinned ratsit.se".
      if (tab) {
        return { tab: null, source: "none", reason: `pinned tab navigated to ${tab.url || "unusable URL"}` };
      }
    } catch {
      // Tab was closed — fall through to clearing the pin + fallback.
    }
    await clearPinnedTab(deps.storage);
  }

  // 2) Last-known foreground tab. The tracker module records every
  // tab activation + window focus change, so this is "the tab the
  // user was actually looking at before they clicked on Jarela".
  // Verify it still exists and is still on a usable URL before
  // trusting the cached id.
  if (typeof deps.getForegroundTab === "function") {
    try {
      const fg = await deps.getForegroundTab();
      if (fg && fg.tabId) {
        const tab = await deps.getTab(fg.tabId);
        if (tab && isUsableUrl(tab.url)) {
          return { tab, source: "foreground" };
        }
      }
    } catch {
      // Tab gone — fall through to live query.
    }
  }

  // 3) Live last-focused-window query. This is the v1 path; we keep
  // it as a safety net for the first run (before any tab event has
  // fired) and for the rare case where the tracker missed an event.
  const fallback = await findFallbackTab(deps);
  if (fallback) {
    const source = fallback.active ? "active" : "fallback";
    return { tab: fallback, source };
  }

  return {
    tab: null,
    source: "none",
    reason: "no usable browser tab found (open an http/https page and retry)",
  };
}
