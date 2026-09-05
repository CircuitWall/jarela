import { STORAGE_KEY, SELECTED_AGENT_STORAGE_KEY, DEFAULT_CONFIG, parseConfig, appUrl } from "./lib/config.mjs";
import { applyBrand } from "./lib/brand.mjs";

applyBrand();

const frame = document.getElementById("frame");
const fallback = document.getElementById("fallback");
const link = document.getElementById("open-link");

async function currentAppUrl() {
  try {
    const stored = await chrome.storage.local.get([STORAGE_KEY, SELECTED_AGENT_STORAGE_KEY]);
    const cfg = parseConfig(stored?.[STORAGE_KEY] ?? DEFAULT_CONFIG);
    const agentId = stored?.[SELECTED_AGENT_STORAGE_KEY];
    return appUrl(cfg, { agentId: typeof agentId === "string" ? agentId : null });
  } catch {
    return appUrl(DEFAULT_CONFIG);
  }
}

async function render() {
  try {
    await chrome.runtime.sendMessage({ type: "jarela-sidepanel-adopt-current-tab" });
  } catch {
    // Best-effort: the normal foreground tracker still updates on tab/window events.
  }
  const url = await currentAppUrl();
  frame.src = url;
  link.href = url;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void render();
});

frame.addEventListener("error", () => {
  fallback.style.display = "flex";
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes[STORAGE_KEY] && !changes[SELECTED_AGENT_STORAGE_KEY]) return;
  void render();
});

// A port whose lifetime IS the panel's lifetime. The service worker uses it
// to decide whether ambient surroundings may be pushed to the app; when the
// panel closes the port disconnects and the push stops. Nothing is ever sent
// over it — only connect/disconnect matter.
chrome.runtime.connect({ name: "jarela-sidepanel" });

void render();
