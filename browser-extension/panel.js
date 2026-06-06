import { STORAGE_KEY, DEFAULT_CONFIG, parseConfig, appUrl } from "./lib/config.mjs";

const frame = document.getElementById("frame");
const fallback = document.getElementById("fallback");
const link = document.getElementById("open-link");

async function currentAppUrl() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const cfg = parseConfig(stored?.[STORAGE_KEY] ?? DEFAULT_CONFIG);
    return appUrl(cfg);
  } catch {
    return appUrl(DEFAULT_CONFIG);
  }
}

async function render() {
  const url = await currentAppUrl();
  frame.src = url;
  link.href = url;
}

frame.addEventListener("error", () => {
  fallback.style.display = "flex";
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  void render();
});

void render();
