// Popup UI. Product strings come from lib/brand.mjs so a rebranded build
// only regenerates that module.

import { BRAND, applyBrand } from "./lib/brand.mjs";

applyBrand();

function getAgentSelect() {
  return document.getElementById("agent");
}

function currentAgentId() {
  const sel = getAgentSelect();
  const v = String(sel?.value ?? "").trim();
  return v.length > 0 ? v : null;
}

function initials(name) {
  const txt = String(name || "AI").trim();
  if (!txt) return "AI";
  const parts = txt.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function setStatus(text, kind = "") {
  const el = document.getElementById("status");
  el.textContent = text;
  el.className = `status ${kind}`.trim();
}

async function callBackground(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function renderAgentAvatar(agent) {
  const img = document.getElementById("agent-avatar-img");
  const fallback = document.getElementById("agent-avatar-fallback");
  const rawIcon = typeof agent?.icon === "string" ? agent.icon.trim() : "";
  // bundle:* literals are toolbar-icon hints, not real image URLs — they
  // would 404 silently as <img src> and leave the avatar blank. Treat them
  // (and anything else that's clearly not a URL / data URL) as "no icon"
  // so the initials fallback renders.
  const isLoadable =
    rawIcon.length > 0 &&
    !rawIcon.toLowerCase().startsWith("bundle:") &&
    (rawIcon.startsWith("data:") || rawIcon.startsWith("http://") || rawIcon.startsWith("https://") || rawIcon.startsWith("/"));

  function showFallback() {
    img.style.display = "none";
    img.removeAttribute("src");
    fallback.textContent = initials(agent?.name ?? "AI");
    fallback.style.display = "inline";
  }

  if (!isLoadable) {
    showFallback();
    return;
  }

  img.onerror = () => { showFallback(); };
  img.onload = () => {
    img.style.display = "block";
    fallback.style.display = "none";
  };
  img.src = rawIcon;
}

async function loadAgents() {
  const sel = getAgentSelect();
  if (!sel) return;

  sel.innerHTML = "";
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "Loading agents...";
  sel.appendChild(loading);

  const [listRes, savedRes] = await Promise.all([
    callBackground("jarela-list-agents"),
    callBackground("jarela-get-agent"),
  ]);

  if (!listRes?.ok) {
    sel.innerHTML = "";
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No agents available";
    sel.appendChild(opt);
    setStatus(`Could not load agents: ${listRes?.body?.error ?? "unknown error"}`, "err");
    renderAgentAvatar(null);
    return;
  }

  const agents = Array.isArray(listRes?.body?.agents) ? listRes.body.agents : [];
  const savedAgentId = typeof savedRes?.body?.agent_id === "string" ? savedRes.body.agent_id : "";
  const defaultAgentId = typeof listRes?.body?.default_agent_id === "string" ? listRes.body.default_agent_id : "";

  sel.innerHTML = "";
  for (const a of agents) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.is_default ? `${a.name} (default)` : a.name;
    sel.appendChild(opt);
  }

  if (agents.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No agents available";
    sel.appendChild(opt);
    renderAgentAvatar(null);
    return;
  }

  const target = savedAgentId || defaultAgentId || agents[0].id;
  sel.value = agents.some((a) => a.id === target) ? target : agents[0].id;
  renderAgentAvatar(agents.find((a) => a.id === sel.value) ?? agents[0]);
  await callBackground("jarela-set-agent", { agent_id: sel.value });

  sel.addEventListener("change", async () => {
    const picked = agents.find((a) => a.id === currentAgentId()) ?? null;
    renderAgentAvatar(picked);
    await callBackground("jarela-set-agent", { agent_id: currentAgentId() });
  });
}

document.getElementById("pick").addEventListener("click", async () => {
  setStatus("Starting picker…");
  const res = await callBackground("jarela-start-picker");
  if (res?.ok) {
    setStatus("Picker started in active tab.", "ok");
    window.close();
  } else {
    setStatus(`Picker failed: ${res?.body?.error ?? "unknown error"}`, "err");
  }
});

// Pre-fetched window/tab ids so the side-panel click handler can call
// chrome.sidePanel.open() synchronously inside its user gesture.
let cachedWindowId = null;
let cachedTabId = null;

async function primeSidePanelContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId !== undefined) cachedWindowId = tab.windowId;
    if (tab?.id !== undefined) cachedTabId = tab.id;
    if (cachedTabId !== null) {
      try {
        await chrome.sidePanel.setOptions({ tabId: cachedTabId, path: "panel.html", enabled: true });
      } catch {
        // non-fatal; open() will surface a real error if anything is wrong
      }
    }
  } catch {
    // ignore; click handler will report a clear error
  }
}

document.getElementById("open-jarela").addEventListener("click", (event) => {
  // chrome.sidePanel.open() requires a user gesture AND must be invoked
  // synchronously — any await before it loses the gesture. We use the
  // pre-fetched windowId/tabId so no async work runs first.
  setStatus(`Opening ${BRAND.name}…`);
  if (cachedWindowId === null && cachedTabId === null) {
    setStatus(`Could not open ${BRAND.name}: no active window yet, try again.`, "err");
    return;
  }
  let openPromise;
  try {
    const opts = cachedWindowId !== null ? { windowId: cachedWindowId } : { tabId: cachedTabId };
    openPromise = chrome.sidePanel.open(opts);
  } catch (err) {
    setStatus(`Could not open ${BRAND.name}: ${err?.message ?? String(err)}`, "err");
    return;
  }

  Promise.resolve(openPromise)
    .then(() => {
      setStatus(`Opened ${BRAND.name}.`, "ok");
      window.close();
    })
    .catch((err) => {
      setStatus(`Could not open ${BRAND.name}: ${err?.message ?? String(err)}`, "err");
    });
});

void loadAgents();
void primeSidePanelContext();

// --------------------------------------------------------------------- //
// Tab pinning + connection status                                       //
// --------------------------------------------------------------------- //

const TARGET_CARD = {
  dot: () => document.getElementById("target-dot"),
  host: () => document.getElementById("target-host"),
  sub: () => document.getElementById("target-sub"),
  pin: () => document.getElementById("pin-tab"),
  unpin: () => document.getElementById("unpin-tab"),
};

function shortenUrl(url) {
  if (typeof url !== "string" || url.length === 0) return "";
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    return path.length > 42 ? `${path.slice(0, 39)}…` : path;
  } catch {
    return url.length > 42 ? `${url.slice(0, 39)}…` : url;
  }
}

function tabLabel(tab) {
  return tab?.title || tab?.host || shortenUrl(tab?.url) || `Tab ${tab?.tab_id ?? ""}`.trim();
}

function clearTabList(text) {
  const list = document.getElementById("tab-list");
  if (!list) return;
  list.innerHTML = "";
  const row = document.createElement("div");
  row.className = "tab-row unusable";
  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "tab-title";
  title.textContent = text;
  body.appendChild(title);
  row.appendChild(body);
  list.appendChild(row);
}

function renderTabBadges(container, tab) {
  const badges = [];
  if (tab.foreground) badges.push(["current", "hot"]);
  else if (tab.active && tab.focused_window) badges.push(["active", "hot"]);
  if (tab.pinned_target) badges.push(["pinned", "pin"]);
  if (!tab.usable) badges.push(["blocked", ""]);
  for (const [label, cls] of badges) {
    const badge = document.createElement("span");
    badge.className = `tab-badge ${cls}`.trim();
    badge.textContent = label;
    container.appendChild(badge);
  }
}

async function renderTabList() {
  const list = document.getElementById("tab-list");
  if (!list) return;
  const res = await callBackground("jarela-list-tabs");
  if (!res?.ok) {
    clearTabList(`Could not list tabs: ${res?.body?.error ?? "unknown error"}`);
    return;
  }
  const tabs = Array.isArray(res.body?.tabs) ? res.body.tabs : [];
  if (tabs.length === 0) {
    clearTabList("No browser tabs visible to the extension");
    return;
  }
  list.innerHTML = "";
  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = `tab-row ${tab.foreground || (tab.active && tab.focused_window) ? "current" : ""} ${tab.usable ? "" : "unusable"}`.trim();

    const body = document.createElement("div");
    body.className = "tab-body";
    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tabLabel(tab);
    title.title = tab.title || "";
    const meta = document.createElement("div");
    meta.className = "tab-meta";
    meta.textContent = tab.host || shortenUrl(tab.url) || tab.unusable_reason || "metadata unavailable";
    meta.title = tab.url || tab.unusable_reason || "";
    const badges = document.createElement("div");
    badges.className = "tab-badges";
    renderTabBadges(badges, tab);
    body.appendChild(title);
    body.appendChild(meta);
    body.appendChild(badges);

    const buttons = document.createElement("div");
    buttons.className = "tab-buttons";
    const focus = document.createElement("button");
    focus.type = "button";
    focus.textContent = "Focus";
    focus.disabled = !tab.tab_id;
    focus.addEventListener("click", async () => {
      setStatus(`Focusing ${tabLabel(tab)}…`);
      const out = await callBackground("jarela-activate-tab", { tab_id: tab.tab_id });
      if (out?.ok) setStatus("Focused tab.", "ok");
      else setStatus(`Could not focus tab: ${out?.body?.error ?? "unknown error"}`, "err");
      await renderTargetCard();
    });
    const pin = document.createElement("button");
    pin.type = "button";
    pin.textContent = tab.pinned_target ? "Pinned" : "Pin";
    pin.disabled = !tab.usable || tab.pinned_target;
    pin.addEventListener("click", async () => {
      setStatus(`Pinning ${tabLabel(tab)}…`);
      const out = await callBackground("jarela-pin-tab", { tab_id: tab.tab_id });
      if (out?.ok) setStatus(`Pinned ${out.body?.pin?.host ?? "tab"}.`, "ok");
      else setStatus(`Could not pin tab: ${out?.body?.error ?? "unknown error"}`, "err");
      await renderTargetCard();
    });
    buttons.appendChild(focus);
    buttons.appendChild(pin);

    row.appendChild(body);
    row.appendChild(buttons);
    list.appendChild(row);
  }
}

async function renderTargetCard() {
  // We render three independent pieces of state into the same card:
  //   - SW health drives the dot colour (server reachable or not).
  //   - The pinned tab (if any) drives the host/sub text.
  //   - The tracked foreground tab is shown when no pin is set, so
  //     the user can see exactly which tab the agent will drive
  //     without having to pin anything first.
  const [pinRes, statusRes, fgRes] = await Promise.all([
    callBackground("jarela-get-pinned-tab"),
    callBackground("jarela-get-status"),
    callBackground("jarela-get-foreground-tab"),
  ]);
  const pin = pinRes?.body?.pin ?? null;
  const fg = fgRes?.body?.foreground ?? null;
  const healthy = statusRes?.body?.healthy === true;

  const dot = TARGET_CARD.dot();
  dot.className = `target-dot ${healthy ? "ok" : "err"}`;
  dot.title = healthy ? `Connected to ${BRAND.name}` : `Not connected to ${BRAND.name}`;

  if (pin) {
    TARGET_CARD.host().textContent = `🎯 ${pin.host || "(unknown host)"}`;
    TARGET_CARD.sub().textContent = pin.title || shortenUrl(pin.url) || "Pinned tab";
    TARGET_CARD.unpin().hidden = false;
    // Let the user swap the pin in one click instead of unpin → switch → pin.
    // If the active foreground tab is a different scriptable tab, expose
    // "Pin this tab instead"; the backend just overwrites the stored pin.
    const canSwap = fg && fg.tabId && fg.tabId !== pin.tabId;
    TARGET_CARD.pin().hidden = !canSwap;
    TARGET_CARD.pin().textContent = canSwap ? "Pin this tab instead" : "Pin this tab";
  } else if (fg) {
    TARGET_CARD.host().textContent = `👁️ ${fg.host || "(unknown host)"}`;
    TARGET_CARD.sub().textContent = fg.title || shortenUrl(fg.url) || "Foreground tab";
    TARGET_CARD.pin().hidden = false;
    TARGET_CARD.pin().textContent = "Pin this tab";
    TARGET_CARD.unpin().hidden = true;
  } else {
    TARGET_CARD.host().textContent = "No active tab";
    TARGET_CARD.sub().textContent = healthy
      ? "Open an http/https page to start"
      : `${BRAND.name} server not reachable`;
    TARGET_CARD.pin().hidden = false;
    TARGET_CARD.pin().textContent = "Pin this tab";
    TARGET_CARD.unpin().hidden = true;
  }
  await renderTabList();
}

document.getElementById("pin-tab").addEventListener("click", async () => {
  setStatus("Pinning current tab…");
  const prev = await callBackground("jarela-get-pinned-tab");
  const hadPin = !!prev?.body?.pin;
  const res = await callBackground("jarela-pin-current-tab");
  if (res?.ok) {
    const host = res.body?.pin?.host ?? "tab";
    setStatus(hadPin ? `Pinned ${host}. Previous pin released.` : `Pinned ${host}.`, "ok");
    await renderTargetCard();
  } else {
    setStatus(`Could not pin tab: ${res?.body?.error ?? "unknown error"}`, "err");
  }
});

document.getElementById("unpin-tab").addEventListener("click", async () => {
  const res = await callBackground("jarela-unpin-tab");
  if (res?.ok) {
    setStatus("Unpinned.", "ok");
    await renderTargetCard();
  } else {
    setStatus(`Could not unpin: ${res?.body?.error ?? "unknown error"}`, "err");
  }
});

// Keep the card live if the pin changes from outside this popup (e.g.
// the SW auto-cleared it when the tab was closed while the popup was
// open).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    Object.prototype.hasOwnProperty.call(changes, "jarelaPinnedTab") ||
    Object.prototype.hasOwnProperty.call(changes, "jarelaForegroundTab")
  ) {
    void renderTargetCard();
  }
});

void renderTargetCard();
